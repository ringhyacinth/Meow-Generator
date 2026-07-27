import * as THREE from 'three';
import { createRng } from './rng.js';
import { COATS, EYE_COLORS } from './coats.js';
import {
  sphere,
  roundedBox,
  roundCone,
  meshFromSDF,
  nearestPrim,
  evalField,
} from './sdf.js';
import { injectPoke } from './softPoke.js';
import { injectBodyHatch } from './hatch.js';
import {
  createStaticIdleState,
  injectStaticIdle,
  updateStaticIdle,
} from './staticIdle.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const BUTT_DECAL_POSES = new Set(['standing', 'stretch']);
const CAT_MESH_REFERENCE_VOLUME = 2.8;

export const CAT_MESH_QUALITY = Object.freeze({
  staticCell: 0.032,
  motionCell: 0.019,
  draftCell: 0.046,
  staticMaxVolumeScale: 1.12,
  motionMaxVolumeScale: 1.25,
  draftMaxVolumeScale: 1.24,
});

export const EYE_SPACING_RANGE = Object.freeze({
  min: 0.55,
  max: 1,
  default: 1,
});

export function resolveEyeHorizontalOffset(headRadius, eyeSpacing = EYE_SPACING_RANGE.default) {
  const spacing = Number.isFinite(eyeSpacing)
    ? THREE.MathUtils.clamp(eyeSpacing, EYE_SPACING_RANGE.min, EYE_SPACING_RANGE.max)
    : EYE_SPACING_RANGE.default;
  return headRadius * 0.52 * spacing;
}

export function resolveCatMeshCellSize(
  quality = 'full',
  boundsVolume = CAT_MESH_REFERENCE_VOLUME,
  needsMotionRig = false
) {
  const isDraft = quality === 'draft';
  const baseCell = isDraft
    ? CAT_MESH_QUALITY.draftCell
    : needsMotionRig
      ? CAT_MESH_QUALITY.motionCell
      : CAT_MESH_QUALITY.staticCell;
  const maxVolumeScale = isDraft
    ? CAT_MESH_QUALITY.draftMaxVolumeScale
    : needsMotionRig
      ? CAT_MESH_QUALITY.motionMaxVolumeScale
      : CAT_MESH_QUALITY.staticMaxVolumeScale;
  const safeVolume = Math.max(Number(boundsVolume) || CAT_MESH_REFERENCE_VOLUME, 0.001);
  const volumeScale = Math.max(
    1,
    Math.cbrt(safeVolume / CAT_MESH_REFERENCE_VOLUME)
  );
  return baseCell * Math.min(volumeScale, maxVolumeScale);
}

// 猫窝不是同一个开口换皮：窄口猫窝要收腹、浅盆要摊开，
// 方盒则要把软体轮廓向四角延伸。所有数值只影响“随机猫窝”姿势。
const CONTAINER_POSE_PROFILES = {
  cardboard: {
    width: 0.98, depth: 0.92, bodyLift: 0.08, centerZ: -0.1,
    headLift: 0.01, headZ: 0.01, pawSpread: 1.06, pawForward: 0.02,
    softWidth: 1.1, softDepth: 1.08, softShape: 'rect',
  },
  flowerpot: {
    width: 0.88, depth: 0.84, bodyLift: 0.11, centerZ: -0.13,
    headLift: 0.04, headZ: -0.01, pawSpread: 0.9, pawForward: -0.02,
    softWidth: 0.92, softDepth: 0.88, softShape: 'round',
  },
  basket: {
    width: 0.94, depth: 0.9, bodyLift: 0.09, centerZ: -0.12,
    headLift: 0.02, headZ: 0, pawSpread: 0.97, pawForward: 0,
    softWidth: 1, softDepth: 0.96, softShape: 'round',
  },
  basin: {
    width: 1.06, depth: 1.01, bodyLift: 0.07, centerZ: -0.07,
    headLift: -0.01, headZ: 0.02, pawSpread: 1.1, pawForward: 0.03,
    softWidth: 1.14, softDepth: 1.06, softShape: 'round',
  },
  bucket: {
    width: 0.87, depth: 0.84, bodyLift: 0.12, centerZ: -0.14,
    headLift: 0.05, headZ: -0.02, pawSpread: 0.88, pawForward: -0.03,
    softWidth: 0.9, softDepth: 0.86, softShape: 'round',
  },
  storage: {
    width: 1, depth: 0.94, bodyLift: 0.08, centerZ: -0.1,
    headLift: 0.01, headZ: 0.01, pawSpread: 1.08, pawForward: 0.02,
    softWidth: 1.12, softDepth: 1.1, softShape: 'rect',
  },
};

const DEFAULT_CONTAINER_POSE_PROFILE = CONTAINER_POSE_PROFILES.basket;

// 二次元硬二分色阶：亮面 / 暗面两档，NearestFilter 保证边界干脆
let _gradientMap = null;
function toonGradientMap() {
  if (!_gradientMap) {
    // 暗阶只做很轻的底衬，主要的暗面颜色由 hatch.js 的 uShadeColor/uShadeAlpha 控制（可调）
    const data = new Uint8Array([232, 255]);
    _gradientMap = new THREE.DataTexture(data, 2, 1, THREE.RedFormat);
    _gradientMap.minFilter = THREE.NearestFilter;
    _gradientMap.magFilter = THREE.NearestFilter;
    _gradientMap.needsUpdate = true;
  }
  return _gradientMap;
}

// 反向外壳描边：顶点沿法线外扩、背面渲染。
// jitter 用多频正弦噪声扰动外扩厚度，模仿手绘线的粗细呼吸感。
function makeOutline(
  geo,
  thickness = 0.011,
  color = '#4a3428',
  jitter = 0,
  staticIdleState = null
) {
  // The outline only needs the surface plus attributes that actually deform
  // it. Cloning the whole fur geometry copied all dynamic-coat buffers (and,
  // before this optimization, every rig buffer) a second time on each rebuild.
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', geo.getAttribute('position').clone());
  og.setAttribute('normal', geo.getAttribute('normal').clone());
  if (geo.index) og.setIndex(geo.index.clone());
  for (const name of [
    'idleRegion',
    'idleTailU',
    'rigPart',
    'rigInfluence',
    'rigTailU',
    'rigLegId',
    'rigLegU',
    'rigLegBlend',
    'rigLegCoord',
  ]) {
    const attribute = geo.getAttribute(name);
    if (attribute) og.setAttribute(name, attribute.clone());
  }
  const op = og.getAttribute('position');
  const on = og.getAttribute('normal');
  const rigInfluence = og.getAttribute('rigInfluence');
  const rigLegU = og.getAttribute('rigLegU');
  for (let i = 0; i < op.count; i++) {
    const x = op.getX(i), y = op.getY(i), z = op.getZ(i);
    let t = thickness;
    if (jitter > 0) {
      const n =
        Math.sin(x * 61.7 + y * 43.1) * 0.5 +
        Math.sin(y * 57.3 + z * 39.7) * 0.3 +
        Math.sin(z * 71.9 + x * 33.3) * 0.2;
      t = thickness * (1 + jitter * 1.6 * n);
    }
    if (rigInfluence) {
      const bodyWeight = rigInfluence.getX(i);
      const headWeight = rigInfluence.getY(i);
      const legWeight = rigInfluence.getZ(i);
      const tailWeight = rigInfluence.getW(i);
      const dominance = Math.max(bodyWeight, headWeight, legWeight, tailWeight);
      // The inverted-hull outline can turn inside-out at a heavily blended
      // SDF joint. Thin the shell only in those transition zones; the outer
      // silhouette remains fully outlined.
      const transitionKeep = THREE.MathUtils.clamp(
        (dominance - 0.42) / 0.42,
        0,
        1
      );
      t *= THREE.MathUtils.lerp(0.18, 1, transitionKeep);
      if (legWeight > 0.42 && rigLegU && rigLegU.getX(i) >= 0) {
        const kneeDistance = Math.abs(rigLegU.getX(i) - 0.52);
        const kneeKeep = THREE.MathUtils.clamp((kneeDistance - 0.07) / 0.22, 0, 1);
        t *= THREE.MathUtils.lerp(0.22, 1, kneeKeep);
      }
    }
    op.setXYZ(
      i,
      x + on.getX(i) * t,
      Math.max(y + on.getY(i) * t, 0.002), // 不越过地面，避免贴地露白
      z + on.getZ(i) * t
    );
  }
  op.needsUpdate = true;
  let material = injectPoke(new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  if (staticIdleState) material = injectStaticIdle(material, staticIdleState);
  const mesh = new THREE.Mesh(og, material);
  mesh.name = 'outline';
  return mesh;
}
// 支持反向边界（e0 > e1）的 smoothstep
const sstep = (e0, e1, x) => {
  let t = (x - e0) / (e1 - e0);
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

const DYNAMIC_COAT_MAX_BLOBS = 12;
const DYNAMIC_COAT_PATTERNS = {
  patch: 0,
  tabby: 1,
  tortoiseshell: 2,
};

function dynamicCoatPatternId(pattern) {
  return DYNAMIC_COAT_PATTERNS[pattern] ?? DYNAMIC_COAT_PATTERNS.patch;
}

function textHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dynamicBlobAxes(pattern, tone, rng) {
  if (pattern === 'tabby') {
    return tone < 0.5
      ? new THREE.Vector3(rng.range(1.55, 2.05), rng.range(1.15, 1.55), rng.range(1.25, 1.7))
      : new THREE.Vector3(rng.range(1.45, 1.95), rng.range(0.28, 0.48), rng.range(0.58, 0.82));
  }
  if (pattern === 'patch') {
    return new THREE.Vector3(rng.range(1.05, 1.55), rng.range(0.78, 1.28), rng.range(0.9, 1.42));
  }
  if (pattern === 'points') {
    return new THREE.Vector3(rng.range(0.9, 1.25), rng.range(0.82, 1.18), rng.range(0.9, 1.25));
  }
  return new THREE.Vector3(rng.range(1.45, 1.95), rng.range(1.18, 1.6), rng.range(1.35, 1.8));
}

function dynamicBlobRadius(pattern, tone, rng) {
  if (pattern === 'tabby') return tone < 0.5 ? rng.range(0.3, 0.46) : rng.range(0.19, 0.3);
  if (pattern === 'patch') return rng.range(0.29, 0.48);
  if (pattern === 'points') return rng.range(0.24, 0.4);
  return rng.range(0.36, 0.54);
}

// 参数化花色不依赖固定贴图或 UV：每种花色用自己的配色、色块数量和
// 形状倾向，在片元着色器里按模型表面坐标实时计算。旧顶点花纹只保留为
// 调试对照；参数化模式打开时会完整覆盖它。
function createDynamicCoatState(params, geometry, eligibleIndices, coreIndices, coat, tabbyFrame) {
  const position = geometry.getAttribute('position');
  const bodyStripeEligibility = geometry.getAttribute('coatBodyStripe');
  const headStripeEligibility = geometry.getAttribute('coatHeadStripe');
  const tailStripeCoordinate = geometry.getAttribute('coatTailStripe');
  const undercoatMix = geometry.getAttribute('coatUnderMix');
  const legacyColors = geometry.getAttribute('color').array.slice();
  const preset = coat.soft ?? {
    pattern: 'patch',
    base: coat.base,
    colorA: coat.under ?? coat.base,
    colorB: coat.stripe ?? coat.point ?? coat.patchB ?? coat.base,
  };
  const patternId = dynamicCoatPatternId(preset.pattern);
  const blobRng = createRng((params.seed ^ textHash(coat.id) ^ 0x5f3759df) >>> 0);
  const blobs = [];
  const axes = [];
  const tones = [];
  const candidates = eligibleIndices.length
    ? eligibleIndices
    : Array.from({ length: position.count }, (_, index) => index);
  const coreCandidates = coreIndices.length ? coreIndices : candidates;
  const coreCandidateSet = new Set(coreCandidates);
  const chosen = [];
  const targetA = new THREE.Color(
    coat.kind === 'calico' ? coat.patchA
      : coat.kind === 'tortoiseshell' ? coat.patchA
      : coat.kind === 'tuxedo' ? coat.base
        : coat.kind === 'points' ? coat.point
          : coat.kind === 'solid' ? (coat.under ?? coat.base)
            : coat.base
  );
  const targetB = new THREE.Color(
    coat.kind === 'calico' ? coat.patchB
      : coat.kind === 'tortoiseshell' ? coat.patchB
      : coat.kind === 'tuxedo' ? coat.base
        : coat.kind === 'points' ? coat.point
          : coat.kind === 'solid' ? coat.base
            : (coat.stripe ?? coat.base)
  );
  const toneCandidates = [targetA, targetB].map((target) => {
    const matched = candidates.filter((index) => {
      const offset = index * 3;
      const dr = legacyColors[offset] - target.r;
      const dg = legacyColors[offset + 1] - target.g;
      const db = legacyColors[offset + 2] - target.b;
      return dr * dr + dg * dg + db * db < 0.105;
    });
    return matched.length >= 12 ? matched : coreCandidates;
  });

  for (let i = 0; i < DYNAMIC_COAT_MAX_BLOBS; i++) {
    const tone = i % 2;
    // 默认会显示的前八块优先落在头与躯干，后四块才扩散到耳、腿、尾，
    // 避免低数量时图案只出现在脚尖和尾端。
    const matchedSource = toneCandidates[tone];
    const source = i < 8
      ? matchedSource.filter((index) => coreCandidateSet.has(index))
      : matchedSource;
    const usableSource = source.length ? source : (i < 8 ? coreCandidates : candidates);
    // 用轻量最远点采样让色块尽量散布在整只猫的表面，避免随机中心
    // 全挤在背面或同一条腿上。每轮只抽样一小部分顶点，构建开销稳定。
    let index = usableSource[Math.floor(blobRng.next() * usableSource.length)];
    let bestDistance = -1;
    const attempts = Math.min(220, usableSource.length);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = usableSource[Math.floor(blobRng.next() * usableSource.length)];
      const cx = position.getX(candidate);
      const cy = position.getY(candidate);
      const cz = position.getZ(candidate);
      let nearest = Number.POSITIVE_INFINITY;
      for (const center of chosen) {
        const distance = (cx - center.x) ** 2 + (cy - center.y) ** 2 + (cz - center.z) ** 2;
        nearest = Math.min(nearest, distance);
      }
      if (!chosen.length) nearest = blobRng.next();
      if (nearest > bestDistance) {
        bestDistance = nearest;
        index = candidate;
      }
    }
    const center = new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index));
    chosen.push(center);
    blobs.push(new THREE.Vector4(
      center.x,
      center.y,
      center.z,
      dynamicBlobRadius(preset.pattern, tone, blobRng)
    ));
    axes.push(dynamicBlobAxes(preset.pattern, tone, blobRng));
    tones.push(tone);
  }

  const uniforms = {
    uDynamicCoatEnabled: { value: 0 },
    uDynamicCoatPattern: { value: patternId },
    uDynamicCoatBase: { value: new THREE.Color() },
    uDynamicCoatA: { value: new THREE.Color() },
    uDynamicCoatB: { value: new THREE.Color() },
    uDynamicCoatCount: { value: 7 },
    uDynamicCoatScale: { value: 1 },
    uDynamicCoatSoftness: { value: 0 },
    uDynamicCoatIrregularity: { value: 0.65 },
    uDynamicCoatBodyDensity: { value: preset.body?.density ?? 8.2 },
    uDynamicCoatBodyWidth: { value: preset.body?.width ?? 0.24 },
    uDynamicCoatBodyIrregularity: { value: preset.body?.irregularity ?? 0.42 },
    uDynamicCoatHeadDensity: { value: preset.head?.density ?? 18 },
    uDynamicCoatHeadWidth: { value: preset.head?.width ?? 0.2 },
    uDynamicCoatHeadIrregularity: { value: preset.head?.irregularity ?? 0.28 },
    uDynamicCoatStripeDir: { value: tabbyFrame.stripeDir.clone() },
    uDynamicCoatStripePhase: { value: tabbyFrame.stripePhase },
    uDynamicCoatHeadCenter: { value: tabbyFrame.headCenter.clone() },
    uDynamicCoatHeadRadius: { value: tabbyFrame.headRadius },
    uDynamicCoatBlobs: { value: blobs },
    uDynamicCoatAxes: { value: axes },
    uDynamicCoatTones: { value: tones },
  };

  const apply = (nextParams) => {
    uniforms.uDynamicCoatEnabled.value = nextParams.dynamicCoat ? 1 : 0;
    uniforms.uDynamicCoatBase.value.set(nextParams.dynamicCoatBase ?? preset.base);
    uniforms.uDynamicCoatA.value.set(nextParams.dynamicCoatA ?? preset.colorA);
    uniforms.uDynamicCoatB.value.set(nextParams.dynamicCoatB ?? preset.colorB);
    uniforms.uDynamicCoatCount.value = THREE.MathUtils.clamp(
      Math.round(nextParams.dynamicCoatCount ?? preset.count ?? 7),
      1,
      DYNAMIC_COAT_MAX_BLOBS
    );
    uniforms.uDynamicCoatScale.value = THREE.MathUtils.clamp(nextParams.dynamicCoatScale ?? preset.scale ?? 1, 0.45, 2);
    uniforms.uDynamicCoatSoftness.value = THREE.MathUtils.clamp(nextParams.dynamicCoatSoftness ?? preset.softness ?? 0, 0, 1.4);
    uniforms.uDynamicCoatIrregularity.value = THREE.MathUtils.clamp(nextParams.dynamicCoatIrregularity ?? preset.irregularity ?? 0.65, 0, 1.5);
    uniforms.uDynamicCoatBodyDensity.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatBodyDensity ?? preset.body?.density ?? 8.2,
      0.8,
      32
    );
    uniforms.uDynamicCoatBodyWidth.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatBodyWidth ?? preset.body?.width ?? 0.24,
      0.01,
      1.1
    );
    uniforms.uDynamicCoatBodyIrregularity.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatBodyIrregularity ?? preset.body?.irregularity ?? 0.42,
      0,
      4
    );
    uniforms.uDynamicCoatHeadDensity.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatHeadDensity ?? preset.head?.density ?? 18,
      1,
      64
    );
    uniforms.uDynamicCoatHeadWidth.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatHeadWidth ?? preset.head?.width ?? 0.2,
      0.01,
      1.1
    );
    uniforms.uDynamicCoatHeadIrregularity.value = THREE.MathUtils.clamp(
      nextParams.dynamicCoatHeadIrregularity ?? preset.head?.irregularity ?? 0.28,
      0,
      4
    );
  };

  // GLB 不认识运行时自定义 shader，导出前临时把当前柔斑结果烘焙进
  // 顶点颜色；导出完成立即恢复经典花纹，因此页面里的对比开关不受影响。
  const bake = () => {
    const color = geometry.getAttribute('color');
    const eligible = geometry.getAttribute('coatEligible');
    const base = uniforms.uDynamicCoatBase.value;
    const colorA = uniforms.uDynamicCoatA.value;
    const colorB = uniforms.uDynamicCoatB.value;
    const count = uniforms.uDynamicCoatCount.value;
    const scale = uniforms.uDynamicCoatScale.value;
    const softness = uniforms.uDynamicCoatSoftness.value;
    const irregularity = uniforms.uDynamicCoatIrregularity.value;
    const bodyDensity = uniforms.uDynamicCoatBodyDensity.value;
    const bodyWidth = uniforms.uDynamicCoatBodyWidth.value;
    const bodyIrregularity = uniforms.uDynamicCoatBodyIrregularity.value;
    const headDensity = uniforms.uDynamicCoatHeadDensity.value;
    const headWidth = uniforms.uDynamicCoatHeadWidth.value;
    const headIrregularity = uniforms.uDynamicCoatHeadIrregularity.value;
    const stripeDir = uniforms.uDynamicCoatStripeDir.value;
    const stripePhase = uniforms.uDynamicCoatStripePhase.value;
    const headCenter = uniforms.uDynamicCoatHeadCenter.value;
    const headRadius = uniforms.uDynamicCoatHeadRadius.value;
    const baked = new THREE.Color();

    for (let i = 0; i < position.count; i++) {
      if (eligible.getX(i) < 0.5) continue;
      const px = position.getX(i);
      const py = position.getY(i);
      const pz = position.getZ(i);
      let coatA = 0;
      let coatB = 0;
      const countNorm = THREE.MathUtils.clamp((count - 1) / (DYNAMIC_COAT_MAX_BLOBS - 1), 0, 1);
      const edge = (value, threshold, amount = 1) => {
        if (softness <= 0.001) return value >= threshold ? amount : 0;
        return sstep(threshold - softness * 0.55, threshold + softness * 0.55, value) * amount;
      };

      if (patternId === DYNAMIC_COAT_PATTERNS.tabby) {
        const bodyWarp = (
          Math.sin(px * 13.7 + py * 8.1) * 0.62 +
          Math.sin((px - pz) * 19.3) * 0.38
        ) * bodyIrregularity * 0.52;
        const bodyWave = Math.sin(
          (py * stripeDir.y + pz * stripeDir.z) * bodyDensity * Math.PI * 0.62
          + stripePhase
          + bodyWarp
        );
        const headWarp = (
          Math.sin((py - headCenter.y) * 12.7 + pz * 5.3) * 0.65 +
          Math.sin(px * 17.9 - py * 4.1) * 0.35
        ) * headIrregularity * 0.48;
        const headWave = Math.sin(
          ((px - headCenter.x) / Math.max(headRadius, 0.01)) * headDensity
          + Math.PI / 2
          + headWarp
        );
        const tailWave = Math.sin(
          Math.max(tailStripeCoordinate.getX(i), 0) * bodyDensity * 1.45
          + stripePhase
          + bodyWarp * 0.35
        );
        const bodyStripe = edge(bodyWave, 1 - bodyWidth * 1.7) * bodyStripeEligibility.getX(i);
        const headStripe = edge(headWave, 1 - headWidth * 1.7) * headStripeEligibility.getX(i);
        const tailStripe = tailStripeCoordinate.getX(i) >= 0
          ? edge(tailWave, 1 - bodyWidth * 1.7)
          : 0;
        coatA = undercoatMix.getX(i);
        coatB = Math.max(bodyStripe, headStripe, tailStripe);
      } else if (patternId === DYNAMIC_COAT_PATTERNS.tortoiseshell) {
        // 玳瑁允许整体斑块变大，但始终保留密集碎斑，不退化成三花式大圆块。
        const frequency = (6 + countNorm * 4) / Math.sqrt(Math.max(scale, 0.35));
        const warp =
          Math.sin((px + pz) * frequency * 0.43 + py * 3.7) * irregularity * 0.9;
        const field =
          Math.sin(px * frequency + warp) * 0.58 +
          Math.sin((pz * 0.78 - py * 0.45) * frequency - warp * 0.7) * 0.34 +
          Math.sin((px + pz + py * 0.35) * frequency * 1.83) * 0.2;
        coatA = edge(field, 0.2);
        coatB = edge(-field, 0.38);
      } else {
        for (let ci = 0; ci < count; ci++) {
          const blob = blobs[ci];
          const radius = Math.max(blob.w * scale, 0.02);
          const qx = (px - blob.x) / radius;
          const qy = (py - blob.y) / radius;
          const qz = (pz - blob.z) / radius;
          const axis = axes[ci];
          const d = Math.hypot(qx / axis.x, qy / axis.y, qz / axis.z);
          const phase = ci * 1.731;
          const wobble = (
            Math.sin(qx * 3.1 + qy * 2.3 + phase) * 0.55 +
            Math.sin(qz * 4.7 - qy * 2.9 - phase * 0.7) * 0.3 +
            Math.sin((qx + qz) * 6.2 + phase * 1.3) * 0.15
          ) * irregularity * 0.14;
          const mask = 1 - edge(d + wobble, 1);
          if (tones[ci] < 0.5) coatA = Math.max(coatA, mask);
          else coatB = Math.max(coatB, mask);
        }
      }
      if (patternId === DYNAMIC_COAT_PATTERNS.tabby) {
        baked.copy(colorA).lerp(base, coatA);
        baked.lerp(colorB, coatB);
      } else {
        const coverage = Math.max(coatA, coatB);
        const winner = coatB >= coatA ? colorB : colorA;
        baked.copy(base).lerp(winner, coverage);
      }
      color.setXYZ(i, baked.r, baked.g, baked.b);
    }
    color.needsUpdate = true;
  };
  const restore = () => {
    const color = geometry.getAttribute('color');
    color.array.set(legacyColors);
    color.needsUpdate = true;
  };
  apply(params);
  return {
    uniforms,
    apply,
    prepareExport: () => {
      if (uniforms.uDynamicCoatEnabled.value < 0.5) return null;
      bake();
      return restore;
    },
  };
}

function injectDynamicCoat(material, state) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, state.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float coatEligible;
         attribute float coatBodyStripe;
         attribute float coatHeadStripe;
         attribute float coatTailStripe;
         attribute float coatUnderMix;
         varying float vDynamicCoatEligible;
         varying float vDynamicBodyStripe;
         varying float vDynamicHeadStripe;
         varying float vDynamicTailStripe;
         varying float vDynamicUnderMix;
         varying vec3 vDynamicCoatPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vDynamicCoatEligible = coatEligible;
         vDynamicBodyStripe = coatBodyStripe;
         vDynamicHeadStripe = coatHeadStripe;
         vDynamicTailStripe = coatTailStripe;
         vDynamicUnderMix = coatUnderMix;
         vDynamicCoatPos = transformed;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vDynamicCoatEligible;
         varying float vDynamicBodyStripe;
         varying float vDynamicHeadStripe;
         varying float vDynamicTailStripe;
         varying float vDynamicUnderMix;
         varying vec3 vDynamicCoatPos;
         uniform float uDynamicCoatEnabled;
         uniform int uDynamicCoatPattern;
         uniform vec3 uDynamicCoatBase;
         uniform vec3 uDynamicCoatA;
         uniform vec3 uDynamicCoatB;
         uniform int uDynamicCoatCount;
         uniform float uDynamicCoatScale;
          uniform float uDynamicCoatSoftness;
          uniform float uDynamicCoatIrregularity;
          uniform float uDynamicCoatBodyDensity;
          uniform float uDynamicCoatBodyWidth;
          uniform float uDynamicCoatBodyIrregularity;
          uniform float uDynamicCoatHeadDensity;
          uniform float uDynamicCoatHeadWidth;
          uniform float uDynamicCoatHeadIrregularity;
          uniform vec3 uDynamicCoatStripeDir;
          uniform float uDynamicCoatStripePhase;
          uniform vec3 uDynamicCoatHeadCenter;
          uniform float uDynamicCoatHeadRadius;
          uniform vec4 uDynamicCoatBlobs[${DYNAMIC_COAT_MAX_BLOBS}];
          uniform vec3 uDynamicCoatAxes[${DYNAMIC_COAT_MAX_BLOBS}];
          uniform float uDynamicCoatTones[${DYNAMIC_COAT_MAX_BLOBS}];
          float dynamicCoatEdge(float value, float threshold) {
            if (uDynamicCoatSoftness <= 0.001) return step(threshold, value);
            float feather = uDynamicCoatSoftness * 0.55;
            return smoothstep(threshold - feather, threshold + feather, value);
          }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float coatA = 0.0;
           float coatB = 0.0;
           float countNorm = clamp(
             (float(uDynamicCoatCount) - 1.0) / ${DYNAMIC_COAT_MAX_BLOBS - 1}.0,
             0.0,
             1.0
           );

           if (uDynamicCoatPattern == ${DYNAMIC_COAT_PATTERNS.tabby}) {
             float bodyWarp = (
               sin(vDynamicCoatPos.x * 13.7 + vDynamicCoatPos.y * 8.1) * 0.62 +
               sin((vDynamicCoatPos.x - vDynamicCoatPos.z) * 19.3) * 0.38
             ) * uDynamicCoatBodyIrregularity * 0.52;
             float bodyWave = sin(
               (
                 vDynamicCoatPos.y * uDynamicCoatStripeDir.y +
                 vDynamicCoatPos.z * uDynamicCoatStripeDir.z
               ) * uDynamicCoatBodyDensity * 3.14159265 * 0.62
               + uDynamicCoatStripePhase
               + bodyWarp
             );
             float headWarp = (
               sin((vDynamicCoatPos.y - uDynamicCoatHeadCenter.y) * 12.7 + vDynamicCoatPos.z * 5.3) * 0.65 +
               sin(vDynamicCoatPos.x * 17.9 - vDynamicCoatPos.y * 4.1) * 0.35
             ) * uDynamicCoatHeadIrregularity * 0.48;
             float headWave = sin(
               (
                 (vDynamicCoatPos.x - uDynamicCoatHeadCenter.x) /
                 max(uDynamicCoatHeadRadius, 0.01)
               ) * uDynamicCoatHeadDensity
               + 1.5707963
               + headWarp
             );
             float tailWave = sin(
               max(vDynamicTailStripe, 0.0) * uDynamicCoatBodyDensity * 1.45
               + uDynamicCoatStripePhase
               + bodyWarp * 0.35
             );
             float bodyStripe = dynamicCoatEdge(
               bodyWave,
               1.0 - uDynamicCoatBodyWidth * 1.7
             ) * vDynamicBodyStripe;
             float headStripe = dynamicCoatEdge(
               headWave,
               1.0 - uDynamicCoatHeadWidth * 1.7
             ) * vDynamicHeadStripe;
             float tailStripe = vDynamicTailStripe >= 0.0
               ? dynamicCoatEdge(tailWave, 1.0 - uDynamicCoatBodyWidth * 1.7)
               : 0.0;
             coatA = clamp(vDynamicUnderMix, 0.0, 1.0);
             coatB = max(bodyStripe, max(headStripe, tailStripe));
           } else if (uDynamicCoatPattern == ${DYNAMIC_COAT_PATTERNS.tortoiseshell}) {
             // 玳瑁的随机尺度只改变密度，不允许图案退化成几块巨大的普通色块。
             float frequency = mix(6.0, 10.0, countNorm) / sqrt(max(uDynamicCoatScale, 0.35));
             float warp =
               sin((vDynamicCoatPos.x + vDynamicCoatPos.z) * frequency * 0.43 + vDynamicCoatPos.y * 3.7)
               * uDynamicCoatIrregularity * 0.9;
             float field =
               sin(vDynamicCoatPos.x * frequency + warp) * 0.58 +
               sin((vDynamicCoatPos.z * 0.78 - vDynamicCoatPos.y * 0.45) * frequency - warp * 0.7) * 0.34 +
               sin((vDynamicCoatPos.x + vDynamicCoatPos.z + vDynamicCoatPos.y * 0.35) * frequency * 1.83) * 0.2;
             coatA = dynamicCoatEdge(field, 0.2);
             coatB = dynamicCoatEdge(-field, 0.38);
           } else {
             for (int ci = 0; ci < ${DYNAMIC_COAT_MAX_BLOBS}; ci++) {
                if (ci >= uDynamicCoatCount) continue;
                vec4 blob = uDynamicCoatBlobs[ci];
                float radius = max(blob.w * uDynamicCoatScale, 0.02);
                vec3 q = (vDynamicCoatPos - blob.xyz) / (radius * uDynamicCoatAxes[ci]);
                float d = length(q);
               float phase = float(ci) * 1.731;
               float wobble = (
                 sin(q.x * 3.1 + q.y * 2.3 + phase) * 0.55 +
                 sin(q.z * 4.7 - q.y * 2.9 - phase * 0.7) * 0.3 +
                 sin((q.x + q.z) * 6.2 + phase * 1.3) * 0.15
               ) * uDynamicCoatIrregularity * 0.14;
               float mask = 1.0 - dynamicCoatEdge(d + wobble, 1.0);
               if (uDynamicCoatTones[ci] < 0.5) coatA = max(coatA, mask);
               else coatB = max(coatB, mask);
             }
           }

           vec3 dynamicCoat;
           if (uDynamicCoatPattern == ${DYNAMIC_COAT_PATTERNS.tabby}) {
             // 狸花：主毛色 + 独立浅腹/口鼻遮罩 + 身体/额头/尾巴三组条纹。
             dynamicCoat = mix(uDynamicCoatA, uDynamicCoatBase, coatA);
             dynamicCoat = mix(dynamicCoat, uDynamicCoatB, coatB);
           } else {
             // 普通色块交叠时只让覆盖更强的一块获胜，不再重复混色制造内部描边。
             float coatCoverage = max(coatA, coatB);
             vec3 coatWinner = mix(uDynamicCoatA, uDynamicCoatB, step(coatA, coatB));
             dynamicCoat = mix(uDynamicCoatBase, coatWinner, coatCoverage);
           }
           float dynamicMix = uDynamicCoatEnabled * clamp(vDynamicCoatEligible, 0.0, 1.0);
           diffuseColor.rgb = mix(diffuseColor.rgb, dynamicCoat, dynamicMix);
         }`
      );
  };
  return material;
}

// 从 origin 沿 dir 用二分法找 SDF 真实表面（平滑融合会把表面推出理想椭球，
// 眼睛等贴脸件必须贴真实表面，否则会被姿势相关的鼓包吞掉）
function surfaceAlong(prims, origin, dir, tMin, tMax) {
  let a = tMin, b = tMax;
  const p = new THREE.Vector3();
  for (let i = 0; i < 26; i++) {
    const m = (a + b) / 2;
    p.copy(origin).addScaledVector(dir, m);
    if (evalField(prims, p.x, p.y, p.z) < 0) a = m;
    else b = m;
  }
  return origin.clone().addScaledVector(dir, (a + b) / 2);
}

function surfaceNormal(prims, point, eps = 0.003) {
  const gx = evalField(prims, point.x + eps, point.y, point.z) - evalField(prims, point.x - eps, point.y, point.z);
  const gy = evalField(prims, point.x, point.y + eps, point.z) - evalField(prims, point.x, point.y - eps, point.z);
  const gz = evalField(prims, point.x, point.y, point.z + eps) - evalField(prims, point.x, point.y, point.z - eps);
  return V(gx, gy, gz).normalize();
}

function wateryContour(radius, amount, innerSide, phase = 0) {
  const points = [];
  const count = 160;
  const a = THREE.MathUtils.clamp(amount, 0, 2);
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const cx = Math.cos(theta);
    const cy = Math.sin(theta);
    const lower = Math.max(0, -cy);
    const inner = Math.max(0, cx * innerSide);
    const wobble = a * (
      Math.sin(theta * 2 + innerSide * 0.8 + phase * 0.42) * 0.065 +
      Math.sin(theta * 3 - innerSide * 0.55 + phase) * 0.055 +
      Math.sin(theta * 5 + innerSide * 0.35 - phase * 0.72) * 0.036 +
      Math.sin(theta * 7 - phase * 1.18) * 0.022 +
      Math.sin(theta * 11 + innerSide * 0.9 + phase * 0.28) * 0.012
    );
    const radial = 1 + wobble - a * inner * lower * 0.09;
    const taper = 1 - a * lower * 0.1;
    const lowerPull = a * Math.pow(lower, 1.72) * 0.31;
    const sideAsymmetry = a * Math.sin(theta * 2 + innerSide * 0.9 + phase * 0.55) * 0.032;
    points.push(V(
      radius * (cx * radial * taper + innerSide * lower * a * 0.025),
      radius * (cy * radial - lowerPull + sideAsymmetry),
      0
    ));
  }
  return points;
}

function traceContour(ctx, contour, yOffset = 0, yScale = 1) {
  ctx.beginPath();
  ctx.moveTo(contour[0].x, -contour[0].y * yScale + yOffset);
  for (let i = 1; i < contour.length; i++) {
    ctx.lineTo(contour[i].x, -contour[i].y * yScale + yOffset);
  }
  ctx.closePath();
}

function createEyeTexture(
  irisColor,
  irisRatio,
  wateryAmount,
  innerSide,
  irisHighlightScale = 1
) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;

  const a = THREE.MathUtils.clamp(wateryAmount, 0, 2);
  let staticDrawn = false;
  let lastGazeX = Number.POSITIVE_INFINITY;
  let lastGazeY = Number.POSITIVE_INFINITY;
  const draw = (time = 0, gazeX = 0, gazeY = 0) => {
    const gazeLength = Math.hypot(gazeX, gazeY);
    if (gazeLength > 1) {
      gazeX /= gazeLength;
      gazeY /= gazeLength;
    }
    if (
      a === 0 &&
      staticDrawn &&
      Math.abs(gazeX - lastGazeX) < 0.004 &&
      Math.abs(gazeY - lastGazeY) < 0.004
    ) return;
    lastGazeX = gazeX;
    lastGazeY = gazeY;

    const phase = time * 5.8 + innerSide * 0.8;
    const shake = Math.min(a, 1.6) / 1.6;
    const shakeX = Math.sin(time * 8.2 + innerSide) * 7.5 * shake;
    const shakeY = Math.sin(time * 10.4 + innerSide * 1.7) * 5.5 * shake;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(2, 2);
    ctx.translate(128 + shakeX, 128 + shakeY);

    // 外眼也参与泪眼形变，但振幅低于虹膜，保持眼眶的整体稳定感。
    const eyeContour = wateryContour(104, a * 0.42, innerSide, phase * 0.55);
    traceContour(ctx, eyeContour, 0, 1.07);
    ctx.fillStyle = '#fffdf8';
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#4a3428';
    ctx.stroke();

    const irisRadius = 104 * irisRatio;
    const gazeRoom = Math.max(7, (104 - irisRadius) * 0.72);
    ctx.save();
    ctx.translate(gazeX * gazeRoom, -gazeY * gazeRoom * 0.82);
    const contour = wateryContour(irisRadius, a * 0.76, innerSide, phase);
    traceContour(ctx, contour, 4);
    ctx.fillStyle = irisColor;
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#4a3428';
    ctx.stroke();

    // The current artwork is the minimum: the user can make both highlights
    // larger together, but never shrink them into invisible dots.
    const highlightScale = (0.85 + a * 0.055) * THREE.MathUtils.clamp(
      irisHighlightScale,
      1,
      2.4
    );
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(22, -24, 16 * highlightScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-18, 24, 7 * highlightScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();
    texture.needsUpdate = true;
    staticDrawn = true;
  };

  draw(0);
  return { texture, draw };
}

function makeSurfacePatch(prims, headC, centerDir, width, height, depth, segments = 18) {
  const tangentX = V(1, 0, 0).addScaledVector(centerDir, -centerDir.x).normalize();
  const tangentY = centerDir.clone().cross(tangentX).normalize();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y <= segments; y++) {
    const v = y / segments;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const target = headC.clone()
        .addScaledVector(centerDir, depth)
        .addScaledVector(tangentX, (u - 0.5) * width)
        .addScaledVector(tangentY, (v - 0.5) * height);
      const ray = target.sub(headC).normalize();
      const point = surfaceAlong(prims, headC, ray, depth * 0.25, depth * 2.6);
      const normal = surfaceNormal(prims, point);
      point.addScaledVector(normal, 0.0025);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(u, v);
    }
  }

  const stride = segments + 1;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = x + y * stride;
      const b = a + 1;
      const c = a + stride + 1;
      const d = a + stride;
      indices.push(a, b, c, a, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function makeEyeDecal(
  prims,
  headC,
  centerDir,
  eyeR,
  irisColor,
  irisRatio,
  wateryAmount,
  innerSide,
  irisHighlightScale
) {
  const center = surfaceAlong(prims, headC, centerDir, eyeR, eyeR * 8);
  const painter = createEyeTexture(
    irisColor,
    irisRatio,
    wateryAmount,
    innerSide,
    irisHighlightScale
  );
  const geometry = makeSurfacePatch(
    prims,
    headC,
    centerDir,
    eyeR * 2.48,
    eyeR * 2.58,
    center.distanceTo(headC),
    28
  );
  const material = injectPoke(new THREE.MeshBasicMaterial({
    map: painter.texture,
    transparent: true,
    alphaTest: 0.025,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = innerSide < 0 ? 'eyeDecalLeft' : 'eyeDecalRight';
  mesh.renderOrder = 4;
  mesh.userData.eyeAnimator = painter.draw;
  mesh.userData.skipPokeSync = true;
  return mesh;
}

function makeDecalTexture(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  draw(ctx, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function makeSurfaceDecal(geometry, texture, name, renderOrder = 3, alphaTest = 0.025) {
  const material = injectPoke(new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.renderOrder = renderOrder;
  mesh.userData.skipPokeSync = true;
  return mesh;
}

function makeEarSurfacePatch(prims, ear, segments = 14) {
  const side = V(1, 0, 0).addScaledVector(ear.dir, -ear.dir.x).normalize();
  const front = V(0, 0, 1).addScaledVector(ear.dir, -ear.dir.z).normalize();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y <= segments; y++) {
    const v = y / segments;
    const t = THREE.MathUtils.lerp(0.38, 0.93, v);
    const radius = THREE.MathUtils.lerp(ear.r1, ear.r2, t);
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const interior = ear.a.clone()
        .addScaledVector(ear.dir, ear.len * t)
        .addScaledVector(side, (u - 0.5) * radius * 1.08);
      const point = surfaceAlong(prims, interior, front, 0, radius * 2.7 + 0.1);
      const normal = surfaceNormal(prims, point);
      point.addScaledVector(normal, 0.0028);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(u, v);
    }
  }

  const stride = segments + 1;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = x + y * stride;
      const b = a + 1;
      const c = a + stride + 1;
      const d = a + stride;
      indices.push(a, b, c, a, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function makeInnerEarDecal(prims, ear, staticIdleState = null) {
  const texture = makeDecalTexture((ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    const path = new Path2D();
    path.moveTo(128, 26);
    path.quadraticCurveTo(141, 31, 151, 54);
    path.lineTo(221, 202);
    path.quadraticCurveTo(232, 229, 201, 231);
    path.lineTo(55, 231);
    path.quadraticCurveTo(24, 229, 35, 202);
    path.lineTo(105, 54);
    path.quadraticCurveTo(115, 31, 128, 26);
    path.closePath();

    const wash = ctx.createLinearGradient(128, 24, 128, 232);
    wash.addColorStop(0, 'rgba(250, 207, 205, 0.66)');
    wash.addColorStop(0.55, 'rgba(241, 184, 189, 0.58)');
    wash.addColorStop(1, 'rgba(226, 143, 154, 0.42)');

    // 先铺大范围晕染，再补一层低透明主体；保留圆角三角轮廓但不出现硬描边。
    ctx.save();
    ctx.filter = 'blur(14px)';
    ctx.fillStyle = wash;
    ctx.fill(path);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = wash;
    ctx.fill(path);
    ctx.restore();
  });
  const geometry = makeEarSurfacePatch(prims, ear);
  if (staticIdleState) {
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const idleRegion = new Float32Array(position.count * 3);
    const idleTailU = new Float32Array(position.count);
    const component = ear.side < 0 ? 1 : 2;
    for (let index = 0; index < position.count; index++) {
      const v = uv.getY(index);
      const weight = v * v * (3 - 2 * v);
      idleRegion[index * 3 + component] = weight;
    }
    geometry.setAttribute('idleRegion', new THREE.BufferAttribute(idleRegion, 3));
    geometry.setAttribute('idleTailU', new THREE.BufferAttribute(idleTailU, 1));
  }
  const decal = makeSurfaceDecal(
    geometry,
    texture,
    ear.side < 0 ? 'innerEarDecalLeft' : 'innerEarDecalRight',
    3,
    0.004
  );
  if (staticIdleState) {
    decal.material = injectStaticIdle(decal.material, staticIdleState);
  }
  return decal;
}

function makeButtDecal(prims, buttHint, size) {
  const rear = V(0, 0, -1);
  const center = surfaceAlong(prims, buttHint, rear, 0, 3);
  const depth = center.distanceTo(buttHint);
  const geometry = makeSurfacePatch(
    prims,
    buttHint,
    rear,
    size * 2.65,
    size * 2.65,
    depth,
    16
  );
  const texture = makeDecalTexture((ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawX = () => {
      ctx.beginPath();
      ctx.moveTo(64, 66);
      ctx.bezierCurveTo(92, 88, 154, 164, 194, 192);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(194, 66);
      ctx.bezierCurveTo(160, 94, 98, 160, 64, 192);
      ctx.stroke();
    };
    ctx.lineWidth = 34;
    ctx.strokeStyle = '#f1b8bd';
    drawX();
    ctx.lineWidth = 20;
    ctx.strokeStyle = '#4a3428';
    drawX();
  });
  const decal = makeSurfaceDecal(geometry, texture, 'buttDecal', 3);
  decal.userData.surfaceAnchor = center.clone();
  return decal;
}

function applyFluffGeometry(geometry, amount, seed, headC, hr) {
  if (amount <= 0) return;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const phase = (seed % 100000) * 0.017;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const noise =
      Math.sin(x * 47.3 + y * 31.7 + phase) * 0.5 +
      Math.sin(y * 59.1 + z * 43.9 - phase * 0.7) * 0.3 +
      Math.sin((x - z) * 83.7 + phase * 1.3) * 0.2;
    const bristle = Math.pow(THREE.MathUtils.clamp(noise * 0.5 + 0.5, 0, 1), 3);
    const faceDistance = Math.hypot(
      (x - headC.x) / (hr * 0.9),
      (y - headC.y) / (hr * 0.8),
      (z - (headC.z + hr * 0.7)) / (hr * 0.55)
    );
    const faceKeep = sstep(1.15, 0.72, faceDistance);
    const exposure = THREE.MathUtils.clamp(0.45 + ny * 0.35 - nz * 0.12, 0.2, 1);
    const lift = amount * (0.014 + 0.095 * bristle) * exposure * (1 - faceKeep * 0.9);
    position.setXYZ(
      i,
      x + nx * lift,
      Math.max(0.004, y + ny * lift),
      z + nz * lift
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

function createTransientFluffController(furGeometry, outlineGeometry, seed, headC, hr) {
  const furPosition = furGeometry.getAttribute('position');
  const furNormal = furGeometry.getAttribute('normal');
  const outlinePosition = outlineGeometry.getAttribute('position');
  const basePosition = new Float32Array(furPosition.array);
  const baseNormal = new Float32Array(furNormal.array);
  const baseOutlinePosition = new Float32Array(outlinePosition.array);
  const phase = (seed % 100000) * 0.017;
  let currentAmount = 0;

  return (nextAmount = 0) => {
    const amount = Math.max(0, Number(nextAmount) || 0);
    if (Math.abs(amount - currentAmount) < 1e-4) return currentAmount;
    currentAmount = amount;

    for (let i = 0; i < furPosition.count; i++) {
      const offset = i * 3;
      const x = basePosition[offset];
      const y = basePosition[offset + 1];
      const z = basePosition[offset + 2];
      const nx = baseNormal[offset];
      const ny = baseNormal[offset + 1];
      const nz = baseNormal[offset + 2];
      const noise =
        Math.sin(x * 47.3 + y * 31.7 + phase) * 0.5
        + Math.sin(y * 59.1 + z * 43.9 - phase * 0.7) * 0.3
        + Math.sin((x - z) * 83.7 + phase * 1.3) * 0.2;
      const bristle = Math.pow(THREE.MathUtils.clamp(noise * 0.5 + 0.5, 0, 1), 3);
      const faceDistance = Math.hypot(
        (x - headC.x) / (hr * 0.9),
        (y - headC.y) / (hr * 0.8),
        (z - (headC.z + hr * 0.7)) / (hr * 0.55)
      );
      const faceKeep = sstep(1.15, 0.72, faceDistance);
      const exposure = THREE.MathUtils.clamp(0.45 + ny * 0.35 - nz * 0.12, 0.2, 1);
      const lift = amount * (0.014 + 0.095 * bristle) * exposure * (1 - faceKeep * 0.9);
      const dx = nx * lift;
      const dy = ny * lift;
      const dz = nz * lift;

      furPosition.setXYZ(i, x + dx, Math.max(0.004, y + dy), z + dz);
      outlinePosition.setXYZ(
        i,
        baseOutlinePosition[offset] + dx,
        Math.max(0.004, baseOutlinePosition[offset + 1] + dy),
        baseOutlinePosition[offset + 2] + dz
      );
    }

    furPosition.needsUpdate = true;
    outlinePosition.needsUpdate = true;
    furGeometry.computeVertexNormals();
    outlineGeometry.computeVertexNormals();
    return currentAmount;
  };
}

/**
 * v0.3 形态语言：粘土玩具小猫
 * —— 头埋进身体（无脖子）、矮胖水滴身、短粗腿、小圆耳、低位宽距大眼。
 * params: seed, pose, coatId, eyeColor, oddEyes, eyeColorRight,
 *  headSize, chubbiness, legLength, earSize, eyeSize, eyeSpacing,
 *  irisScale, irisHighlightScale,
 *  wateryEyes, wateryEyeShape, tailLength, tailCurl
 * quality: 'draft' | 'full'
 */
export function buildCat(params, quality = 'full') {
  const buildStartedAt = performance.now();
  const rng = createRng(params.seed);
  // Static cats do not need the expensive 19-bone semantic field. Keeping
  // this explicit prevents every random click from paying the animation-rig
  // setup cost while preserving the lightweight tail/ear idle attributes.
  const needsMotionRig = params.motionDebug === true;
  const coat = COATS.find((c) => c.id === params.coatId) ?? COATS[0];
  const legacyEye = EYE_COLORS.find((e) => e.id === params.eyeColorId) ?? EYE_COLORS[0];
  const leftEyeColor = params.eyeColor ?? (legacyEye.color === 'odd' ? '#5b8fd4' : legacyEye.color);
  const rightEyeColor = params.oddEyes
    ? (params.eyeColorRight ?? '#d99a2b')
    : leftEyeColor;

  const chub = params.chubbiness;
  const wid = Math.sqrt(chub);
  const hr = 0.46 * params.headSize; // 头半径（大：婴儿图式）
  const earS = params.earSize;
  const tl = params.tailLength;
  const curl = params.tailCurl;

  const prims = [];
  const P = (p) => (prims.push(p), p);
  let headC, muzzle, gradLow, gradHigh, buttHint;
  let stripeDir = V(0, 0.15, 1);
  const earDef = [];
  let tailRootC = null;
  let tailRigHints = null;
  let rigAnchorHints = null;

  const pose = params.pose;

  function addHead(cx, cy, cz, neckFrom = null, neckR = 0.26, withEars = true) {
    headC = V(cx, cy, cz);
    // 宽扁脸
    P(sphere({ c: headC, r: hr, s: [1.14, 0.9, 0.92], k: 0.13, tag: 'head' }));
    if (neckFrom) {
      P(roundCone({ a: neckFrom, b: headC.clone(), r1: neckR, r2: hr * 0.6, k: 0.18, tag: 'body' }));
    }
    muzzle = V(cx, cy - hr * 0.36, cz + hr * 0.78);
    P(sphere({ c: muzzle, r: hr * 0.24, k: 0.08, tag: 'head' }));
    // 鼓腮
    for (const s of [-1, 1]) {
      P(sphere({
        c: V(cx + s * hr * 0.34, cy - hr * 0.32, cz + hr * 0.56),
        r: hr * 0.34, k: 0.1, tag: 'head',
      }));
    }
    if (withEars) {
      // 小圆耳：短圆头锥，靠头顶两侧 45°
      for (const s of [-1, 1]) {
        const a = V(cx + s * hr * 0.58, cy + hr * 0.42, cz - hr * 0.04);
        const dir = V(s * 0.62, 1, -0.05).normalize();
        const len = hr * 0.6 * earS;
        const r1 = hr * 0.4 * Math.sqrt(earS);
        const earPrimitive = P(roundCone({
          a,
          b: a.clone().addScaledVector(dir, len),
          r1,
          r2: hr * 0.15,
          k: 0.04,
          tag: 'ear',
        }));
        earPrimitive.idleEarSide = s;
        earDef.push({ a, dir, len, r1, r2: hr * 0.15, side: s });
      }
    }
  }

  function addTail(points, r0, r1t, k = 0.05) {
    if (!tailRootC && points.length) tailRootC = points[0].clone();
    const curve = new THREE.CatmullRomCurve3(points);
    tailRigHints = {
      tailBase: curve.getPoint(0),
      tailMid: curve.getPoint(0.5),
      tailTip: curve.getPoint(1),
    };
    const N = 16;
    let prev = curve.getPoint(0);
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const pt = curve.getPoint(t);
      P(roundCone({
        a: prev, b: pt,
        r1: THREE.MathUtils.lerp(r0, r1t, (i - 1) / N),
        r2: THREE.MathUtils.lerp(r0, r1t, t),
        k, tag: 'tail', u: t, u0: (i - 1) / N, u1: t,
      }));
      prev = pt;
    }
  }

  if (pose === 'standing') {
    // 短腿矮身
    const legLen = 0.24 + 0.28 * params.legLength;
    const bodyY = legLen + 0.27;
    P(sphere({ c: V(0, bodyY + 0.02, 0.26), r: 0.3 * wid, k: 0.15, tag: 'body' }));
    P(sphere({ c: V(0, bodyY + 0.03, -0.28), r: 0.33 * wid, k: 0.15, tag: 'body' }));
    P(sphere({ c: V(0, bodyY - 0.02, 0), r: 0.3, s: [1.1 * wid, 0.92, 1.35], k: 0.17, tag: 'body' }));
    addHead(0, bodyY + 0.18 + hr * 0.5, 0.44, V(0, bodyY + 0.05, 0.28), 0.27 * wid);
    rigAnchorHints = {
      hips: V(0, bodyY + 0.02, -0.28),
      spineLow: V(0, bodyY + 0.01, -0.03),
      spineHigh: V(0, bodyY + 0.08, 0.27),
      head: headC.clone(),
    };
    for (const [sx, sz] of [[-1, 0.28], [1, 0.28], [-1, -0.3], [1, -0.3]]) {
      // Preserve each leg's identity and its own top-to-paw parameter on the
      // frozen SDF mesh. Dynamic skinning must not infer joints from the
      // whole-cat bounding box: that approximation breaks as soon as the leg
      // length parameter changes.
      const rigLegId = sz > 0
        ? (sx > 0 ? 0 : 1) // frontL / frontR
        : (sx > 0 ? 2 : 3); // backL / backR
      const legShaft = P(roundCone({
        a: V(sx * 0.15 * wid, bodyY - 0.05, sz), b: V(sx * 0.16 * wid, 0.13, sz + 0.02),
        r1: 0.105 * wid, r2: 0.09, k: 0.08, tag: 'leg', u0: 0.04, u1: 0.82,
      }));
      legShaft.rigLegId = rigLegId;
      legShaft.rigLegTopY = bodyY - 0.05;
      legShaft.rigLegBottomY = 0.02;
      const paw = P(sphere({
        c: V(sx * 0.16 * wid, 0.08, sz + 0.07),
        r: 0.1,
        s: [1, 0.72, 1.3],
        k: 0.06,
        tag: 'leg',
      }));
      paw.rigLegId = rigLegId;
      paw.rigLegU = 0.96;
      paw.rigLegTopY = bodyY - 0.05;
      paw.rigLegBottomY = 0.02;
      const prefix = ['frontL', 'frontR', 'backL', 'backR'][rigLegId];
      const upper = V(sx * 0.15 * wid, bodyY - 0.05, sz);
      const ankle = V(sx * 0.16 * wid, 0.13, sz + 0.02);
      rigAnchorHints[`${prefix}Upper`] = upper;
      rigAnchorHints[`${prefix}Lower`] = upper.clone().lerp(ankle, 0.54);
      rigAnchorHints[`${prefix}Foot`] = V(sx * 0.16 * wid, 0.08, sz + 0.07);
    }
    const upY = bodyY + 0.08 + (0.5 + 0.4 * tl) * (1 - curl * 0.25);
    addTail([
      V(0, bodyY + 0.1, -0.5),
      V(0, bodyY + 0.26 + 0.18 * tl, -0.58 - 0.16 * tl),
      V(0, upY, -0.52 - 0.18 * tl + curl * 0.26),
      V(0, upY + 0.09 - curl * 0.2, -0.4 - 0.13 * tl + curl * 0.46),
    ], 0.09, 0.055);
    Object.assign(rigAnchorHints, tailRigHints);
    buttHint = V(0, bodyY + 0.02, -0.2);
    gradLow = legLen * 0.5; gradHigh = bodyY + 0.28;
    stripeDir = V(0, 0.15, 1).normalize();
  } else if (pose === 'biped') {
    // Bruno / Roux 式双足直立：梨形腹部、后脚小支点、前爪悬在胸前
    const legLen = 0.24 + 0.16 * params.legLength;
    const rumpY = legLen + 0.27;
    const chestY = rumpY + 0.5;
    P(sphere({ c: V(0, rumpY + 0.05, -0.04), r: 0.38 * wid, s: [1.05, 1.1, 0.92], k: 0.16, tag: 'body' }));
    P(roundCone({
      a: V(0, rumpY + 0.04, -0.03), b: V(0, chestY, 0.02),
      r1: 0.37 * wid, r2: 0.24 * wid, k: 0.18, tag: 'body',
    }));
    P(sphere({ c: V(0, chestY, 0.04), r: 0.25 * wid, s: [1.05, 1, 0.92], k: 0.13, tag: 'body' }));
    addHead(0, chestY + hr * 0.62, 0.14, V(0, chestY - 0.02, 0.04), 0.24 * wid);
    for (const s of [-1, 1]) {
      P(roundCone({
        a: V(s * 0.18 * wid, rumpY + 0.02, -0.03), b: V(s * 0.17 * wid, 0.14, 0.01),
        r1: 0.12 * wid, r2: 0.095, k: 0.08, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.17 * wid, 0.08, 0.08), r: 0.105, s: [1, 0.72, 1.35], k: 0.06, tag: 'leg' }));
      // 叉腰：肩膀先向外撑出肘部，再折回腰侧，正面形成清楚的三角负形
      const shoulder = V(s * 0.22 * wid, chestY - 0.02, 0.24);
      const elbow = V(s * 0.49 * wid, chestY - 0.17, 0.3);
      const paw = V(s * 0.31 * wid, rumpY + 0.23, 0.31);
      P(roundCone({
        a: shoulder, b: elbow,
        r1: 0.072 * wid, r2: 0.06, k: 0.018, tag: 'leg',
      }));
      P(roundCone({
        a: elbow, b: paw,
        r1: 0.06, r2: 0.066, k: 0.018, tag: 'leg',
      }));
      P(sphere({ c: paw, r: 0.078, s: [1, 0.9, 1.15], k: 0.025, tag: 'leg' }));
    }
    addTail([
      V(0, rumpY + 0.08, -0.4),
      V(0, rumpY + 0.35, -0.58),
      V(0.05, rumpY + 0.66 + 0.14 * tl, -0.55),
      V(0.12 + curl * 0.22, rumpY + 0.76 + 0.12 * tl - curl * 0.12, -0.38),
    ], 0.085, 0.052);
    buttHint = V(0, rumpY - 0.02, -0.08);
    gradLow = 0.12; gradHigh = chestY + 0.12;
    stripeDir = V(0, 0.7, 0.3).normalize();
  } else if (pose === 'slouchSit') {
    // Xherdan 式岔腿坐：臀部落地、腹部朝前、后腿向两侧打开
    const bellyY = 0.46;
    P(sphere({ c: V(0, bellyY, -0.05), r: 0.4 * wid, s: [1.04, 1.15, 0.92], k: 0.17, tag: 'body' }));
    P(sphere({ c: V(0, bellyY + 0.26, 0.03), r: 0.31 * wid, s: [1, 1.12, 0.9], k: 0.16, tag: 'body' }));
    addHead(0, bellyY + 0.48 + hr * 0.5, 0.16, V(0, bellyY + 0.3, 0.05), 0.25 * wid);
    for (const s of [-1, 1]) {
      P(roundCone({
        a: V(s * 0.2 * wid, bellyY + 0.02, -0.06), b: V(s * 0.4 * wid, 0.12, 0.2),
        r1: 0.14 * wid, r2: 0.11, k: 0.09, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.43 * wid, 0.085, 0.28), r: 0.12, s: [1.15, 0.68, 1.4], k: 0.06, tag: 'leg' }));
      P(roundCone({
        a: V(s * 0.21 * wid, bellyY + 0.28, 0.15), b: V(s * 0.23 * wid, 0.13, 0.43),
        r1: 0.085 * wid, r2: 0.075, k: 0.07, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.23 * wid, 0.08, 0.49), r: 0.085, s: [1, 0.72, 1.3], k: 0.05, tag: 'leg' }));
    }
    const side = rng.chance(0.5) ? 1 : -1;
    addTail([
      V(0, bellyY + 0.02, -0.47),
      V(side * 0.38 * wid, 0.18, -0.45),
      V(side * 0.54 * wid, 0.11, -0.05),
      V(side * (0.46 * wid - curl * 0.12), 0.1, 0.28 + 0.2 * tl),
    ], 0.09, 0.055);
    buttHint = V(0, bellyY - 0.06, -0.08);
    gradLow = 0.08; gradHigh = bellyY + 0.45;
    stripeDir = V(0, 0.45, 0.7).normalize();
  } else if (pose === 'sideFlat') {
    // Maxwell 式侧卧摊平：横向扁长团块，头偏在一侧，四肢收进轮廓
    P(sphere({ c: V(-0.08, 0.24, -0.08), r: 0.43, s: [1.62 * wid, 0.5, 1.05], k: 0.16, tag: 'body' }));
    P(sphere({ c: V(-0.33 * wid, 0.28, -0.14), r: 0.31, s: [1.2, 0.58, 1], k: 0.15, tag: 'body' }));
    addHead(0.35 * wid, 0.36 + hr * 0.44, 0.38, V(0.18 * wid, 0.28, 0.16), 0.23 * wid);
    for (const s of [-1, 1]) {
      P(sphere({
        c: V(0.18 * wid + s * 0.22 * wid, 0.075, 0.35 - Math.max(0, -s) * 0.18),
        r: 0.1, s: [1.3, 0.62, 1.35], k: 0.08, tag: 'leg',
      }));
    }
    addTail([
      V(-0.34 * wid, 0.22, -0.43),
      V(-0.68 * wid, 0.14, -0.32),
      V(-0.8 * wid, 0.1, 0.05 + 0.14 * tl),
      V(-0.62 * wid + curl * 0.16, 0.1, 0.36 + 0.22 * tl),
    ], 0.085, 0.052);
    buttHint = V(-0.28 * wid, 0.2, -0.04);
    gradLow = 0.06; gradHigh = 0.46;
    stripeDir = V(0.85, 0.1, 0.35).normalize();
  } else if (pose === 'maxwellBlock') {
    // Maxwell 方块团坐：身体像横放的圆角砖块，头偏在一端，四肢压进底部轮廓
    P(sphere({ c: V(-0.18 * wid, 0.31, -0.04), r: 0.43, s: [1.65 * wid, 0.72, 1.05], k: 0.12, tag: 'body' }));
    P(sphere({ c: V(-0.48 * wid, 0.34, -0.08), r: 0.35, s: [1.25, 0.78, 1], k: 0.11, tag: 'body' }));
    addHead(0.46 * wid, 0.39 + hr * 0.48, 0.34, V(0.24 * wid, 0.35, 0.12), 0.27 * wid);
    for (const s of [-1, 1]) {
      P(sphere({
        c: V(0.26 * wid + s * 0.16 * wid, 0.075, 0.42 - Math.max(0, -s) * 0.12),
        r: 0.105, s: [1.18, 0.62, 1.3], k: 0.09, tag: 'leg',
      }));
    }
    addTail([
      V(-0.54 * wid, 0.26, -0.4),
      V(-0.82 * wid, 0.12, -0.26),
      V(-0.82 * wid, 0.09, 0.1 + tl * 0.1),
      V(-0.62 * wid + curl * 0.12, 0.09, 0.32 + tl * 0.18),
    ], 0.085, 0.052);
    buttHint = V(-0.5 * wid, 0.29, -0.06);
    gradLow = 0.06; gradHigh = 0.58;
    stripeDir = V(0.9, 0.08, 0.32).normalize();
  } else if (pose === 'banana') {
    // 香蕉站立：黄色弯月外壳包住猫脸，小手小脚保留猫本体花色
    const bananaPoints = [
      V(-0.08, 0.25, -0.03),
      V(-0.13, 0.55, -0.03),
      V(-0.04, 0.9, -0.02),
      V(0.12, 1.22, -0.04),
      V(0.08, 1.46, -0.08),
    ];
    for (let i = 0; i < bananaPoints.length - 1; i++) {
      P(roundCone({
        a: bananaPoints[i], b: bananaPoints[i + 1],
        r1: THREE.MathUtils.lerp(0.3, 0.19, i / 4),
        r2: THREE.MathUtils.lerp(0.3, 0.19, (i + 1) / 4),
        k: 0.11, tag: 'banana',
      }));
    }
    P(roundCone({
      a: V(0.08, 1.44, -0.08), b: V(0.08, 1.69, -0.1),
      r1: 0.105, r2: 0.075, k: 0.035, tag: 'stem',
    }));
    addHead(0.02, 1.02, 0.27, V(-0.02, 0.83, 0.02), 0.2, true);
    for (const s of [-1, 1]) {
      P(roundCone({
        a: V(s * 0.22, 0.72, 0.02), b: V(s * 0.34, 0.58, 0.16),
        r1: 0.075, r2: 0.065, k: 0.05, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.35, 0.56, 0.19), r: 0.075, s: [1.2, 0.75, 1.1], k: 0.04, tag: 'leg' }));
      P(roundCone({
        a: V(s * 0.14, 0.27, -0.01), b: V(s * 0.17, 0.1, 0.1),
        r1: 0.085, r2: 0.075, k: 0.055, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.18, 0.065, 0.15), r: 0.085, s: [1.2, 0.65, 1.25], k: 0.05, tag: 'leg' }));
    }
    addTail([
      V(0, 0.34, -0.31),
      V(-0.18, 0.38, -0.4),
      V(-0.28, 0.48 + 0.08 * tl, -0.36),
    ], 0.065, 0.04);
    buttHint = V(0, 0.38, -0.02);
    gradLow = 0.08; gradHigh = 1.44;
    stripeDir = V(0.2, 0.9, 0.1).normalize();
  } else if (pose === 'twistedMelt') {
    // 扭结摊平：头伏地，躯干像软绳一样从背后翻折并在右侧形成环
    P(sphere({ c: V(-0.26 * wid, 0.22, 0.02), r: 0.3, s: [1.35 * wid, 0.62, 1.15], k: 0.12, tag: 'body' }));
    const fold = [
      V(-0.12 * wid, 0.24, -0.08),
      V(0.14 * wid, 0.48, -0.2),
      V(0.46 * wid, 0.58, -0.08),
      V(0.58 * wid, 0.34, 0.08),
      V(0.34 * wid, 0.18, 0.25),
    ];
    for (let i = 0; i < fold.length - 1; i++) {
      P(roundCone({
        a: fold[i], b: fold[i + 1],
        r1: 0.2 * wid, r2: 0.17 * wid,
        k: 0.12, tag: 'body',
      }));
    }
    addHead(-0.48 * wid, 0.2 + hr * 0.3, 0.34, V(-0.24 * wid, 0.24, 0.08), 0.22 * wid);
    for (const s of [-1, 1]) {
      P(sphere({
        c: V(-0.32 * wid + s * 0.18 * wid, 0.07, 0.48 - Math.max(0, s) * 0.08),
        r: 0.09, s: [1.3, 0.58, 1.35], k: 0.07, tag: 'leg',
      }));
    }
    addTail([
      V(0.46 * wid, 0.42, -0.12),
      V(0.72 * wid, 0.38, -0.22),
      V(0.96 * wid, 0.26, -0.08),
      V((1.08 + curl * 0.14) * wid, 0.19, 0.16 + tl * 0.12),
    ], 0.08, 0.045);
    buttHint = V(0.48 * wid, 0.4, -0.02);
    gradLow = 0.05; gradHigh = 0.62;
    stripeDir = V(0.75, 0.32, 0.45).normalize();
  } else if (pose === 'sleeping') {
    // 蜷睡：扁圆身体，头枕在前侧，尾巴绕身一圈到下巴
    P(sphere({ c: V(0, 0.3, -0.08), r: 0.44, s: [1.3 * wid, 0.68, 1.15], k: 0.14, tag: 'body' }));
    P(sphere({ c: V(-0.1 * wid, 0.33, -0.34), r: 0.34, s: [1.1, 0.8, 1], k: 0.16, tag: 'body' }));
    addHead(0.1, 0.36 + hr * 0.5, 0.56, V(0.04, 0.32, 0.16), 0.24 * wid);
    for (const s of [-1, 1]) {
      P(sphere({ c: V(0.1 + s * 0.13 * wid, 0.09, 0.6), r: 0.1, s: [1, 0.7, 1.3], k: 0.1, tag: 'leg' }));
    }
    addTail([
      V(-0.2 * wid, 0.16, -0.52),
      V(0.42 * wid, 0.13, -0.38),
      V(0.58 * wid, 0.11, 0.1 + tl * 0.08),
      V(0.42 * wid, 0.1, 0.5 + tl * 0.12),
      V(0.12, 0.1, 0.62 + tl * 0.1),
    ], 0.09, 0.055);
    buttHint = V(-0.12 * wid, 0.24, -0.12);
    gradLow = 0.06; gradHigh = 0.52;
    stripeDir = V(0, 0.2, 1).normalize();
  } else if (pose === 'containerCrouch') {
    const profile = CONTAINER_POSE_PROFILES[params.containerId]
      ?? DEFAULT_CONTAINER_POSE_PROFILE;
    const softFill = params.containerSoftBody === true;
    const verticalCompensation = THREE.MathUtils.clamp(
      ((params.containerScale ?? 1) - 1) * 0.12,
      -0.02,
      0.025
    );
    const bodyLift = profile.bodyLift + verticalCompensation;
    const bodyCenterZ = profile.centerZ;
    const openingShape = params.containerOpeningShape ?? profile.softShape;
    const openingHalfX = Math.max(
      0.42 * wid,
      (params.containerOpeningWidth ?? 0.94) * 0.49
    );
    const openingHalfZ = Math.max(
      0.4,
      (params.containerOpeningDepth ?? 0.9) * 0.49
    );
    const openingCenterZ = params.containerOffsetZ ?? bodyCenterZ;
    const openingRimY = params.containerRimY ?? 0.46;
    const openingFillHalfY = THREE.MathUtils.clamp(
      openingRimY * 0.48,
      0.17,
      0.27
    );
    const openingFillY = openingRimY - openingFillHalfY * 0.82;

    // 猫窝会随体型适配放大，因此身体也必须读取同一份实际开口尺寸。
    // 这层填充体略微压进窝壁，由窝沿遮挡，既填满视觉缝隙又不会穿出外壁。
    if (openingShape === 'rect') {
      P(roundedBox({
        c: V(0, openingFillY, openingCenterZ),
        half: [openingHalfX, openingFillHalfY, openingHalfZ],
        r: Math.min(0.2, openingHalfX * 0.36, openingHalfZ * 0.36),
        k: 0.2,
        tag: 'body',
      }));
    } else {
      const openingFillRadius = 0.36;
      P(sphere({
        c: V(0, openingFillY, openingCenterZ),
        r: openingFillRadius,
        s: [
          openingHalfX / openingFillRadius,
          openingFillHalfY / openingFillRadius,
          openingHalfZ / openingFillRadius,
        ],
        k: 0.2,
        tag: 'body',
      }));
    }

    // 普通模式把最低实体抬进猫窝壁内，避免 surface-nets 的统一地面截断
    // 在猫窝底部形成一圈可见的“屁股”。软体模式则按开口形状铺开。
    if (softFill && profile.softShape === 'rect') {
      P(roundedBox({
        c: V(0, 0.38 + bodyLift, bodyCenterZ),
        half: [0.48 * wid * profile.softWidth, 0.27, 0.5 * profile.softDepth],
        r: 0.2,
        k: 0.18,
        tag: 'body',
      }));
      P(sphere({
        c: V(0, 0.55 + bodyLift * 0.55, 0.13),
        r: 0.3,
        s: [1.12 * wid, 0.94, 1.08],
        k: 0.17,
        tag: 'body',
      }));
    } else if (softFill) {
      P(sphere({
        c: V(0, 0.38 + bodyLift, bodyCenterZ),
        r: 0.4,
        s: [
          1.28 * wid * profile.softWidth,
          0.72,
          1.3 * profile.softDepth,
        ],
        k: 0.2,
        tag: 'body',
      }));
      P(sphere({
        c: V(0, 0.49 + bodyLift * 0.65, 0.1),
        r: 0.31,
        s: [1.13 * wid * profile.width, 0.94, 1.05],
        k: 0.17,
        tag: 'body',
      }));
    } else {
      P(sphere({
        c: V(0, 0.44 + bodyLift, bodyCenterZ),
        r: 0.37,
        s: [1.14 * wid * profile.width, 0.94, 1.16 * profile.depth],
        k: 0.16,
        tag: 'body',
      }));
      P(sphere({
        c: V(0, 0.43 + bodyLift, bodyCenterZ - 0.25),
        r: 0.34,
        s: [1.12 * wid * profile.width, 0.84, profile.depth],
        k: 0.15,
        tag: 'body',
      }));
      P(sphere({
        c: V(0, 0.56 + bodyLift * 0.5, 0.14),
        r: 0.29,
        s: [1.08 * wid * profile.width, 1.02, 1.04],
        k: 0.15,
        tag: 'body',
      }));
    }

    const headY = 0.62 + hr * 0.5 + profile.headLift + verticalCompensation;
    const headZ = 0.34 + profile.headZ;
    const neckFrom = V(0, 0.56 + bodyLift * 0.5, 0.14);
    addHead(0, headY, headZ, neckFrom, 0.25 * wid * profile.width);
    for (const s of [-1, 1]) {
      const pawX = s * 0.2 * wid * profile.pawSpread;
      const pawZ = 0.52 + profile.pawForward;
      const pawY = 0.51 + profile.headLift * 0.35 + verticalCompensation;
      P(roundCone({
        a: V(s * 0.15 * wid * profile.pawSpread, pawY + 0.01, 0.25),
        b: V(pawX, pawY - 0.01, pawZ - 0.04),
        r1: 0.095 * wid,
        r2: 0.085,
        k: 0.07,
        tag: 'leg',
      }));
      P(sphere({
        c: V(pawX, pawY, pawZ),
        r: 0.095,
        s: [1.15, 0.72, 1.2],
        k: 0.07,
        tag: 'leg',
      }));
    }
    // 尾巴完全内收进身体体积，不再从容器底部或后侧绕出。
    // 软体填充时尾巴被身体吸收，不单独生成几何。
    if (!softFill) {
      const side = rng.chance(0.5) ? 1 : -1;
      addTail([
        V(0, 0.42 + bodyLift, bodyCenterZ - 0.25),
        V(side * 0.2 * wid, 0.42 + bodyLift, bodyCenterZ - 0.18),
        V(side * 0.26 * wid, 0.4 + bodyLift, bodyCenterZ + 0.02),
        V(side * (0.16 * wid - curl * 0.03), 0.42 + bodyLift, bodyCenterZ + 0.16),
      ], 0.055, 0.032, 0.035);
    }
    buttHint = null;
    gradLow = 0.08; gradHigh = 0.72;
    stripeDir = V(0, 0.28, 1).normalize();
  } else if (pose === 'stretch') {
    // 伸懒腰：屁股撅高、前胸贴地、前腿前伸、尾巴上扬
    P(sphere({ c: V(0, 0.6, -0.4), r: 0.36, s: [1.05 * wid, 1, 1.05], k: 0.15, tag: 'body' }));
    P(roundCone({ a: V(0, 0.58, -0.3), b: V(0, 0.3, 0.18), r1: 0.3 * wid, r2: 0.26 * wid, k: 0.15, tag: 'body' }));
    P(sphere({ c: V(0, 0.28, 0.28), r: 0.24 * wid, k: 0.13, tag: 'body' }));
    addHead(0, 0.36 + hr * 0.32, 0.5, V(0, 0.3, 0.3), 0.22 * wid);
    for (const s of [-1, 1]) {
      // 后腿立柱
      P(roundCone({
        a: V(s * 0.15 * wid, 0.55, -0.42), b: V(s * 0.16 * wid, 0.13, -0.4),
        r1: 0.105 * wid, r2: 0.095, k: 0.08, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.16 * wid, 0.08, -0.33), r: 0.1, s: [1, 0.7, 1.3], k: 0.06, tag: 'leg' }));
      // 前腿贴地前伸
      P(roundCone({
        a: V(s * 0.13 * wid, 0.24, 0.32), b: V(s * 0.15 * wid, 0.1, 0.72),
        r1: 0.09 * wid, r2: 0.08, k: 0.07, tag: 'leg',
      }));
      P(sphere({ c: V(s * 0.15 * wid, 0.08, 0.78), r: 0.095, s: [1, 0.7, 1.3], k: 0.06, tag: 'leg' }));
    }
    addTail([
      V(0, 0.72, -0.6),
      V(0, 0.92 + 0.18 * tl, -0.68 - 0.08 * tl),
      V(0, 1.05 + 0.22 * tl, -0.52 + curl * 0.18),
      V(0, 1.02 + 0.22 * tl - curl * 0.18, -0.4 + curl * 0.34),
    ], 0.085, 0.052);
    buttHint = V(0, 0.56, -0.25);
    gradLow = 0.1; gradHigh = 0.78;
    stripeDir = V(0, 0.45, 0.9).normalize();
  } else {
    // loaf 猫咪面包（下沉让底面被地面干净截断）
    P(sphere({ c: V(0, 0.35, -0.05), r: 0.4, s: [1.28 * wid, 0.95, 1.65], k: 0.15, tag: 'body' }));
    P(sphere({ c: V(0, 0.42, 0.28), r: 0.34, s: [1.12 * wid, 0.9, 1], k: 0.15, tag: 'body' }));
    addHead(0, 0.58 + hr * 0.46, 0.46, V(0, 0.46, 0.3), 0.3 * wid);
    for (const s of [-1, 1]) {
      P(sphere({ c: V(s * 0.17 * wid, 0.09, 0.5), r: 0.11, s: [1, 0.72, 1.4], k: 0.12, tag: 'leg' }));
    }
    const side = rng.chance(0.5) ? 1 : -1;
    addTail([
      V(0, 0.28, -0.66),
      V(side * 0.42 * wid, 0.13, -0.56),
      V(side * (0.52 * wid), 0.1, 0.02 + tl * 0.22),
      V(side * (0.42 * wid - curl * 0.1), 0.1, 0.34 + tl * 0.3),
    ], 0.085, 0.055);
    buttHint = V(0, 0.3, -0.25);
    gradLow = 0.1; gradHigh = 0.68;
    stripeDir = V(0, 0.15, 1).normalize();
  }

  // ---- 网格化 -------------------------------------------------------------
  // Static poses are rebuilt often and do not deform, so they use a medium
  // Surface Nets grid over the same exact SDF. Dynamic mode alone freezes the
  // original 0.019 high-resolution surface for skinning. This avoids paying
  // the cubic sampling cost on every slider/random rebuild while keeping the
  // former 0.05 regression (flat paws and segmented tails) safely out of use.
  let boundsVolume = CAT_MESH_REFERENCE_VOLUME;
  {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of prims) {
      mn[0] = Math.min(mn[0], p.bx - p.br); mx[0] = Math.max(mx[0], p.bx + p.br);
      mn[1] = Math.min(mn[1], p.by - p.br); mx[1] = Math.max(mx[1], p.by + p.br);
      mn[2] = Math.min(mn[2], p.bz - p.br); mx[2] = Math.max(mx[2], p.bz + p.br);
    }
    boundsVolume = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);
  }
  const cell = resolveCatMeshCellSize(quality, boundsVolume, needsMotionRig);
  const geo = meshFromSDF(prims, cell);
  const meshCompletedAt = performance.now();
  geo.userData.meshCellSize = cell;
  geo.userData.boundsVolume = boundsVolume;
  geo.userData.meshQuality = quality;
  geo.userData.meshMode = needsMotionRig ? 'motion' : 'static';

  // ---- 花色着色 -----------------------------------------------------------
  const cBase = new THREE.Color(coat.base);
  const cUnder = new THREE.Color(coat.under ?? coat.base);
  const cStripe = new THREE.Color(coat.stripe ?? coat.base);
  const cPoint = new THREE.Color(coat.point ?? coat.base);
  const cPatchA = new THREE.Color(coat.patchA ?? coat.base);
  const cPatchB = new THREE.Color(coat.patchB ?? coat.base);
  const cBack = cBase.clone().offsetHSL(0, 0.02, -0.04);
  const cBanana = new THREE.Color('#f4d927');
  const cStem = new THREE.Color('#71502f');

  // 中频条纹：细而清晰
  const stripeFreq = rng.range(7.5, 10);
  const stripePhase = rng.range(0, Math.PI * 2);
  const sockH = rng.range(0.16, 0.28);
  const hasBlaze = rng.chance(0.6);
  const blobs = [];
  for (let i = 0; i < 5; i++) {
    blobs.push({
      x: rng.range(-0.65, 0.65), y: rng.range(0.3, 1.3), z: rng.range(-0.9, 1.0),
      r: rng.range(0.34, 0.56), c: rng.chance(0.55) ? cPatchA : cPatchB,
    });
  }
  // 奶牛猫身上的大块黑斑：偏背侧的 2~3 个大圆斑
  const cowBlobs = [];
  const cowN = rng.chance(0.5) ? 2 : 3;
  for (let i = 0; i < cowN; i++) {
    cowBlobs.push({
      x: rng.range(-0.45, 0.45), y: rng.range(0.5, 1.0), z: rng.range(-0.75, 0.4),
      r: rng.range(0.45, 0.62),
    });
  }

  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const dynamicEligibility = new Float32Array(pos.count);
  const dynamicBodyStripeEligibility = new Float32Array(pos.count);
  const dynamicHeadStripeEligibility = new Float32Array(pos.count);
  const dynamicTailStripeCoordinate = new Float32Array(pos.count);
  dynamicTailStripeCoordinate.fill(-1);
  const dynamicUndercoatMix = new Float32Array(pos.count);
  const rigPart = new Float32Array(pos.count);
  // Motion-only buffers are intentionally absent from static cats. Besides
  // their own allocation cost, every extra attribute used to be cloned into
  // the inverted-hull outline and uploaded to the GPU.
  const rigInfluence = needsMotionRig ? new Float32Array(pos.count * 4) : null;
  const rigTailU = needsMotionRig ? new Float32Array(pos.count) : null;
  const rigLegId = needsMotionRig ? new Float32Array(pos.count) : null;
  const rigLegNearestU = needsMotionRig ? new Float32Array(pos.count) : null;
  const rigLegBlend = needsMotionRig ? new Float32Array(pos.count * 4) : null;
  const rigLegCoord = needsMotionRig ? new Float32Array(pos.count * 4) : null;
  rigTailU?.fill(-1);
  rigLegId?.fill(-1);
  rigLegNearestU?.fill(-1);
  rigLegCoord?.fill(-1);
  const idleRegion = new Float32Array(pos.count * 3);
  const idleTailU = new Float32Array(pos.count);
  const dynamicCandidates = [];
  const dynamicCoreCandidates = [];
  const p = new THREE.Vector3();
  const out = new THREE.Color();
  const earPrims = prims.filter((pr) => pr.tag === 'ear');
  const earDist = (pt) => Math.min(...earPrims.map((e) => e.dist(pt.x, pt.y, pt.z)));
  const legPrims = prims.filter((pr) => pr.tag === 'leg');
  const legDist = (pt) => (legPrims.length ? Math.min(...legPrims.map((e) => e.dist(pt.x, pt.y, pt.z))) : 1e9);
  const rigGroupIndex = (primitive) => (
    primitive.tag === 'head' || primitive.tag === 'ear'
      ? 1
      : primitive.tag === 'leg'
        ? 2
        : primitive.tag === 'tail'
          ? 3
          : 0
  );

  // 椭圆化的口鼻距离：白色区横向宽、纵向短
  const muzzleDist = (pt) => {
    const dx = (pt.x - muzzle.x) / 1.35;
    const dy = (pt.y - muzzle.y) / 0.85;
    const dz = pt.z - muzzle.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    // Dynamic binding needs several semantic distances. Sample every
    // primitive once and reuse that result for ownership, joints, idle masks
    // and coat masks; the previous implementation evaluated the same SDF
    // primitive four to eight times per vertex.
    let prim = null;
    let rigGroupDistances = null;
    let rigNearestPrims = null;
    let sampledNonEarDistance = 1e9;
    let sampledLeftEarDistance = 1e9;
    let sampledRightEarDistance = 1e9;
    if (needsMotionRig) {
      rigGroupDistances = [1e9, 1e9, 1e9, 1e9];
      rigNearestPrims = [null, null, null, null];
      let nearestDistance = 1e9;
      for (const primitive of prims) {
        const distance = primitive.dist(p.x, p.y, p.z);
        const groupIndex = rigGroupIndex(primitive);
        if (distance < rigGroupDistances[groupIndex]) {
          rigGroupDistances[groupIndex] = distance;
          rigNearestPrims[groupIndex] = primitive;
        }
        if (distance < nearestDistance) {
          nearestDistance = distance;
          prim = primitive;
        }
        if (primitive.tag !== 'ear') {
          sampledNonEarDistance = Math.min(sampledNonEarDistance, distance);
        } else if (primitive.idleEarSide < 0) {
          sampledLeftEarDistance = Math.min(sampledLeftEarDistance, distance);
        } else {
          sampledRightEarDistance = Math.min(sampledRightEarDistance, distance);
        }
      }
    } else {
      prim = nearestPrim(prims, p.x, p.y, p.z);
    }
    const tag = prim?.tag ?? 'body';
    const u = prim?.uAt ? prim.uAt(p.x, p.y, p.z) : (prim?.u ?? 0);
    rigPart[i] = tag === 'head' || tag === 'ear'
      ? 1
      : tag === 'leg'
        ? 2
        : tag === 'tail'
          ? 3
          : 0;
    const semanticGroup = rigPart[i];
    if (needsMotionRig) {
      // Only blend along the actual SDF hierarchy:
      //   head <-> body, one leg <-> body, tail <-> body.
      // Blending all four legs with each other made adjacent vertices choose
      // different four-bone subsets, producing folded triangles and apparent
      // tears as soon as the legs moved in opposite directions.
      const groupDistances = rigGroupDistances;
      const primary = semanticGroup;
      let secondary = 0;
      if (primary === 0) {
        secondary = 1;
        for (let groupIndex = 2; groupIndex < 4; groupIndex++) {
          if (groupDistances[groupIndex] < groupDistances[secondary]) secondary = groupIndex;
        }
      }
      const blendWidth = Math.max(cell * 6.5, 0.105);
      const distanceDelta = Math.max(
        0,
        groupDistances[secondary] - groupDistances[primary]
      );
      const secondaryRaw = groupDistances[secondary] >= 1e8
        ? 0
        : Math.exp(-(distanceDelta * distanceDelta) / (blendWidth * blendWidth));
      const inverseTotal = 1 / (1 + secondaryRaw);
      rigInfluence[i * 4 + primary] = inverseTotal;
      if (secondary !== primary) {
        rigInfluence[i * 4 + secondary] = secondaryRaw * inverseTotal;
      }
    }
    const legWeight = needsMotionRig ? rigInfluence[i * 4 + 2] : 0;
    if (needsMotionRig && legWeight > 1e-4 && legPrims.length) {
      const legPrimitive = rigNearestPrims[2];
      const legId = legPrimitive?.rigLegId ?? -1;
      rigLegId[i] = legId;
      rigLegNearestU[i] = THREE.MathUtils.clamp(
        Number.isFinite(legPrimitive?.rigLegTopY)
          ? (
              (legPrimitive.rigLegTopY - p.y)
              / Math.max(legPrimitive.rigLegTopY - legPrimitive.rigLegBottomY, 0.001)
            )
          : legPrimitive?.uAt
            ? legPrimitive.uAt(p.x, p.y, p.z)
            : (legPrimitive?.rigLegU ?? 0.5),
        0,
        1
      );
      // A fused body/leg transition may blend with its parent body, but a
      // vertex must never be shared by two different legs.
      if (legId >= 0) {
        rigLegBlend[i * 4 + legId] = 1;
        rigLegCoord[i * 4 + legId] = rigLegNearestU[i];
      }
    }
    const tailWeight = needsMotionRig ? rigInfluence[i * 4 + 3] : (tag === 'tail' ? 1 : 0);
    if (needsMotionRig && tailWeight > 1e-4 && rigNearestPrims[3]) {
      const tailPrimitive = rigNearestPrims[3];
      rigTailU[i] = THREE.MathUtils.clamp(
        tailPrimitive?.uAt ? tailPrimitive.uAt(p.x, p.y, p.z) : (tailPrimitive?.u ?? u),
        0,
        1
      );
    }
    if (!needsMotionRig) {
      // Static idle only needs semantic ownership already produced by the
      // nearest-primitive pass. This replaces four full primitive-group scans
      // per vertex while keeping the tail and ear easing animation.
      idleRegion[i * 3] = tailWeight;
      if (tailWeight > 0) idleTailU[i] = THREE.MathUtils.clamp(u, 0, 1);
      if (tag === 'ear') {
        const earWeight = sstep(0.04, 0.34, THREE.MathUtils.clamp(u, 0, 1));
        if (prim?.idleEarSide < 0) idleRegion[i * 3 + 1] = earWeight;
        else if (prim?.idleEarSide > 0) idleRegion[i * 3 + 2] = earWeight;
      }
    }
    // These distances only affect the two coat families that consume them.
    // The old path evaluated every leg and ear primitive for every vertex,
    // even on solid/tabby/tuxedo cats.
    const surfaceLegDistance = coat.kind === 'calico'
      ? (needsMotionRig ? rigGroupDistances[2] : legDist(p))
      : 1e9;
    const surfaceEarDistance = coat.kind === 'points'
      ? (
          needsMotionRig
            ? Math.min(sampledLeftEarDistance, sampledRightEarDistance)
            : earDist(p)
        )
      : 1e9;
    const muzzleD = muzzleDist(p);
    const bandTop = gradLow + (gradHigh - gradLow) * 0.24;
    let hGrad = sstep(gradLow - 0.06, bandTop, p.y);
    if (tag === 'head' || tag === 'ear') hGrad = 1;
    const kind = coat.kind;
    let tabbyBodyStripe = 0;
    let tabbyHeadStripe = 0;
    let tabbyTailStripe = -1;
    let tabbyUnderMix = 0;

    if (kind === 'solid') {
      out.copy(cBase).lerp(cUnder, (1 - hGrad) * 0.4);
    } else if (kind === 'tabby') {
      out.copy(cUnder).lerp(cBase, 0.3 + 0.7 * hGrad);
      // 背部条纹（细而清晰，只在背侧，且避开头部附近）
      let s = -1;
      let backness = 1;
      // 后脑勺归入身体条纹区：狸花的环纹一路爬到头顶后侧
      const backOfHead = tag === 'head' && p.z < headC.z + hr * 0.12 && p.y < headC.y + hr * 0.9;
      if (tag === 'body' || backOfHead) {
        s = Math.sin((p.y * stripeDir.y + p.z * stripeDir.z) * stripeFreq * Math.PI * 0.62 + stripePhase);
        // 只在背侧，且避开脸正前方的胸口区
        backness = sstep(0.4, 0.75, hGrad) * sstep(headC.z + 0.1, headC.z - 0.12, p.z);
        tabbyBodyStripe = backness;
      } else if (tag === 'tail') {
        s = Math.sin(u * 13 + stripePhase);
        tabbyTailStripe = u;
      } else if (
        tag === 'head' &&
        p.y > headC.y + hr * 0.34 && p.y < headC.y + hr * 0.74 &&
        Math.abs(p.x - headC.x) < hr * 0.55 && p.z > headC.z + hr * 0.2
      ) {
        s = Math.sin(((p.x - headC.x) / hr) * 19 + Math.PI / 2); // 额头三道短竖纹
        tabbyHeadStripe = 1;
      }
      // 干笔刷边缘：多频噪声扰动条纹边界，撕出笔触感
      const brush =
        Math.sin(p.x * 83.3 + p.y * 47.1) * Math.sin(p.y * 71.7 + p.z * 59.3) * 0.7 +
        Math.sin((p.x + p.z) * 127.1 + p.y * 31.7) * 0.3;
      s += brush * 0.18;
      const stripeM = sstep(0.6, 0.7, s) * backness;
      out.lerp(cStripe, stripeM * 0.92);
      // 条纹核心再压深一档，像颜料叠涂
      out.lerp(cStripe.clone().offsetHSL(0, 0.02, -0.07), sstep(0.84, 0.95, s) * backness * 0.5);
      // 白下半脸 + 白下巴
      const muzzleUnder = sstep(hr * 0.52, hr * 0.34, muzzleD);
      tabbyUnderMix = Math.max((1 - hGrad) * 0.72, muzzleUnder);
      out.lerp(cUnder, muzzleUnder);
    } else if (kind === 'tuxedo') {
      // 奶牛猫：白底 + 大块黑斑（头盖斑、背鞍斑、黑尾白尖），边界利落带轻微笔刷波动
      out.copy(cUnder);
      const wob = (Math.sin(p.x * 21.7 + p.y * 15.3) * 0.6 + Math.sin((p.y * 1.7 + p.z) * 29.1) * 0.4) * 0.03;
      let black = 0;
      if (tag === 'head' || tag === 'ear') {
        // 头盖斑：罩住双耳和头顶，停在眼睛上方，脸下半和口鼻留白
        black = sstep(-0.02, 0.02, p.y + wob - (headC.y + hr * 0.26));
        if (hasBlaze) {
          // 额中白色火焰纹
          black *= 1 - sstep(hr * 0.2, hr * 0.08, Math.abs(p.x - headC.x)) * sstep(headC.z + hr * 0.2, headC.z + hr * 0.5, p.z);
        }
      } else if (tag === 'body') {
        // 大块圆斑：偏背侧、利落硬边；胸口正面与下腹留白
        for (const b of cowBlobs) {
          const d = Math.hypot(p.x - b.x, (p.y - b.y) * 1.15, p.z - b.z) + wob;
          black = Math.max(black, sstep(b.r * 0.86, b.r * 0.78, d));
        }
        black *= sstep(headC.z + 0.16, headC.z - 0.04, p.z) * sstep(gradLow + 0.04, gradLow + 0.18, p.y);
      } else if (tag === 'tail') {
        // 根部留白（避免尾根标签渗色把臀部涂黑），中段黑、尾尖白
        black = sstep(0.12, 0.3, u) * (1 - sstep(0.74, 0.88, u));
      }
      out.lerp(cBase, black);
    } else if (kind === 'calico') {
      out.copy(cBase);
      let m = 0;
      let bc = cPatchA;
      const pbrush =
        Math.sin(p.x * 67.3 + p.y * 41.9) * Math.sin(p.y * 53.7 + p.z * 61.1) * 0.5 +
        Math.sin((p.x - p.z) * 103.9) * 0.3;
      for (const b of blobs) {
        const d = Math.hypot(p.x - b.x, (p.y - b.y) * 1.2, p.z - b.z) + pbrush * 0.035;
        const w = sstep(b.r * 0.88, b.r * 0.78, d);
        if (w > m) { m = w; bc = b.c; }
      }
      m *= 1 - sstep(0.07, -0.02, surfaceLegDistance) * sstep(0.46, 0.26, p.y); // 白手套
      m *= 1 - sstep(hr * 0.5, hr * 0.32, muzzleD);
      out.lerp(bc, m);
    } else if (kind === 'tortoiseshell') {
      // 玳瑁是密集互锁的黑、橘、棕碎斑，不出现三花的大面积白底。
      out.copy(cBase);
      const tortieWarp =
        Math.sin((p.x + p.z) * 8.3 + p.y * 3.7) * 0.76 +
        Math.sin((p.x - p.z) * 13.7 - p.y * 5.1) * 0.34;
      const tortieField =
        Math.sin(p.x * 9.4 + tortieWarp) * 0.58 +
        Math.sin((p.z * 0.78 - p.y * 0.45) * 9.4 - tortieWarp * 0.7) * 0.34 +
        Math.sin((p.x + p.z + p.y * 0.35) * 17.2) * 0.2;
      const orangeMask = sstep(0.2, 0.34, tortieField);
      const brownMask = sstep(0.38, 0.52, -tortieField);
      out.lerp(cPatchA, orangeMask);
      if (brownMask > orangeMask) out.copy(cBase).lerp(cPatchB, brownMask);
    } else if (kind === 'points') {
      out.copy(cBase).lerp(cUnder, (1 - hGrad) * 0.3);
      let m = sstep(0.06, -0.03, surfaceEarDistance); // 耳朵重点色：距离场软边
      m = Math.max(m, sstep(0.07, -0.03, surfaceLegDistance) * sstep(0.5, 0.2, p.y)); // 深色手套
      if (tag === 'tail') m = Math.max(m, sstep(0.2, 0.75, u));
      else if (tag === 'head') m = Math.max(m, sstep(hr * 0.9, hr * 0.32, muzzleD));
      out.lerp(cPoint, m * 0.95);
    }

    if (tag === 'banana') out.copy(cBanana);
    else if (tag === 'stem') out.copy(cStem);

    const dynamicEligible = tag !== 'banana' && tag !== 'stem';
    dynamicEligibility[i] = dynamicEligible ? 1 : 0;
    dynamicBodyStripeEligibility[i] = tabbyBodyStripe;
    dynamicHeadStripeEligibility[i] = tabbyHeadStripe;
    dynamicTailStripeCoordinate[i] = tabbyTailStripe;
    dynamicUndercoatMix[i] = tabbyUnderMix;
    if (dynamicEligible) dynamicCandidates.push(i);
    if (tag === 'body' || tag === 'head') dynamicCoreCandidates.push(i);
    colors[i * 3] = out.r;
    colors[i * 3 + 1] = out.g;
    colors[i * 3 + 2] = out.b;
  }
  const vertexDataCompletedAt = performance.now();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('coatEligible', new THREE.BufferAttribute(dynamicEligibility, 1));
  geo.setAttribute('coatBodyStripe', new THREE.BufferAttribute(dynamicBodyStripeEligibility, 1));
  geo.setAttribute('coatHeadStripe', new THREE.BufferAttribute(dynamicHeadStripeEligibility, 1));
  geo.setAttribute('coatTailStripe', new THREE.BufferAttribute(dynamicTailStripeCoordinate, 1));
  geo.setAttribute('coatUnderMix', new THREE.BufferAttribute(dynamicUndercoatMix, 1));
  geo.setAttribute('rigPart', new THREE.BufferAttribute(rigPart, 1));
  if (needsMotionRig) {
    geo.setAttribute('rigInfluence', new THREE.BufferAttribute(rigInfluence, 4));
    geo.setAttribute('rigTailU', new THREE.BufferAttribute(rigTailU, 1));
    geo.setAttribute('rigLegId', new THREE.BufferAttribute(rigLegId, 1));
    geo.setAttribute('rigLegU', new THREE.BufferAttribute(rigLegNearestU, 1));
    geo.setAttribute('rigLegBlend', new THREE.BufferAttribute(rigLegBlend, 4));
    geo.setAttribute('rigLegCoord', new THREE.BufferAttribute(rigLegCoord, 4));
  }
  geo.setAttribute('idleRegion', new THREE.BufferAttribute(idleRegion, 3));
  geo.setAttribute('idleTailU', new THREE.BufferAttribute(idleTailU, 1));
  applyFluffGeometry(
    geo,
    params.fluffy ? (params.furFluff ?? 0.65) : 0,
    params.seed,
    headC,
    hr
  );
  const dynamicCoatState = createDynamicCoatState(
    params,
    geo,
    dynamicCandidates,
    dynamicCoreCandidates,
    coat,
    {
      stripeDir,
      stripePhase,
      headCenter: headC,
      headRadius: hr,
    }
  );
  const leftEar = earDef.find((ear) => ear.side < 0);
  const rightEar = earDef.find((ear) => ear.side > 0);
  const staticIdleState = createStaticIdleState({
    tailPivot: tailRootC ?? V(0, 0.55, -0.65),
    earLeftPivot: leftEar?.a ?? headC,
    earRightPivot: rightEar?.a ?? headC,
  });

  // 注入顺序：先暗面排线，再软体形变（injectPoke 会链式调用前者）
  const furMat = injectStaticIdle(injectPoke(injectBodyHatch(injectDynamicCoat(
    new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradientMap() }),
    dynamicCoatState
  ))), staticIdleState);
  furMat.customProgramCacheKey = () => 'poke-bodyhatch-static-idle-v1';
  // Three.js 默认用 FrontSide 材质的背面写入 ShadowMap。SDF 猫为了贴地会
  // 截断底部，背面投影会从开放底口漏光，形成空心圆环。强制使用正面深度，
  // 让从光源看到的完整外轮廓写入阴影。
  furMat.shadowSide = THREE.FrontSide;
  const furMesh = new THREE.Mesh(geo, furMat);
  furMesh.castShadow = true;
  furMesh.receiveShadow = false; // 身体暗部由色阶 + 排线表达，不接软阴影
  furMesh.name = 'fur';

  const cat = new THREE.Group();
  cat.name = 'ProceduralKitten';
  const furOutline = makeOutline(
    geo,
    0.011,
    '#4a3428',
    params.outlineJitter ?? 0,
    staticIdleState
  );
  cat.add(furMesh, furOutline);
  cat.userData.setTransientFluff = createTransientFluffController(
    geo,
    furOutline.geometry,
    params.seed,
    headC,
    hr
  );
  cat.userData.updateDynamicCoat = (nextParams) => dynamicCoatState.apply(nextParams);
  cat.userData.dynamicCoatState = dynamicCoatState;
  cat.userData.prepareDynamicCoatExport = () => dynamicCoatState.prepareExport();
  cat.userData.staticIdleState = staticIdleState;
  cat.userData.updateStaticIdle = (time, enabled = true) => (
    updateStaticIdle(staticIdleState, time, enabled)
  );

  // 耳内与屁屁：和眼睛一样投射到 SDF 真实曲面的独立 decal，
  // 不再混入身体顶点颜色，也不是会穿模的平面零件。
  const surfaceDetails = new THREE.Group();
  surfaceDetails.name = 'surfaceDetails';
  for (const ear of earDef) {
    surfaceDetails.add(makeInnerEarDecal(prims, ear, staticIdleState));
  }
  if (buttHint && BUTT_DECAL_POSES.has(pose)) {
    const buttSize = 0.075 * THREE.MathUtils.clamp(wid, 0.82, 1.5);
    surfaceDetails.add(makeButtDecal(prims, buttHint, buttSize));
  }
  cat.add(surfaceDetails);

  // ---- 五官精修件 ----------------------------------------------------------
  const face = new THREE.Group();
  face.name = 'face';
  cat.add(face);

  // 眼睛：纹理投射到头部真实曲面，侧视不会再露出独立白色圆片。
  const eyeR = hr * 0.26 * params.eyeSize;
  const ex = resolveEyeHorizontalOffset(hr, params.eyeSpacing);
  const ey = headC.y - hr * 0.06;
  const effectiveIrisScale = THREE.MathUtils.clamp(params.irisScale ?? 0.65, 0.1, 1.3);
  const irisRatio = THREE.MathUtils.clamp(0.8 * effectiveIrisScale, 0.12, 0.92);
  const eyeAnimators = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const irisColor = i === 0 ? leftEyeColor : rightEyeColor;
    const centerDir = V(s * ex, ey - headC.y, hr * 0.78).normalize();
    const eye = makeEyeDecal(
      prims,
      headC,
      centerDir,
      eyeR,
      irisColor,
      irisRatio,
      params.wateryEyes ? (params.wateryEyeShape ?? 1.1) : 0,
      -s,
      params.irisHighlightScale ?? 1
    );
    eyeAnimators.push(eye.userData.eyeAnimator);
    face.add(eye);
  }
  cat.userData.updateEyeAnimation = (time, gazeX = 0, gazeY = 0) => {
    for (const animateEye of eyeAnimators) animateEye(time, gazeX, gazeY);
  };

  // 鼻子
  const noseMat = new THREE.MeshToonMaterial({ color: '#dd8b92', gradientMap: toonGradientMap() });
  const nose = new THREE.Mesh(new THREE.SphereGeometry(hr * 0.085, 14, 10), noseMat);
  nose.geometry.scale(1.3, 0.75, 0.6);
  nose.position.set(muzzle.x, muzzle.y + hr * 0.12, muzzle.z + hr * 0.19);
  face.add(nose);

  // ω 嘴
  const mouthMat = new THREE.MeshBasicMaterial({ color: '#8a5f58' });
  for (const s of [-1, 1]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(hr * 0.07, hr * 0.012, 6, 16, Math.PI * (2 / 3)), mouthMat);
    arc.position.set(muzzle.x + s * hr * 0.065, muzzle.y + hr * 0.04, muzzle.z + hr * 0.24);
    arc.rotation.z = Math.PI * (7 / 6);
    face.add(arc);
  }

  // 胡须：深色墨线，与描边同一语言
  const whiskerMat = new THREE.MeshBasicMaterial({ color: '#4a3428' });
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const y0 = muzzle.y + hr * 0.05 - i * hr * 0.065;
      const start = V(muzzle.x + s * hr * 0.3, y0, muzzle.z + hr * 0.02);
      const midPt = V(muzzle.x + s * hr * 0.75, y0 + hr * (0.07 - i * 0.045), muzzle.z - hr * 0.02);
      const end = V(muzzle.x + s * hr * 1.15, y0 + hr * (0.04 - i * 0.1), muzzle.z - hr * 0.12);
      const curve = new THREE.QuadraticBezierCurve3(start, midPt, end);
      const wm = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.0055, 5), whiskerMat);
      wm.userData.refPos = start.clone(); // 胡须几何是世界坐标，戳捏参考点取根部
      face.add(wm);
    }
  }

  // 记录五官基准位置，供戳捏形变时 JS 侧同步偏移
  for (const child of face.children) {
    if (child.userData.skipPokeSync) continue;
    child.userData.basePos = child.position.clone();
    if (!child.userData.refPos) child.userData.refPos = child.position.clone();
  }

  // 交互需要的解剖信息：脸颊 / 后颈 / 屁股的区域判定 + 物理碰撞近似
  geo.computeBoundingBox();
  const bbox = geo.boundingBox;
  cat.userData.headC = headC.clone();
  cat.userData.hr = hr;
  cat.userData.muzzle = muzzle.clone();
  cat.userData.rigAnchorHints = rigAnchorHints;
  cat.userData.buttC = V(0, bbox.max.y * 0.42, bbox.min.z + 0.14);
  cat.userData.colliders = [
    { c: V(0, bbox.max.y * 0.35, (bbox.min.z + bbox.max.z) * 0.5), r: Math.min((bbox.max.x - bbox.min.x), bbox.max.y) * 0.42 },
    { c: headC.clone(), r: hr * 1.05 },
  ];
  cat.userData.buildTimings = {
    meshMs: meshCompletedAt - buildStartedAt,
    vertexDataMs: vertexDataCompletedAt - meshCompletedAt,
    detailsMs: performance.now() - vertexDataCompletedAt,
    totalMs: performance.now() - buildStartedAt,
  };

  return cat;
}
