import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildCat, EYE_SPACING_RANGE } from './catBuilder.js';
import { COATS, EYE_COLORS, POSES } from './coats.js';
import { createRng, randomSeed } from './rng.js';
import {
  pokeUniforms, pokeFeel, beginGrab, setGrabPoint, setGrabTarget, endGrab,
  pulsePoke, updatePokes, anyPokeActive, pokeOffsetAt,
} from './softPoke.js';
import { hatchUniforms, HATCH_PRESETS, HATCH_GLSL } from './hatch.js';
import { createToyWorld } from './toys.js';
import { createRugLayer } from './rug.js';
import { createContainer, getContainerDescriptor } from './container.js';
import { createRandomBgm } from './bgm.js';
import { initI18n } from './i18n.js';
import { createShareCardCapture } from './shareCard.js';
import { createSpeechBubbleController } from './speechBubbles.js';
import { createCodexPetPreview } from './codexPetPreview.js';
import {
  WEATHER_AMOUNT_LIMITS,
  createCloudField,
  createFishRain,
  createRainField,
  createWeatherAudio,
} from './weather.js';
import {
  MESH2MOTION_ACTIONS,
  getRigCompatibility,
} from './mesh2motionRig.js';
import { createMesh2MotionSkinRig } from './mesh2motionSkinRig.js';
import {
  MOTION_KEY_BINDINGS,
  createCatMotionStateMachine,
  isMotionControlCode,
} from './catMotionStateMachine.js';

const i18n = initI18n();
const bgm = createRandomBgm(document.getElementById('bgm-toggle'));

// Initial canned-cat loading animation. The overlay is present in index.html,
// so it paints before the Three.js bundle is ready. It only completes after
// both the first initialized canvas frame and its visible images are decoded;
// later cat rebuilds never reopen it.
const initialLoader = document.getElementById('initial-loader');
const initialLoaderPercent = document.getElementById('initial-loader-percent');
const initialLoaderStartedAt = performance.now();
const INITIAL_LOADER_MIN_MS = 1450;
const INITIAL_LOADER_ASSET_TIMEOUT_MS = 4000;
let initialLoaderFinished = false;
let initialLoaderFinishRequested = false;
let initialLoaderProgress = 7;
let initialLoaderFrame = 0;

function waitForLoaderImage(image) {
  if (!image) return Promise.resolve();
  const loaded = image.complete
    ? Promise.resolve()
    : new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });

  return loaded.then(() => {
    if (!image.naturalWidth || typeof image.decode !== 'function') return undefined;
    return image.decode().catch(() => undefined);
  });
}

const initialLoaderAssetsReady = Promise.all(
  [...(initialLoader?.querySelectorAll('img') ?? [])].map(waitForLoaderImage)
).then(() => {
  if (initialLoader) initialLoader.dataset.assets = 'ready';
});

let initialLoaderAssetTimeout = 0;
const initialLoaderAssetTimeoutReached = new Promise((resolve) => {
  initialLoaderAssetTimeout = window.setTimeout(() => {
    if (initialLoader) initialLoader.dataset.assets = 'timeout';
    resolve();
  }, INITIAL_LOADER_ASSET_TIMEOUT_MS);
});
initialLoaderAssetsReady.then(() => window.clearTimeout(initialLoaderAssetTimeout));

const initialLoaderAssetsSettled = Promise.race([
  initialLoaderAssetsReady,
  initialLoaderAssetTimeoutReached,
]);

function setInitialLoaderProgress(value) {
  initialLoaderProgress = THREE.MathUtils.clamp(Math.round(value), 0, 100);
  initialLoader?.style.setProperty('--loader-progress', `${initialLoaderProgress}%`);
  if (initialLoaderPercent) initialLoaderPercent.value = `${initialLoaderProgress}%`;
}

function updateInitialLoaderProgress() {
  if (initialLoaderFinished) return;
  const elapsed = performance.now() - initialLoaderStartedAt;
  const simulatedProgress = Math.min(92, 7 + 86 * (1 - Math.exp(-elapsed / 720)));
  setInitialLoaderProgress(Math.max(initialLoaderProgress, simulatedProgress));
  initialLoaderFrame = requestAnimationFrame(updateInitialLoaderProgress);
}

setInitialLoaderProgress(initialLoaderProgress);
initialLoaderFrame = requestAnimationFrame(updateInitialLoaderProgress);

function finishInitialLoader(reason = 'first-frame') {
  if (!initialLoader || initialLoaderFinished) return;
  const wait = Math.max(
    0,
    INITIAL_LOADER_MIN_MS - (performance.now() - initialLoaderStartedAt)
  );
  window.setTimeout(() => {
    if (initialLoaderFinished) return;
    initialLoaderFinished = true;
    cancelAnimationFrame(initialLoaderFrame);
    setInitialLoaderProgress(100);
    initialLoader.dataset.state = reason;
    initialLoader.classList.add('is-ready');
    window.setTimeout(() => initialLoader.classList.add('is-exiting'), 360);
    window.setTimeout(() => initialLoader.classList.add('is-hidden'), 840);
  }, wait);
}

function finishInitialLoaderWhenReady(reason = 'first-frame') {
  if (initialLoaderFinishRequested || initialLoaderFinished) return;
  initialLoaderFinishRequested = true;
  initialLoaderAssetsSettled.finally(() => {
    window.clearTimeout(initialLoaderFailsafe);
    finishInitialLoader(reason);
  });
}

const initialLoaderFailsafe = window.setTimeout(
  () => finishInitialLoader('failsafe'),
  7000
);

// ---------------------------------------------------------------- 参数定义
// 范围放开到能出"极端小猫"：巨头娃娃 / 长颈鹿腿 / 蝙蝠耳 / 超长尾都在射程内
const BODY_SLIDERS = [
  { key: 'headSize',   name: '头身比',   min: 0.35, max: 2.8,  step: 0.01 },
  { key: 'chubbiness', name: '圆润度',   min: 0.3,  max: 4.5,  step: 0.01 },
  { key: 'legLength',  name: '腿长',     min: 0.05, max: 5.0,  step: 0.01 },
  { key: 'earSize',    name: '耳朵大小', min: 0.1,  max: 4.5,  step: 0.01 },
  { key: 'tailLength', name: '尾巴长度', min: 0.05, max: 4.5,  step: 0.01 },
  { key: 'tailCurl',   name: '尾巴卷曲', min: -0.75, max: 2.25, step: 0.01 },
];

const EYE_SLIDERS = [
  { key: 'eyeSize',         name: '眼睛大小', min: 0.6, max: 1.7, step: 0.01 },
  { key: 'eyeSpacing',      name: '眼距', min: EYE_SPACING_RANGE.min, max: EYE_SPACING_RANGE.max, step: 0.01 },
  { key: 'irisScale',       name: '瞳孔大小', min: 0.1, max: 1.3, step: 0.01 },
  { key: 'irisHighlightScale', name: '瞳孔高光大小', min: 1, max: 2.4, step: 0.01 },
  { key: 'wateryEyeShape',  name: '泪眼形变', min: 0,   max: 2,   step: 0.01 },
];

const FUR_SLIDERS = [
  { key: 'furFluff', name: '炸毛程度', min: 0.15, max: 3.0, step: 0.01 },
];

// UI keeps the wide ranges for manual sculpting, while random generation uses
// a separate, friendly silhouette range so extreme cats are always deliberate.
const RANDOM_SLIDERS = [
  { key: 'headSize', min: 0.78, max: 1.42, step: 0.01 },
  { key: 'chubbiness', min: 0.72, max: 1.95, step: 0.01 },
  { key: 'legLength', min: 0.48, max: 1.65, step: 0.01 },
  { key: 'earSize', min: 0.62, max: 1.48, step: 0.01 },
  { key: 'tailLength', min: 0.58, max: 1.72, step: 0.01 },
  { key: 'tailCurl', min: -0.12, max: 1.18, step: 0.01 },
  { key: 'eyeSize', min: 0.82, max: 1.34, step: 0.01 },
  { key: 'eyeSpacing', min: 0.72, max: EYE_SPACING_RANGE.max, step: 0.01 },
  { key: 'irisScale', min: 0.32, max: 1.02, step: 0.01 },
  { key: 'wateryEyeShape', min: 0.35, max: 1.45, step: 0.01 },
];

const params = {
  seed: randomSeed(),
  pose: 'stretch',
  containerSeed: randomSeed(),
  containerSize: 1,
  containerSoftBody: true,
  containerSoftCollision: false,
  coatId: 'orange',
  eyeColor: '#d99a2b',
  oddEyes: false,
  eyeColorRight: '#5b8fd4',
  headSize: 1.08,
  chubbiness: 1.15,
  legLength: 0.85,
  earSize: 1.0,
  eyeSize: 1.05,
  eyeSpacing: EYE_SPACING_RANGE.default,
  irisScale: 0.65,
  irisHighlightScale: 1,
  wateryEyes: false,
  wateryEyeShape: 1.1,
  tailLength: 0.95,
  tailCurl: 0.35,
  fluffy: false,
  furFluff: 0.9,
  outlineJitter: 0.25,
  dynamicCoat: true,
  dynamicCoatBase: '#f6dfbd',
  dynamicCoatA: '#e6913f',
  dynamicCoatB: '#ad5d22',
  dynamicCoatCount: 12,
  dynamicCoatScale: 1.08,
  dynamicCoatSoftness: 0,
  dynamicCoatIrregularity: 0.72,
  dynamicCoatBodyDensity: 8.2,
  dynamicCoatBodyWidth: 0.24,
  dynamicCoatBodyIrregularity: 0.42,
  dynamicCoatHeadDensity: 18,
  dynamicCoatHeadWidth: 0.2,
  dynamicCoatHeadIrregularity: 0.28,
  motionDebug: false,
  motionStateMachine: true,
  motionAction: 'idle',
  motionSpeed: 1,
  motionIntensity: 1,
};

function applyDynamicCoatPreset(coatId) {
  const preset = COATS.find((coat) => coat.id === coatId)?.soft;
  if (!preset) return;
  params.dynamicCoatBase = preset.base;
  params.dynamicCoatA = preset.colorA;
  params.dynamicCoatB = preset.colorB;
  params.dynamicCoatCount = preset.count ?? 7;
  params.dynamicCoatScale = preset.scale ?? 1;
  params.dynamicCoatSoftness = preset.softness;
  params.dynamicCoatIrregularity = preset.irregularity ?? 0.65;
  params.dynamicCoatBodyDensity = preset.body?.density ?? 8.2;
  params.dynamicCoatBodyWidth = preset.body?.width ?? 0.24;
  params.dynamicCoatBodyIrregularity = preset.body?.irregularity ?? 0.42;
  params.dynamicCoatHeadDensity = preset.head?.density ?? 18;
  params.dynamicCoatHeadWidth = preset.head?.width ?? 0.2;
  params.dynamicCoatHeadIrregularity = preset.head?.irregularity ?? 0.28;
}

// ---------------------------------------------------------------- 场景
const canvas = document.getElementById('scene');
canvas.tabIndex = 0;
canvas.setAttribute('aria-label', '3D 小猫画布');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#efe9dd');
scene.fog = new THREE.Fog('#efe9dd', 14, 32);


const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(2.9, 2.65, 4.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.55;
controls.minDistance = 1.6;
controls.maxDistance = 28;

// Mac trackpads report pinch as ctrl+wheel and two-finger movement as a
// pixel-mode wheel stream. OrbitControls treats both as zoom, so intercept
// those gestures: pinch changes distance while two-finger movement pans.
const macGesturePlatform = /mac/i.test(
  navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent
) || new URLSearchParams(window.location.search).has('mac-gestures');
const gestureOffset = new THREE.Vector3();
const gestureRight = new THREE.Vector3();
const gestureUp = new THREE.Vector3();
let safariGestureStartDistance = camera.position.distanceTo(controls.target);

function setOrbitDistance(distance) {
  gestureOffset.copy(camera.position).sub(controls.target);
  if (gestureOffset.lengthSq() < 1e-8) gestureOffset.set(0, 0, 1);
  gestureOffset.setLength(THREE.MathUtils.clamp(
    distance,
    controls.minDistance,
    controls.maxDistance
  ));
  camera.position.copy(controls.target).add(gestureOffset);
  controls.update();
  canvas.dataset.gestureDistance = gestureOffset.length().toFixed(3);
}

function panOrbitFromTrackpad(deltaX, deltaY) {
  const distance = camera.position.distanceTo(controls.target);
  const worldPerPixel = (
    2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
  ) / Math.max(canvas.clientHeight, 1);
  camera.updateMatrixWorld();
  gestureRight.setFromMatrixColumn(camera.matrixWorld, 0);
  gestureUp.setFromMatrixColumn(camera.matrixWorld, 1);
  gestureOffset
    .set(0, 0, 0)
    .addScaledVector(gestureRight, deltaX * worldPerPixel)
    .addScaledVector(gestureUp, -deltaY * worldPerPixel);
  camera.position.add(gestureOffset);
  controls.target.add(gestureOffset);
  controls.update();
}

function handleMacTrackpadWheel(event) {
  if (!macGesturePlatform || !controls.enabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(canvas.clientHeight, 1)
      : 1;
  if (event.ctrlKey) {
    const zoomFactor = Math.exp(
      THREE.MathUtils.clamp(event.deltaY * unit, -80, 80) * 0.012
    );
    setOrbitDistance(camera.position.distanceTo(controls.target) * zoomFactor);
    canvas.dataset.lastGesture = 'pinch';
    return;
  }
  panOrbitFromTrackpad(
    THREE.MathUtils.clamp(event.deltaX * unit, -160, 160),
    THREE.MathUtils.clamp(event.deltaY * unit, -160, 160)
  );
  canvas.dataset.lastGesture = 'two-finger-pan';
}

canvas.addEventListener('wheel', handleMacTrackpadWheel, {
  capture: true,
  passive: false,
});

canvas.addEventListener('gesturestart', (event) => {
  if (!macGesturePlatform || !controls.enabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  safariGestureStartDistance = camera.position.distanceTo(controls.target);
}, { capture: true, passive: false });

canvas.addEventListener('gesturechange', (event) => {
  if (!macGesturePlatform || !controls.enabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  setOrbitDistance(
    safariGestureStartDistance / THREE.MathUtils.clamp(event.scale, 0.2, 5)
  );
  canvas.dataset.lastGesture = 'safari-pinch';
}, { capture: true, passive: false });

if (macGesturePlatform) {
  canvas.dataset.gestureMode = 'mac-trackpad';
  document.getElementById('viewport-hint').textContent = '拖拽旋转 · 双指平移 · 捏合缩放';
}

// 三灯：暖主光（带软阴影）、冷轮廓光、天光补光
const key = new THREE.DirectionalLight('#fff0da', 2.4);
key.position.set(3.2, 5.5, 4.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -3;
key.shadow.bias = -0.0008;
key.shadow.normalBias = 0.002;
key.shadow.radius = 0;
scene.add(key);

// 二次元二分光：只留一盏主光产生亮/暗两档，环境光均匀提亮暗面（不随法线渐变）
const ambient = new THREE.AmbientLight('#fff2e2', 0.85);
scene.add(ambient);

// 参数化手绘木地板：底色、缝隙、木纹、板宽、木纹密度与方向均可实时调整。
const floorParams = {
  baseColor: '#d9b77f',
  seamColor: '#7d5b3e',
  grainColor: '#9f744d',
  plankWidth: 0.82,
  grainDensity: 0.72,
  direction: 8,
};
const FLOOR_PALETTES = [
  { baseColor: '#d9b77f', seamColor: '#7d5b3e', grainColor: '#9f744d' },
  { baseColor: '#e4b49e', seamColor: '#805548', grainColor: '#b47763' },
  { baseColor: '#e8c7bd', seamColor: '#825b5f', grainColor: '#b48279' },
  { baseColor: '#becbad', seamColor: '#596b51', grainColor: '#7e9270' },
  { baseColor: '#b8c9ca', seamColor: '#53696d', grainColor: '#7d9293' },
  { baseColor: '#c9bfd5', seamColor: '#665973', grainColor: '#8e7f9b' },
  { baseColor: '#e1d0a4', seamColor: '#716047', grainColor: '#9a835b' },
  { baseColor: '#c58c6b', seamColor: '#664636', grainColor: '#925f49' },
];
const floorColorSyncs = [];
const floorSliderSyncs = [];
let floorPaletteSeed = null;

function syncFloorPaletteToSeed(seed) {
  if (floorPaletteSeed === seed) return false;
  floorPaletteSeed = seed;
  const rng = createRng((seed ^ 0x4f19b6d3) >>> 0);
  Object.assign(floorParams, rng.pick(FLOOR_PALETTES));
  drawWoodFloor();
  floorColorSyncs.forEach((control) => control.sync());
  return true;
}

function randomizeWoodFloor() {
  const rng = createRng(randomSeed());
  Object.assign(floorParams, rng.pick(FLOOR_PALETTES), {
    plankWidth: Math.round(rng.range(0.35, 1.6) * 100) / 100,
    grainDensity: Math.round(rng.range(0, 1.5) * 100) / 100,
    direction: Math.round(rng.range(0, 180)),
  });
  // 保留这次独立随机的配色，避免同一只猫后续重建时又被 seed 配色覆盖。
  floorPaletteSeed = params.seed;
  drawWoodFloor();
  floorColorSyncs.forEach((control) => control.sync());
  floorSliderSyncs.forEach((control) => control.sync());
}

function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 2048;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 16);
  tex.userData.canvas = c;
  return tex;
}

const groundTexture = makeGroundTexture();

function drawWoodFloor() {
  const c = groundTexture.userData.canvas;
  const g = c.getContext('2d');
  const size = c.width;
  const pxScale = size / 1024;
  const extent = size * 1.55;
  const plankPx = THREE.MathUtils.clamp(
    floorParams.plankWidth * size / 20,
    22 * pxScale,
    110 * pxScale
  );
  const boardLength = plankPx * 4.1;
  const base = new THREE.Color(floorParams.baseColor);
  const light = base.clone().offsetHSL(0.01, -0.02, 0.035).getStyle();
  const dark = base.clone().offsetHSL(-0.01, 0.025, -0.035).getStyle();
  let woodSeed = 177013;
  const rand = () => {
    woodSeed = (woodSeed * 1664525 + 1013904223) >>> 0;
    return woodSeed / 4294967296;
  };
  const wavyLine = (x0, y0, x1, y1, wobble, steps = 36) => {
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = THREE.MathUtils.lerp(x0, x1, t);
      const y = THREE.MathUtils.lerp(y0, y1, t)
        + Math.sin(t * Math.PI * 4.2 + y0 * 0.017 / pxScale) * wobble
        + Math.sin(t * Math.PI * 9.7 + x0 * 0.011 / pxScale) * wobble * 0.35;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };

  g.clearRect(0, 0, size, size);
  g.fillStyle = floorParams.baseColor;
  g.fillRect(0, 0, size, size);
  g.save();
  g.translate(size / 2, size / 2);
  g.rotate(THREE.MathUtils.degToRad(floorParams.direction));

  const rowStart = -Math.ceil(extent / plankPx / 2);
  const rowEnd = Math.ceil(extent / plankPx / 2);
  for (let row = rowStart; row <= rowEnd; row++) {
    const y = row * plankPx;
    g.fillStyle = row % 2 === 0 ? light : dark;
    g.globalAlpha = 0.32;
    g.fillRect(-extent / 2, y, extent, plankPx);
    g.globalAlpha = 1;

    g.strokeStyle = floorParams.seamColor;
    g.lineWidth = 2.7 * pxScale;
    g.globalAlpha = 0.62;
    wavyLine(-extent / 2, y, extent / 2, y, 1.8 * pxScale, 64);

    const stagger = (Math.abs(row) % 2) * boardLength * 0.47;
    for (let x = -extent / 2 - boardLength + stagger; x < extent / 2; x += boardLength) {
      g.beginPath();
      g.moveTo(x + Math.sin(row * 1.7) * 1.6 * pxScale, y + pxScale);
      g.bezierCurveTo(
        x - 2.5 * pxScale, y + plankPx * 0.3,
        x + 3.5 * pxScale, y + plankPx * 0.7,
        x + Math.cos(row * 1.3) * 1.4 * pxScale, y + plankPx - pxScale
      );
      g.stroke();
    }

    const grainCount = Math.round((extent / (110 * pxScale)) * floorParams.grainDensity);
    g.strokeStyle = floorParams.grainColor;
    g.lineWidth = 1.45 * pxScale;
    g.globalAlpha = 0.28;
    for (let i = 0; i < grainCount; i++) {
      const x = rand() * extent - extent / 2;
      const gy = y + plankPx * (0.18 + rand() * 0.64);
      const len = plankPx * (1.4 + rand() * 3.8);
      g.beginPath();
      g.moveTo(x, gy);
      g.bezierCurveTo(
        x + len * 0.3, gy + (rand() - 0.5) * 7 * pxScale,
        x + len * 0.72, gy + (rand() - 0.5) * 7 * pxScale,
        x + len, gy + (rand() - 0.5) * 3 * pxScale
      );
      g.stroke();
    }

    if (row % 3 === 0) {
      const knotX = (rand() - 0.5) * extent;
      const knotY = y + plankPx * (0.3 + rand() * 0.4);
      g.globalAlpha = 0.22;
      g.beginPath();
      g.ellipse(knotX, knotY, plankPx * 0.28, plankPx * 0.11, 0.12, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.ellipse(knotX, knotY, plankPx * 0.14, plankPx * 0.05, 0.12, 0, Math.PI * 2);
      g.stroke();
    }
  }

  g.globalAlpha = 1;
  g.restore();
  groundTexture.needsUpdate = true;
}

syncFloorPaletteToSeed(params.seed);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(10, 48),
  new THREE.MeshBasicMaterial({ map: groundTexture })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// 猫与木地板之间的程序化地毯：款式和配色由 seed 稳定决定。
const rugLayer = createRugLayer(scene);
const rugState = {
  enabled: true,
  seed: params.seed,
};

// 影子底色：完整承接投影，避免只有排线时猫脚下出现视觉空洞
const blockShadowMat = new THREE.ShadowMaterial({ color: '#9e8a70', opacity: 0.38 });
const blockShadowPlane = new THREE.Mesh(new THREE.CircleGeometry(10, 48), blockShadowMat);
blockShadowPlane.rotation.x = -Math.PI / 2;
blockShadowPlane.position.y = 0.003;
blockShadowPlane.renderOrder = 2;
blockShadowPlane.receiveShadow = true;
scene.add(blockShadowPlane);

// 素描排线影子：叠在底色色块上，可独立调色
const sketchShadowMat = new THREE.ShadowMaterial({ color: '#5f4d3e', opacity: 0.58 });
sketchShadowMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, hatchUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vHatchPos;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHatchPos = worldPosition.xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vHatchPos;
       uniform float uHatchFreq;
       uniform float uHatchWidth;
       uniform float uHatchJitter;
       uniform int uHatchStyle;
       uniform float uHatchAngle;
       uniform float uHatchDashStretch;
       ${HATCH_GLSL}`
    )
    .replace(
      'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
      `float mask = step(0.5, 1.0 - getShadowMask());
       vec2 q = uHatchScreen == 1
         ? gl_FragCoord.xy * uScreenScale
         : vec2(vHatchPos.x, vHatchPos.z);
       float line = hatchPatternF(
         q,
         uHatchFreq,
         uHatchWidth,
         uHatchJitter,
         uHatchAngle,
         uHatchStyle,
         uHatchDashStretch
       );
       gl_FragColor = vec4( color, opacity * mask * line );`
    );
};
const hatchShadowPlane = new THREE.Mesh(new THREE.CircleGeometry(10, 48), sketchShadowMat);
hatchShadowPlane.rotation.x = -Math.PI / 2;
hatchShadowPlane.position.y = 0.004;
hatchShadowPlane.renderOrder = 2;
hatchShadowPlane.receiveShadow = true;
scene.add(hatchShadowPlane);

// ---------------------------------------------------------------- 重建
let cat = null;
let motionRig = null;
const motionMachine = createCatMotionStateMachine();
let motionMachineFrame = motionMachine.getState();
let motionElapsed = 0;
let motionWasEnabled = false;
let lastMotionAction = params.motionAction;
let motionStatusEl = null;
let staticPoseBeforeMotion = params.pose;
let rebuildTimer = 0;

function syncRugPlacement() {
  if (!cat) return;
  rugLayer.fitToCat(cat);
}

function disposeCat() {
  if (!cat) return;
  motionRig?.reset();
  motionRig = null;
  scene.remove(cat);
  cat.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
  cat = null;
}

function rebuild(quality = 'full') {
  const rebuildStartedAt = performance.now();
  speechBubbles.hide();
  syncFloorPaletteToSeed(params.seed);
  resetContainerJiggle();
  disposeCat();
  let container = null;
  if (params.pose === 'containerCrouch' && !params.motionDebug) {
    const fittedCatScale = Math.max(
      Math.sqrt(params.chubbiness) * 1.02,
      params.headSize * 0.76,
      1.14
    );
    const fitScale = fittedCatScale * params.containerSize;
    container = createContainer(params.containerSeed, { fitScale });
  }
  const containerDescriptor = container?.userData.container ?? null;
  const catBuildParams = containerDescriptor
    ? {
        ...params,
        containerId: containerDescriptor.id,
        containerScale: containerDescriptor.heightScale,
        containerRimY: containerDescriptor.rimY,
        containerOpeningShape: containerDescriptor.openingShape,
        containerOpeningWidth: containerDescriptor.openingWidth,
        containerOpeningDepth: containerDescriptor.openingDepth,
        containerOffsetZ: containerDescriptor.offsetZ,
      }
    : params;
  cat = buildCat(catBuildParams, quality);
  if (container) {
    const containerContents = new THREE.Group();
    containerContents.name = 'containerContents';
    while (cat.children.length) containerContents.add(cat.children[0]);
    cat.add(containerContents, container);
    cat.userData.containerContents = containerContents;
    cat.userData.containerObject = container;
    cat.userData.container = container.userData.container;
    resetContainerJiggle();
  }
  if (thunderFluffTimer > 0) syncThunderFluffVisual();
  scene.add(cat);
  motionRig = params.motionDebug
    ? createMesh2MotionSkinRig(cat, 'standing')
    : null;
  const rugChanged = rugLayer.setSeed(rugState.seed);
  rugLayer.setVisible(rugState.enabled);
  syncRugPlacement();
  toyWorld.setCatColliders(cat.userData.colliders);
  if (rugChanged) toyWorld.scatterAroundRug(rugLayer.getBounds(), rugState.seed);
  const viewportEl = document.getElementById('viewport');
  viewportEl.dataset.lastRebuildMs = (performance.now() - rebuildStartedAt).toFixed(1);
  viewportEl.dataset.lastRebuildQuality = quality;
  viewportEl.dataset.lastRebuildMotion = String(!!params.motionDebug);
  viewportEl.dataset.catPose = params.pose;
  viewportEl.dataset.catCoat = params.coatId;
  const rebuiltFurGeometry = cat.getObjectByName('fur')?.geometry;
  viewportEl.dataset.meshCellSize = Number(
    rebuiltFurGeometry?.userData?.meshCellSize ?? 0
  ).toFixed(4);
  viewportEl.dataset.meshVertexCount = String(
    rebuiltFurGeometry?.getAttribute('position')?.count ?? 0
  );
  viewportEl.dataset.meshMode = rebuiltFurGeometry?.userData?.meshMode ?? 'unknown';
  viewportEl.dataset.meshBuildMs = Number(cat.userData.buildTimings?.meshMs ?? 0).toFixed(1);
  viewportEl.dataset.vertexBuildMs = Number(
    cat.userData.buildTimings?.vertexDataMs ?? 0
  ).toFixed(1);
  viewportEl.dataset.detailBuildMs = Number(
    cat.userData.buildTimings?.detailsMs ?? 0
  ).toFixed(1);
}

function updateDynamicCoat() {
  cat?.userData.updateDynamicCoat?.(params);
}

// 拖动滑杆时用草稿分辨率，松手后高清重建
function rebuildDraftThenFull() {
  rebuild('draft');
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild('full'), 260);
}

function resize() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
let viewportResizeFrame = 0;
const viewportResizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(viewportResizeFrame);
  viewportResizeFrame = requestAnimationFrame(resize);
});
viewportResizeObserver.observe(document.getElementById('viewport'));

// ---------------------------------------------------------------- 玩具物理世界
const toyWorld = createToyWorld(scene);
const fishRain = createFishRain(scene, toyWorld.world);
const rainField = createRainField(scene);
const cloudField = createCloudField(scene);
const weatherAudio = createWeatherAudio();
const speechBubbles = createSpeechBubbleController({
  element: document.getElementById('scene-speech-bubble'),
  viewport: document.getElementById('viewport'),
  camera,
  getCat: () => cat,
  getToys: () => toyWorld.toys,
  getLocale: () => i18n.locale,
  getWeather: () => {
    const viewportEl = document.getElementById('viewport');
    return {
      mode: viewportEl.dataset.weather ?? 'sunny',
      thunder: viewportEl.dataset.thunder === 'true',
    };
  },
});
window.__speechBubbles = speechBubbles;
window.addEventListener('meow:speech', (event) => {
  speechBubbles.showNow(event.detail?.role ?? '');
});

// ---------------------------------------------------------------- 软体抓捏交互
// 只有三个可交互区（其余部位按了没反应，镜头照常旋转）：
//   捏脸颊 / 捏屁股：左右扯（限幅），松手弹回
//   提后颈：整猫被拎起来，松手落回
// 玩具：抓住拖拽，甩出去摔（刚体物理）
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const eyeGazeTarget = new THREE.Vector2();
const eyeGazeCurrent = new THREE.Vector2();
const grab = {
  id: -1,
  pointerId: -1,
  mode: null,          // 'poke' | 'cheek' | 'butt' | 'lift' | 'toy' | 'container'
  anchor: new THREE.Vector3(),   // 世界坐标锚点
  planeNormal: new THREE.Vector3(),
  startDrag: new THREE.Vector3(),
};
const ruaLocalPoint = new THREE.Vector3();
const ruaLocalTip = new THREE.Vector3();
const ruaLocalDirection = new THREE.Vector3();
const ruaStroke = {
  lastX: 0,
  lastY: 0,
  lastAt: -Infinity,
  hits: 0,
};
// 提脖子：整猫位移的弹簧状态
const lift = { y: 0, vel: 0, holding: false, target: 0 };
const containerJiggle = {
  holding: false,
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
  startPosition: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  previousPosition: new THREE.Vector3(),
  contentOffset: new THREE.Vector3(),
  contentVelocity: new THREE.Vector3(),
  lagTarget: new THREE.Vector3(),
};
const containerSpringDelta = new THREE.Vector3();
// 接触描边安全间隙：只抬升猫的视觉根节点，不改变碰撞、阴影接地点或抓捏参数。
// 当前默认机位下 0.01 世界单位约等于 1–2 个屏幕像素。
const CAT_VISUAL_CONTACT_LIFT = 0.01;
const motionCameraOffset = new THREE.Vector2();

function resetContainerJiggle() {
  containerJiggle.holding = false;
  containerJiggle.position.set(0, 0, 0);
  containerJiggle.target.set(0, 0, 0);
  containerJiggle.startPosition.set(0, 0, 0);
  containerJiggle.velocity.set(0, 0, 0);
  containerJiggle.previousPosition.set(0, 0, 0);
  containerJiggle.contentOffset.set(0, 0, 0);
  containerJiggle.contentVelocity.set(0, 0, 0);
  containerJiggle.lagTarget.set(0, 0, 0);
  const contents = cat?.userData.containerContents;
  if (contents) {
    contents.position.set(0, 0, 0);
    contents.rotation.set(0, 0, 0);
    contents.scale.set(1, 1, 1);
  }
  toyWorld?.setCatTransform?.(0, 0, 0);
}

function containerJiggleEnabled() {
  return !!(
    params.containerSoftCollision
    && params.pose === 'containerCrouch'
    && !params.motionDebug
    && cat?.userData.containerObject
  );
}

function updateContainerJiggle(dt) {
  const enabled = containerJiggleEnabled();
  const contents = cat?.userData.containerContents;
  if (!enabled || !contents) {
    if (
      containerJiggle.position.lengthSq() > 1e-8
      || containerJiggle.contentOffset.lengthSq() > 1e-8
    ) resetContainerJiggle();
    const viewportEl = document.getElementById('viewport');
    viewportEl.dataset.containerJiggleEnabled = 'false';
    viewportEl.dataset.containerJiggleDragging = 'false';
    viewportEl.dataset.containerJiggleY = '0.0000';
    viewportEl.dataset.containerJiggleOffset = '0.0000';
    return;
  }

  containerJiggle.previousPosition.copy(containerJiggle.position);
  if (containerJiggle.holding) {
    const follow = 1 - Math.exp(-dt * 18);
    containerJiggle.position.lerp(containerJiggle.target, follow);
    containerJiggle.velocity
      .copy(containerJiggle.position)
      .sub(containerJiggle.previousPosition)
      .multiplyScalar(1 / Math.max(dt, 1e-4));
  } else {
    containerJiggle.velocity.y -= 7.6 * dt;
    containerJiggle.position.addScaledVector(containerJiggle.velocity, dt);
    const horizontalDrag = Math.exp(-dt * 8.5);
    containerJiggle.velocity.x *= horizontalDrag;
    containerJiggle.velocity.z *= horizontalDrag;
    if (containerJiggle.position.y < 0) {
      containerJiggle.position.y = 0;
      if (containerJiggle.velocity.y < -0.08) containerJiggle.velocity.y *= -0.32;
      else containerJiggle.velocity.y = 0;
    }
    containerJiggle.position.x = THREE.MathUtils.clamp(containerJiggle.position.x, -3.4, 3.4);
    containerJiggle.position.z = THREE.MathUtils.clamp(containerJiggle.position.z, -3.4, 3.4);
  }

  containerJiggle.lagTarget.set(
    THREE.MathUtils.clamp(-containerJiggle.velocity.x * 0.025, -0.13, 0.13),
    THREE.MathUtils.clamp(-containerJiggle.velocity.y * 0.018, -0.12, 0.11),
    THREE.MathUtils.clamp(-containerJiggle.velocity.z * 0.025, -0.13, 0.13)
  );
  const spring = 2 * Math.PI * 5.2;
  containerJiggle.contentVelocity.addScaledVector(
    containerSpringDelta.copy(containerJiggle.lagTarget).sub(containerJiggle.contentOffset),
    spring * spring * dt
  );
  containerJiggle.contentVelocity.addScaledVector(
    containerJiggle.contentVelocity,
    -2 * 0.48 * spring * dt
  );
  containerJiggle.contentOffset.addScaledVector(containerJiggle.contentVelocity, dt);
  if (containerJiggle.contentOffset.length() > 0.17) {
    containerJiggle.contentOffset.setLength(0.17);
  }

  contents.position.copy(containerJiggle.contentOffset);
  contents.rotation.set(
    THREE.MathUtils.clamp(-containerJiggle.contentOffset.z * 0.42, -0.075, 0.075),
    0,
    THREE.MathUtils.clamp(containerJiggle.contentOffset.x * 0.42, -0.075, 0.075)
  );
  const wobble = THREE.MathUtils.clamp(
    containerJiggle.contentOffset.length() * 0.62
      + Math.abs(containerJiggle.velocity.y) * 0.008,
    0,
    0.13
  );
  contents.scale.set(1 + wobble * 0.48, 1 - wobble, 1 + wobble * 0.38);

  const viewportEl = document.getElementById('viewport');
  viewportEl.dataset.containerJiggleEnabled = 'true';
  viewportEl.dataset.containerJiggleDragging = String(containerJiggle.holding);
  viewportEl.dataset.containerJiggleY = containerJiggle.position.y.toFixed(4);
  viewportEl.dataset.containerJiggleOffset = containerJiggle.contentOffset.length().toFixed(4);
}

function followMotionCamera(x, z, dt) {
  const factor = 1 - Math.exp(-dt * 5.5);
  const dx = (x - motionCameraOffset.x) * factor;
  const dz = (z - motionCameraOffset.y) * factor;
  motionCameraOffset.x += dx;
  motionCameraOffset.y += dz;
  controls.target.x += dx;
  controls.target.z += dz;
  camera.position.x += dx;
  camera.position.z += dz;
}

function resetMotionWorld() {
  motionMachine.reset();
  motionMachineFrame = motionMachine.getState();
  motionElapsed = 0;
  lastMotionAction = 'idle';
  params.motionAction = 'idle';
  if (motionCameraOffset.lengthSq() > 1e-8) {
    controls.target.x -= motionCameraOffset.x;
    controls.target.z -= motionCameraOffset.y;
    camera.position.x -= motionCameraOffset.x;
    camera.position.z -= motionCameraOffset.y;
    motionCameraOffset.set(0, 0);
  }
  toyWorld.setCatTransform?.(0, 0, 0);
}

function isFormControlTarget(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)
  );
}

function normalizedMotionCode(event) {
  if (event.code && isMotionControlCode(event.code)) return event.code;
  const key = String(event.key ?? '').toLowerCase();
  const fallback = {
    w: 'KeyW', s: 'KeyS', a: 'KeyA', d: 'KeyD',
    q: 'KeyQ', e: 'KeyE', f: 'KeyF', h: 'KeyH',
    g: 'KeyG', k: 'KeyK', c: 'KeyC', z: 'KeyZ', x: 'KeyX',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    shift: 'ShiftLeft', control: 'ControlLeft',
    ' ': 'Space', spacebar: 'Space',
  };
  return fallback[key] ?? event.code;
}

document.addEventListener('keydown', (event) => {
  document.getElementById('viewport').dataset.lastKeyDown = `${event.key ?? ''}:${event.code ?? ''}`;
  if (!params.motionDebug || !params.motionStateMachine) return;
  if (isFormControlTarget(event.target)) return;
  const code = normalizedMotionCode(event);
  if (!isMotionControlCode(code)) return;
  event.preventDefault();
  motionMachine.setKey(code, true);
  if (!event.repeat && motionMachine.triggerCode(code)) {
    motionElapsed = 0;
  }
}, true);
document.addEventListener('keyup', (event) => {
  document.getElementById('viewport').dataset.lastKeyUp = `${event.key ?? ''}:${event.code ?? ''}`;
  const code = normalizedMotionCode(event);
  if (!isMotionControlCode(code)) return;
  motionMachine.setKey(code, false);
}, true);
window.addEventListener('blur', () => motionMachine.clearKeys());

function updatePointerNdc(e) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}

function updateEyeGazeTarget(e) {
  const rect = canvas.getBoundingClientRect();
  eyeGazeTarget.set(
    THREE.MathUtils.clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
    THREE.MathUtils.clamp(-((e.clientY - rect.top) / rect.height) * 2 + 1, -1, 1)
  );
}
window.addEventListener('pointermove', updateEyeGazeTarget, { passive: true });
document.documentElement.addEventListener('mouseleave', () => eyeGazeTarget.set(0, 0));

function pickCat(e) {
  updatePointerNdc(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const fur = cat?.getObjectByName('fur');
  if (!fur) return null;
  const hit = raycaster.intersectObject(fur, false)[0];
  return hit ? { point: hit.point, dir: raycaster.ray.direction.clone() } : null;
}

function pulseCatAtHit(hit, strength = 1) {
  if (!cat || !hit) return -1;
  cat.worldToLocal(ruaLocalPoint.copy(hit.point));
  cat.worldToLocal(ruaLocalTip.copy(hit.point).add(hit.dir));
  ruaLocalDirection.copy(ruaLocalTip).sub(ruaLocalPoint).normalize();
  const id = pulsePoke(ruaLocalPoint, ruaLocalDirection, strength);
  ruaStroke.hits += 1;
  document.getElementById('viewport').dataset.ruaHits = String(ruaStroke.hits);
  return id;
}

function beginRuaStroke(e, hit) {
  ruaStroke.lastX = e.clientX;
  ruaStroke.lastY = e.clientY;
  ruaStroke.lastAt = performance.now();
  pulseCatAtHit(hit, 1);
}

function continueRuaStroke(e) {
  const now = performance.now();
  const distance = Math.hypot(e.clientX - ruaStroke.lastX, e.clientY - ruaStroke.lastY);
  const elapsed = now - ruaStroke.lastAt;
  if (distance < 4 || (elapsed < 14 && distance < 10)) return;
  const hit = pickCat(e);
  if (!hit) return;
  const strength = THREE.MathUtils.clamp(
    0.82 + distance / 22 + Math.max(0, 50 - elapsed) / 125,
    0.8,
    1.55
  );
  pulseCatAtHit(hit, strength);
  ruaStroke.lastX = e.clientX;
  ruaStroke.lastY = e.clientY;
  ruaStroke.lastAt = now;
}

function pickToy(e) {
  updatePointerNdc(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(toyWorld.group.children, true);
  for (const hit of hits) {
    let root = hit.object;
    while (root.parent && root.parent !== toyWorld.group) root = root.parent;
    const toy = toyWorld.toys.find((t) => t.mesh === root);
    if (!toy) continue;
    if (toy.kind === 'fish' && hit.object.userData.toyPickSurface !== true) continue;
    return { toy, point: hit.point };
  }
  return null;
}

function pickContainer(e) {
  if (!containerJiggleEnabled()) return null;
  updatePointerNdc(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const container = cat?.userData.containerObject;
  const hit = container ? raycaster.intersectObject(container, true)[0] : null;
  return hit ? { object: container, point: hit.point } : null;
}

// 把鼠标射线投到过锚点、面向相机的平面上（拖拽的世界坐标）
function dragPointOnPlane(e, out) {
  updatePointerNdc(e);
  raycaster.setFromCamera(pointerNdc, camera);
  const denom = raycaster.ray.direction.dot(grab.planeNormal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = grab.anchor.clone().sub(raycaster.ray.origin).dot(grab.planeNormal) / denom;
  return out.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, t);
}

// 命中点在猫身上属于哪个交互区；不在可交互区返回 null
function grabZone(hitPoint) {
  const { headC, hr, buttC } = cat.userData;
  const p = cat.worldToLocal(hitPoint.clone());
  const dx = p.x - headC.x, dy = p.y - headC.y, dz = p.z - headC.z;
  // 后颈：头后方偏上
  if (dz < -hr * 0.2 && dy > -hr * 0.15 && Math.abs(dx) < hr * 0.75) return 'lift';
  // 脸颊：头前半、两侧、眼睛以下附近
  if (dz > hr * 0.15 && Math.abs(dx) > hr * 0.22 && dy < hr * 0.35 && dy > -hr * 0.85) return 'cheek';
  // 屁股：身体后端附近
  if (buttC && p.distanceTo(buttC) < hr * 1.05 && p.z < buttC.z + hr * 0.55) return 'butt';
  return null;
}

const _drag = new THREE.Vector3();
const _off = new THREE.Vector3();
const activeCanvasTouches = new Set();
const TOUCH_TOY_DRAG_THRESHOLD = 10;
const FISH_GRAB_HOLD_MS = 90;
const FISH_GRAB_CANCEL_DISTANCE = 12;
let pendingToyPointer = null;

function beginInteractiveGrab(e, { toyHit = null, containerHit = null, catHit = null, zone = null }) {
  grab.anchor.copy((toyHit ?? containerHit ?? catHit).point);
  grab.planeNormal.copy(camera.position).sub(grab.anchor).normalize();
  grab.pointerId = e.pointerId;
  controls.enabled = false;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  canvas.style.cursor = 'grabbing';
  dragPointOnPlane(e, grab.startDrag);

  if (toyHit) {
    grab.mode = 'toy';
    toyWorld.grabToy(toyHit.toy, toyHit.point);
    return;
  }
  if (containerHit) {
    grab.mode = 'container';
    containerJiggle.holding = true;
    containerJiggle.startPosition.copy(containerJiggle.position);
    containerJiggle.target.copy(containerJiggle.position);
    viewport.dataset.containerJigglePointer = 'down';
    return;
  }
  beginRuaStroke(e, catHit);
  if (zone === 'poke') {
    grab.mode = 'poke';
    grab.id = -1;
    return;
  }
  grab.mode = zone;
  grab.id = beginGrab(cat.worldToLocal(catHit.point.clone()));
  if (zone === 'lift') lift.holding = true;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.pointerType === 'touch') {
    activeCanvasTouches.add(e.pointerId);
    if (activeCanvasTouches.size > 1) {
      pendingToyPointer = null;
      releaseGrab();
      return;
    }
  }
  // 玩具优先
  const toyHit = pickToy(e);
  const containerHit = toyHit ? null : pickContainer(e);
  const catHit = toyHit || containerHit ? null : pickCat(e);
  const zone = catHit ? (grabZone(catHit.point) ?? 'poke') : null;
  if (!toyHit && !containerHit && !zone) return; // 落在不可交互区：交给镜头

  // 已命中交互物时截断 OrbitControls，避免抓鱼或捏猫被识别成旋转镜头。
  e.preventDefault();
  e.stopImmediatePropagation();

  // 触屏玩具等待一次明确拖动；鱼只在触屏上保留很短的防误触等待。
  // 鼠标点中鱼后立即抓取，减少小物件与镜头操作之间的争抢。
  if (toyHit && e.pointerType === 'touch') {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    pendingToyPointer = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY,
      startedAt: performance.now(),
      requiresHold: toyHit.toy.kind === 'fish',
      toyHit,
    };
    return;
  }
  beginInteractiveGrab(e, { toyHit, containerHit, catHit, zone });
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (pendingToyPointer?.pointerId === e.pointerId) {
    if (activeCanvasTouches.size > 1) {
      pendingToyPointer = null;
      return;
    }
    const distance = Math.hypot(
      e.clientX - pendingToyPointer.clientX,
      e.clientY - pendingToyPointer.clientY
    );
    if (pendingToyPointer.requiresHold) {
      if (performance.now() - pendingToyPointer.startedAt < FISH_GRAB_HOLD_MS) {
        if (distance > FISH_GRAB_CANCEL_DISTANCE) pendingToyPointer = null;
        return;
      }
      const fishThreshold = 8;
      if (distance < fishThreshold) return;
    } else if (distance < TOUCH_TOY_DRAG_THRESHOLD) {
      return;
    }
    const toyHit = pendingToyPointer.toyHit;
    pendingToyPointer = null;
    beginInteractiveGrab(e, { toyHit });
  }
  if (grab.mode === null) {
    if (!e.buttons) {
      const t = pickToy(e);
      const n = !t && pickContainer(e);
      const c = !t && !n && pickCat(e);
      canvas.style.cursor = t || n || c ? 'grab' : '';
    }
    return;
  }
  if (grab.pointerId >= 0 && e.pointerId !== grab.pointerId) return;
  if (
    grab.mode === 'poke'
    || grab.mode === 'cheek'
    || grab.mode === 'butt'
    || grab.mode === 'lift'
  ) {
    continueRuaStroke(e);
    if (grab.mode === 'poke') return;
  }
  if (!dragPointOnPlane(e, _drag)) return;

  if (grab.mode === 'toy') {
    toyWorld.moveGrab(_drag);
    return;
  }
  _off.copy(_drag).sub(grab.startDrag);
  if (grab.mode === 'container') {
    containerJiggle.target
      .copy(containerJiggle.startPosition)
      .add(_off);
    containerJiggle.target.x = THREE.MathUtils.clamp(containerJiggle.target.x, -3.4, 3.4);
    containerJiggle.target.y = THREE.MathUtils.clamp(containerJiggle.target.y, 0, 2.4);
    containerJiggle.target.z = THREE.MathUtils.clamp(containerJiggle.target.z, -3.4, 3.4);
    // Pointer events may arrive faster than the render loop (automation and
    // quick flicks in particular). Move partway toward the target here so even
    // a one-frame lift produces a visible airborne drop and internal wobble.
    containerJiggle.position.lerp(containerJiggle.target, 0.62);
    viewport.dataset.containerJigglePointer = 'move';
    viewport.dataset.containerJiggleTargetY = containerJiggle.target.y.toFixed(4);
    return;
  }
  const hr = cat.userData.hr;

  if (grab.mode === 'cheek' || grab.mode === 'butt') {
    // 只允许横向为主的拉扯；限幅防止扯得夸张
    _off.z *= grab.mode === 'butt' ? 0.4 : 0.25;
    _off.y *= 0.55;
    const maxStretch = hr * 0.5;
    if (_off.length() > maxStretch) _off.setLength(maxStretch);
    setGrabTarget(grab.id, _off);
  } else if (grab.mode === 'lift') {
    // 只取向上分量提起整猫；皮肤在后颈处再多提一点（被拎住的褶皱感）
    lift.target = THREE.MathUtils.clamp(_off.y, 0, 0.55);
    setGrabTarget(grab.id, _off.set(0, lift.target * 0.22, 0));
  }
}, { capture: true });

function releaseGrab() {
  if (grab.mode === null) return;
  if (grab.mode === 'toy') toyWorld.releaseGrab();
  if (grab.mode === 'container') {
    containerJiggle.holding = false;
    viewport.dataset.containerJigglePointer = 'released';
  }
  if (grab.id >= 0) endGrab(grab.id);
  grab.id = -1;
  grab.pointerId = -1;
  grab.mode = null;
  lift.holding = false;
  controls.enabled = true;
  canvas.style.cursor = '';
}

function finishCanvasPointer(e) {
  if (e.pointerType === 'touch') activeCanvasTouches.delete(e.pointerId);
  if (pendingToyPointer?.pointerId === e.pointerId) pendingToyPointer = null;
  if (grab.pointerId === e.pointerId || (e.pointerType !== 'touch' && grab.mode !== null)) {
    releaseGrab();
  }
}

canvas.addEventListener('pointerup', finishCanvasPointer, { capture: true });
canvas.addEventListener('pointercancel', finishCanvasPointer, { capture: true });

// 五官小件跟随表面形变（refPos 是建模坐标，与 uniform 锚点同空间）
const _pokeOff = new THREE.Vector3();
const _refN = new THREE.Vector3();
function syncFaceToPokes() {
  const face = cat?.getObjectByName('face');
  if (!face) return;
  const headC = cat.userData.headC;
  for (const child of face.children) {
    if (child.userData.skipPokeSync) continue;
    if (!child.userData.basePos) continue;
    // 小件外法线 ≈ 从头心指向小件（用于挤出环项，避免被环挤压时陷进皮肤）
    _refN.copy(child.userData.refPos).sub(headC).normalize();
    pokeOffsetAt(child.userData.refPos, _refN, _pokeOff);
    child.position.copy(child.userData.basePos).add(_pokeOff);
  }
}

let softWasActive = false;
function stepSim(dt) {
  updatePokes(dt);
  toyWorld.step(dt);
  fishRain.update(dt);

  // 整猫提起（跟手）与松手落回（欠阻尼弹簧 + 落地截断）
  if (lift.holding) {
    lift.y += (lift.target - lift.y) * Math.min(1, dt * 14);
    lift.vel = 0;
  } else if (lift.y > 1e-4 || Math.abs(lift.vel) > 1e-3) {
    const w = 2 * Math.PI * 3.2;
    lift.vel += (-w * w * lift.y - 2 * 0.35 * w * lift.vel) * dt;
    lift.y += lift.vel * dt;
    if (lift.y < 0) { lift.y = 0; lift.vel *= -0.25; } // 落地小弹跳
  } else {
    lift.y = 0;
  }
  updateContainerJiggle(dt);
  let motionState = null;
  let activeMotionAction = params.motionAction;
  let worldX = 0;
  let worldZ = 0;
  let worldHeading = 0;
  let travelDirection = 1;
  if (cat && motionRig && params.motionDebug) {
    if (params.motionStateMachine) {
      motionMachineFrame = motionMachine.update(dt, { speedScale: params.motionSpeed });
      activeMotionAction = motionMachineFrame.action;
      worldX = motionMachineFrame.position.x;
      worldZ = motionMachineFrame.position.z;
      worldHeading = motionMachineFrame.heading;
      travelDirection = motionMachineFrame.travelDirection;
      if (activeMotionAction !== lastMotionAction) {
        motionElapsed = 0;
        lastMotionAction = activeMotionAction;
        params.motionAction = activeMotionAction;
        if (motionSelect?.select) motionSelect.select.value = activeMotionAction;
      }
    } else {
      lastMotionAction = params.motionAction;
    }
    motionElapsed += dt;
    motionState = motionRig.update(motionElapsed, {
      actionId: activeMotionAction,
      speed: params.motionSpeed,
      intensity: params.motionIntensity,
      travelDirection,
    });
    motionWasEnabled = true;
  } else if (cat && motionRig && motionWasEnabled) {
    motionRig.reset();
    motionWasEnabled = false;
    resetMotionWorld();
  }
  if (cat) {
    const rootX = motionState?.rootX ?? 0;
    const rootZ = motionState?.rootZ ?? 0;
    const c = Math.cos(worldHeading);
    const s = Math.sin(worldHeading);
    cat.position.set(
      worldX + rootX * c + rootZ * s + containerJiggle.position.x,
      lift.y + CAT_VISUAL_CONTACT_LIFT
        + (cat.userData.animationRootLift ?? 0)
        + containerJiggle.position.y,
      worldZ - rootX * s + rootZ * c + containerJiggle.position.z
    );
    if (containerJiggleEnabled()) {
      toyWorld.setCatTransform?.(
        containerJiggle.position.x,
        containerJiggle.position.z,
        0
      );
    }
    if (motionState) {
      cat.rotation.set(
        motionState.rootPitch,
        worldHeading + motionState.rootYaw,
        motionState.rootRoll
      );
    }
    if (params.motionDebug && params.motionStateMachine) {
      toyWorld.setCatTransform?.(worldX, worldZ, worldHeading);
      followMotionCamera(worldX, worldZ, dt);
    }
    const viewportEl = document.getElementById('viewport');
    viewportEl.dataset.motionEnabled = String(!!params.motionDebug);
    viewportEl.dataset.motionStateMachine = String(!!params.motionStateMachine);
    viewportEl.dataset.motionAction = activeMotionAction;
    viewportEl.dataset.motionCompatibility = motionState?.compatibility?.grade
      ?? getRigCompatibility('standing', activeMotionAction).grade;
    viewportEl.dataset.motionBindingPose = params.motionDebug ? 'standing' : params.pose;
    viewportEl.dataset.motionSourceFrame = (motionState?.retarget?.sourceFrame ?? 0).toFixed(2);
    viewportEl.dataset.motionPhase = (motionState?.phase ?? 0).toFixed(4);
    viewportEl.dataset.motionRootLift = (cat.userData.animationRootLift ?? 0).toFixed(4);
    viewportEl.dataset.motionHeadLift = (motionState?.headLift ?? 0).toFixed(4);
    viewportEl.dataset.motionGait = (motionState?.gaitAmplitude ?? 0).toFixed(4);
    viewportEl.dataset.motionTravelDirection = String(travelDirection);
    viewportEl.dataset.motionX = worldX.toFixed(4);
    viewportEl.dataset.motionZ = worldZ.toFixed(4);
    viewportEl.dataset.motionHeading = worldHeading.toFixed(4);
    viewportEl.dataset.motionKeys = motionMachineFrame.keys?.join(',') ?? '';
    viewportEl.dataset.motionVertexCount = String(
      cat.getObjectByName('fur')?.geometry?.getAttribute('position')?.count ?? 0
    );
    const motionGeometryQuality = motionRig?.getDiagnostics?.();
    viewportEl.dataset.motionTriangles = String(motionGeometryQuality?.triangles ?? 0);
    viewportEl.dataset.motionDegenerate = String(motionGeometryQuality?.degenerate ?? 0);
    viewportEl.dataset.motionFlipped = String(motionGeometryQuality?.flipped ?? 0);
    viewportEl.dataset.motionMaxStretch = String(motionGeometryQuality?.maxStretch ?? 1);
    viewportEl.dataset.motionMaxStretchRegion = motionGeometryQuality?.maxStretchRegion ?? 'none';
    viewportEl.dataset.motionLegSafety = (motionState?.rigSafety?.leg ?? 1).toFixed(3);
    viewportEl.dataset.motionTailSafety = (motionState?.rigSafety?.tail ?? 1).toFixed(3);
    viewportEl.dataset.motionBoneLengthError = String(motionState?.boneLengthError ?? 0);
    viewportEl.dataset.motionButtVisible = String(!!motionState?.buttVisible);
    viewportEl.dataset.motionRigType = motionRig?.type ?? 'none';
    const motionWeightStats = motionRig?.getWeightStats?.();
    viewportEl.dataset.motionSkinBones = String(motionRig?.skeleton?.bones?.length ?? 0);
    viewportEl.dataset.motionSkinMaxInfluences = String(motionWeightStats?.maxInfluences ?? 0);
    viewportEl.dataset.motionSkinBonesUsed = String(motionWeightStats?.bonesUsed ?? 0);
    viewportEl.dataset.motionSkinInvalidWeights = String(motionWeightStats?.invalidWeights ?? 0);
    viewportEl.dataset.motionSkinWeightError = String(motionWeightStats?.maxWeightError ?? 0);
    if (motionStatusEl) {
      const compatibility = motionState?.compatibility
        ?? getRigCompatibility('standing', activeMotionAction);
      const actionMeta = MESH2MOTION_ACTIONS.find((item) => item.id === activeMotionAction);
      const frameLabel = motionState?.retarget?.sourceFrame != null
        ? ` · 源帧 ${motionState.retarget.sourceFrame.toFixed(1)}`
        : '';
      motionStatusEl.textContent = `${actionMeta?.name ?? activeMotionAction}${frameLabel} · 固定网格 · 19 骨骼蒙皮`;
      motionStatusEl.dataset.grade = compatibility.grade;
    }
  }

  const softActive = anyPokeActive();
  if (softActive || softWasActive) syncFaceToPokes(); // 多同步一帧保证复位归零
  softWasActive = softActive;
}

// 屏幕对齐模式的排线坐标缩放：跟随渲染缓冲高度，保证不同窗口/截图尺寸下密度一致
const _dbSize = new THREE.Vector2();
function syncScreenScale() {
  renderer.getDrawingBufferSize(_dbSize);
  hatchUniforms.uScreenScale.value = 2 / Math.max(_dbSize.y, 1);
}

const clock = new THREE.Clock();
const staticIdleViewport = document.getElementById('viewport');
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  stepSim(dt);
  updateWeather(dt);
  const staticIdleSample = cat?.userData.updateStaticIdle?.(
    clock.elapsedTime,
    !params.motionDebug
  );
  staticIdleViewport.dataset.staticIdleEnabled = String(!!staticIdleSample?.enabled);
  staticIdleViewport.dataset.staticIdleTailAngle = (
    staticIdleSample?.tailAngle ?? 0
  ).toFixed(5);
  staticIdleViewport.dataset.staticIdleLeftEarAngle = (
    staticIdleSample?.leftEarAngle ?? 0
  ).toFixed(5);
  staticIdleViewport.dataset.staticIdleRightEarAngle = (
    staticIdleSample?.rightEarAngle ?? 0
  ).toFixed(5);
  eyeGazeCurrent.lerp(eyeGazeTarget, 1 - Math.exp(-dt * 12));
  cat?.userData.updateEyeAnimation?.(
    clock.elapsedTime,
    eyeGazeCurrent.x,
    eyeGazeCurrent.y
  );
  controls.update();
  toyWorld.updateFishPupils(camera);
  speechBubbles.update(dt);
  syncScreenScale();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- 控制面板
const controlsEl = document.getElementById('controls');

function section(title, { collapsible = false, collapsed = false, badge = '' } = {}) {
  const div = document.createElement('div');
  div.className = 'section';
  const h = document.createElement('h2');
  const titleText = document.createElement('span');
  titleText.className = 'section-title';
  titleText.textContent = title;
  h.appendChild(titleText);

  if (badge) {
    const badgeText = document.createElement('span');
    badgeText.className = 'section-badge';
    badgeText.textContent = badge;
    h.appendChild(badgeText);
  }

  if (collapsible) {
    div.classList.add('collapsible');
    h.setAttribute('role', 'button');
    h.setAttribute('tabindex', '0');
    const chevron = document.createElement('span');
    chevron.className = 'section-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    h.appendChild(chevron);

    const setCollapsed = (nextCollapsed) => {
      div.classList.toggle('collapsed', nextCollapsed);
      h.setAttribute('aria-expanded', String(!nextCollapsed));
    };
    const toggle = () => setCollapsed(!div.classList.contains('collapsed'));
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    setCollapsed(collapsed);
  }

  div.appendChild(h);
  controlsEl.appendChild(div);
  return div;
}

function controlGroup(parent, title, { open = false } = {}) {
  const disclosure = document.createElement('details');
  disclosure.className = 'nested-disclosure control-group';
  disclosure.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  disclosure.appendChild(summary);
  parent.appendChild(disclosure);
  return disclosure;
}

function subLabel(parent, text) {
  const el = document.createElement('h3');
  el.className = 'sub-label';
  el.textContent = text;
  parent.appendChild(el);
}

function chipGroup(parent, items, getActive, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  const refresh = () => {
    for (const btn of wrap.children) {
      btn.classList.toggle('active', String(btn.dataset.id) === String(getActive()));
    }
  };
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.id = item.id;
    btn.textContent = item.name;
    if (item.swatch) {
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = item.swatch;
      btn.prepend(dot);
    }
    btn.addEventListener('click', () => {
      onPick(item.id);
      refresh();
    });
    wrap.appendChild(btn);
  }
  refresh();
  parent.appendChild(wrap);
  return refresh;
}

// 带数值显示的滑杆行；返回控件引用，外部改值后可同步 UI
function sliderRow(parent, name, { min, max, step, get, set }) {
  const row = document.createElement('label');
  row.className = 'slider-row';
  const label = document.createElement('span');
  label.textContent = name;
  const input = document.createElement('input');
  input.type = 'range';
  input.setAttribute('aria-label', name);
  input.min = min;
  input.max = max;
  input.step = step;
  const val = document.createElement('span');
  val.className = 'slider-val';
  const fmt = (v) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2));
  const sync = () => {
    input.value = get();
    val.textContent = fmt(get());
  };
  input.addEventListener('input', () => {
    set(parseFloat(input.value));
    val.textContent = fmt(parseFloat(input.value));
  });
  sync();
  row.append(label, input, val);
  parent.appendChild(row);
  return { row, input, sync };
}

function toggleRow(parent, name, { get, set }) {
  const row = document.createElement('label');
  row.className = 'slider-row';
  const label = document.createElement('span');
  label.textContent = name;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'toggle-input';
  const sync = () => { input.checked = get(); };
  input.addEventListener('change', () => set(input.checked));
  sync();
  row.append(label, input);
  parent.appendChild(row);
  return { row, input, sync };
}

function selectRow(parent, name, items, { get, set }) {
  const row = document.createElement('label');
  row.className = 'select-row';
  const label = document.createElement('span');
  label.textContent = name;
  const select = document.createElement('select');
  select.setAttribute('aria-label', name);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    select.appendChild(option);
  }
  const sync = () => { select.value = get(); };
  select.addEventListener('change', () => set(select.value));
  sync();
  row.append(label, select);
  parent.appendChild(row);
  return { row, select, sync };
}

function actionButton(parent, name, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'section-action';
  button.textContent = name;
  button.addEventListener('click', onClick);
  parent.appendChild(button);
  return button;
}

function colorRow(parent, name, { get, set }) {
  const row = document.createElement('label');
  row.className = 'slider-row';
  const label = document.createElement('span');
  label.textContent = name;
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'color-input';
  const sync = () => { input.value = get(); };
  input.addEventListener('input', () => set(input.value));
  sync();
  row.append(label, input);
  parent.appendChild(row);
  return { row, input, sync };
}

const refreshers = [];
const sliderSyncs = [];

// 顶层保留四个常用分类；体型与花纹默认展开，细项按需要再展开。
const bodySec = section('体型', { collapsible: true, collapsed: false });
const coatSec = section('花纹与眼睛', { collapsible: true, collapsed: false });
const sceneSec = section('场景与渲染', { collapsible: true, collapsed: true });
const motionSec = section('Motion', {
  collapsible: true,
  collapsed: true,
  badge: 'Experimental',
});

const poseControls = controlGroup(bodySec, '姿势', { open: true });
const staticPoseControls = document.createElement('div');
staticPoseControls.className = 'pose-static-controls';
poseControls.appendChild(staticPoseControls);
const containerPoseControls = document.createElement('div');
containerPoseControls.className = 'nested-controls container-pose-controls';
poseControls.appendChild(containerPoseControls);
const containerStatus = document.createElement('p');
containerStatus.className = 'container-status';
containerPoseControls.appendChild(containerStatus);
actionButton(containerPoseControls, '随机猫窝', () => {
  params.containerSeed = randomSeed();
  refreshers.forEach((refresh) => refresh());
  rebuild('full');
});
const containerSizeControl = sliderRow(containerPoseControls, '猫窝大小', {
  min: 0.72,
  max: 1.5,
  step: 0.01,
  get: () => params.containerSize,
  set: (value) => {
    params.containerSize = value;
    rebuildDraftThenFull();
  },
});
const containerSoftBodyToggle = toggleRow(containerPoseControls, '实验：软体填充', {
  get: () => params.containerSoftBody,
  set: (on) => {
    params.containerSoftBody = on;
    rebuild('full');
    refreshers.forEach((refresh) => refresh());
  },
});
const containerSoftCollisionToggle = toggleRow(containerPoseControls, '实验：软体碰撞', {
  get: () => params.containerSoftCollision,
  set: (on) => {
    params.containerSoftCollision = on;
    if (!on) resetContainerJiggle();
  },
});
containerPoseControls.hidden = params.motionDebug || params.pose !== 'containerCrouch';
containerStatus.textContent = `当前猫窝：${getContainerDescriptor(params.containerSeed).name}`;
refreshers.push(chipGroup(
  staticPoseControls,
  POSES,
  () => params.pose,
  (id) => {
    if (id === 'containerCrouch' && params.pose !== id) {
      params.containerSeed = randomSeed();
    }
    params.pose = id;
    staticPoseBeforeMotion = id;
    refreshers.forEach((refresh) => refresh());
    rebuild('full');
  }
));

const bodySizeControls = document.createElement('div');
bodySizeControls.className = 'body-size-controls';
subLabel(bodySizeControls, '身体尺寸');
bodySec.appendChild(bodySizeControls);

const motionExperimentNote = document.createElement('p');
motionExperimentNote.className = 'experimental-note';
motionExperimentNote.textContent = '实验功能：动作适配与网格表现仍在持续调整。';
motionSec.appendChild(motionExperimentNote);
const motionToggle = toggleRow(motionSec, '动态模式', {
  get: () => params.motionDebug,
  set: (on) => {
    if (on) {
      staticPoseBeforeMotion = params.pose;
      params.pose = 'standing';
    } else {
      params.pose = staticPoseBeforeMotion || 'standing';
    }
    params.motionDebug = on;
    staticPoseControls.hidden = on;
    containerPoseControls.hidden = on || params.pose !== 'containerCrouch';
    motionOptions.hidden = !on;
    motionElapsed = 0;
    motionRig?.reset();
    motionWasEnabled = false;
    resetMotionWorld();
    rebuild('full');
    refreshers.forEach((refresh) => refresh());
  },
});
const motionOptions = document.createElement('div');
motionOptions.className = 'nested-controls pose-motion-controls';
motionSec.appendChild(motionOptions);
const motionMachineToggle = toggleRow(motionOptions, '键盘状态机', {
  get: () => params.motionStateMachine,
  set: (on) => {
    params.motionStateMachine = on;
    resetMotionWorld();
    motionSelect.select.disabled = on;
    motionKeyboardHint.hidden = !on;
  },
});
const motionSelect = selectRow(
  motionOptions,
  '动作',
  MESH2MOTION_ACTIONS,
  {
    get: () => params.motionAction,
    set: (value) => {
      params.motionAction = value;
      motionElapsed = 0;
      const compatibility = getRigCompatibility('standing', value);
      motionStatusEl.textContent = `源动作 ${MESH2MOTION_ACTIONS.find((item) => item.id === value)?.sourceName ?? value} · ${compatibility.label}`;
      motionStatusEl.dataset.grade = compatibility.grade;
    },
  }
);
motionSelect.select.disabled = params.motionStateMachine;
const motionSpeedControl = sliderRow(motionOptions, '速度', {
  min: 0.25,
  max: 2,
  step: 0.01,
  get: () => params.motionSpeed,
  set: (value) => { params.motionSpeed = value; },
});
const motionIntensityControl = sliderRow(motionOptions, '幅度', {
  min: 0,
  max: 1.6,
  step: 0.01,
  get: () => params.motionIntensity,
  set: (value) => { params.motionIntensity = value; },
});
motionStatusEl = document.createElement('p');
motionStatusEl.className = 'rig-status';
motionStatusEl.textContent = 'Mesh2Motion 原始关键帧 · 固定网格 · 19 骨骼蒙皮';
motionStatusEl.dataset.grade = 'full';
motionOptions.appendChild(motionStatusEl);
const motionKeyboardHint = document.createElement('p');
motionKeyboardHint.className = 'motion-keyboard-hint';
motionKeyboardHint.innerHTML = MOTION_KEY_BINDINGS
  .map(({ keys, action }) => `<span><kbd>${keys}</kbd>${action}</span>`)
  .join('');
motionKeyboardHint.hidden = !params.motionStateMachine;
motionOptions.appendChild(motionKeyboardHint);
actionButton(motionOptions, '小猫归位', () => {
  resetMotionWorld();
  motionRig?.reset();
  if (cat) cat.position.set(0, lift.y + CAT_VISUAL_CONTACT_LIFT, 0);
});
motionOptions.hidden = !params.motionDebug;
staticPoseControls.hidden = params.motionDebug;
refreshers.push(() => {
  motionToggle.sync();
  motionMachineToggle.sync();
  motionOptions.hidden = !params.motionDebug;
  staticPoseControls.hidden = params.motionDebug;
  containerPoseControls.hidden = params.motionDebug || params.pose !== 'containerCrouch';
  const containerDescriptor = getContainerDescriptor(params.containerSeed);
  containerStatus.textContent = `当前猫窝：${containerDescriptor.name}`;
  containerSizeControl.sync();
  containerSoftBodyToggle.sync();
  containerSoftCollisionToggle.sync();
  motionSelect.sync();
  motionSelect.select.disabled = params.motionStateMachine;
  motionKeyboardHint.hidden = !params.motionStateMachine;
  motionSpeedControl.sync();
  motionIntensityControl.sync();
  motionStatusEl.dataset.grade = 'full';
});
sliderSyncs.push(containerSizeControl, motionSpeedControl, motionIntensityControl);

refreshers.push(chipGroup(
  coatSec,
  COATS.map((c) => ({ id: c.id, name: c.name, swatch: c.base })),
  () => params.coatId,
  (id) => {
    params.coatId = id;
    applyDynamicCoatPreset(id);
    refreshers.forEach((refresh) => refresh());
    sliderSyncs.forEach((control) => control.sync());
    rebuild('full');
  }
));
const dynamicCoatDisclosure = document.createElement('details');
dynamicCoatDisclosure.className = 'nested-disclosure';
const dynamicCoatSummary = document.createElement('summary');
dynamicCoatSummary.textContent = '自定义花色';
dynamicCoatDisclosure.appendChild(dynamicCoatSummary);
coatSec.appendChild(dynamicCoatDisclosure);
const dynamicCoatControl = toggleRow(dynamicCoatDisclosure, '启用自定义花色', {
  get: () => params.dynamicCoat,
  set: (on) => {
    params.dynamicCoat = on;
    dynamicCoatOptions.hidden = !on;
    updateDynamicCoat();
  },
});
const dynamicCoatOptions = document.createElement('div');
dynamicCoatOptions.className = 'nested-controls';
dynamicCoatDisclosure.appendChild(dynamicCoatOptions);
const dynamicCoatBaseControl = colorRow(dynamicCoatOptions, '花色底色', {
  get: () => params.dynamicCoatBase,
  set: (value) => { params.dynamicCoatBase = value; updateDynamicCoat(); },
});
const dynamicCoatAControl = colorRow(dynamicCoatOptions, '主色块', {
  get: () => params.dynamicCoatA,
  set: (value) => { params.dynamicCoatA = value; updateDynamicCoat(); },
});
const dynamicCoatBControl = colorRow(dynamicCoatOptions, '辅助色块', {
  get: () => params.dynamicCoatB,
  set: (value) => { params.dynamicCoatB = value; updateDynamicCoat(); },
});
const currentDynamicCoatPattern = () =>
  COATS.find((coat) => coat.id === params.coatId)?.soft?.pattern ?? 'patch';
const dynamicCoatSpecificSyncs = [];
const dynamicCoatRandomButton = actionButton(dynamicCoatOptions, '随机花色参数', () => {
  const rng = createRng(randomSeed());
  if (currentDynamicCoatPattern() === 'tabby') {
    params.dynamicCoatBodyDensity = Math.round(rng.range(1.5, 28) * 10) / 10;
    params.dynamicCoatBodyWidth = Math.round(rng.range(0.04, 0.95) * 100) / 100;
    params.dynamicCoatBodyIrregularity = Math.round(rng.range(0, 3.4) * 100) / 100;
    params.dynamicCoatHeadDensity = Math.round(rng.range(3, 58));
    params.dynamicCoatHeadWidth = Math.round(rng.range(0.04, 0.95) * 100) / 100;
    params.dynamicCoatHeadIrregularity = Math.round(rng.range(0, 3.4) * 100) / 100;
  } else {
    params.dynamicCoatCount = Math.floor(rng.range(3, 13));
    params.dynamicCoatScale = Math.round(rng.range(0.55, 1.9) * 100) / 100;
    params.dynamicCoatIrregularity = Math.round(rng.range(0, 1.5) * 100) / 100;
  }
  dynamicCoatSpecificSyncs.forEach((control) => control.sync());
  updateDynamicCoat();
});

const dynamicCoatGenericControls = document.createElement('div');
dynamicCoatGenericControls.className = 'nested-controls';
dynamicCoatOptions.appendChild(dynamicCoatGenericControls);
const genericCoatSliderDefs = [
  { key: 'dynamicCoatCount', name: '色块数量', min: 1, max: 12, step: 1 },
  { key: 'dynamicCoatScale', name: '色块大小', min: 0.45, max: 2, step: 0.01 },
  { key: 'dynamicCoatIrregularity', name: '不规则度', min: 0, max: 1.5, step: 0.01 },
];
const genericCoatSliderControls = [];
for (const definition of genericCoatSliderDefs) {
  const control = sliderRow(dynamicCoatGenericControls, definition.name, {
    min: definition.min,
    max: definition.max,
    step: definition.step,
    get: () => params[definition.key],
    set: (value) => {
      params[definition.key] = value;
      updateDynamicCoat();
    },
  });
  genericCoatSliderControls.push(control);
  dynamicCoatSpecificSyncs.push(control);
  sliderSyncs.push(control);
}

const dynamicCoatTabbyControls = document.createElement('div');
dynamicCoatTabbyControls.className = 'nested-controls';
dynamicCoatOptions.appendChild(dynamicCoatTabbyControls);
subLabel(dynamicCoatTabbyControls, '身体环纹');
const tabbyBodySliderDefs = [
  { key: 'dynamicCoatBodyDensity', name: '密度', min: 0.8, max: 32, step: 0.1 },
  { key: 'dynamicCoatBodyWidth', name: '宽度', min: 0.01, max: 1.1, step: 0.01 },
  { key: 'dynamicCoatBodyIrregularity', name: '抖动', min: 0, max: 4, step: 0.01 },
];
subLabel(dynamicCoatTabbyControls, '头部额纹');
const tabbyHeadSliderDefs = [
  { key: 'dynamicCoatHeadDensity', name: '密度', min: 1, max: 64, step: 1 },
  { key: 'dynamicCoatHeadWidth', name: '宽度', min: 0.01, max: 1.1, step: 0.01 },
  { key: 'dynamicCoatHeadIrregularity', name: '抖动', min: 0, max: 4, step: 0.01 },
];
// 为了保持控件顺序，身体组和头部组分别挂到自己的容器。
const headLabel = dynamicCoatTabbyControls.querySelectorAll('h3')[1];
for (const definition of tabbyBodySliderDefs) {
  const control = sliderRow(dynamicCoatTabbyControls, definition.name, {
    min: definition.min, max: definition.max, step: definition.step,
    get: () => params[definition.key],
    set: (value) => { params[definition.key] = value; updateDynamicCoat(); },
  });
  dynamicCoatTabbyControls.insertBefore(control.row, headLabel);
  dynamicCoatSpecificSyncs.push(control);
  sliderSyncs.push(control);
}
for (const definition of tabbyHeadSliderDefs) {
  const control = sliderRow(dynamicCoatTabbyControls, definition.name, {
    min: definition.min, max: definition.max, step: definition.step,
    get: () => params[definition.key],
    set: (value) => { params[definition.key] = value; updateDynamicCoat(); },
  });
  dynamicCoatSpecificSyncs.push(control);
  sliderSyncs.push(control);
}

const dynamicCoatSoftnessControl = sliderRow(dynamicCoatOptions, '边缘晕染', {
  min: 0, max: 1.4, step: 0.01,
  get: () => params.dynamicCoatSoftness,
  set: (value) => { params.dynamicCoatSoftness = value; updateDynamicCoat(); },
});
sliderSyncs.push(dynamicCoatSoftnessControl);

function syncDynamicCoatParameterLayout() {
  const pattern = currentDynamicCoatPattern();
  const isTabby = pattern === 'tabby';
  dynamicCoatTabbyControls.hidden = !isTabby;
  dynamicCoatGenericControls.hidden = isTabby;
  dynamicCoatRandomButton.textContent = isTabby ? '随机头身条纹' : '随机花色参数';
  const labels = pattern === 'tortoiseshell'
    ? ['碎斑密度', '碎斑尺度', '碎斑流动度']
    : pattern === 'points'
      ? ['重点色数量', '重点色范围', '边界变化']
      : ['色块数量', '色块大小', '不规则度'];
  genericCoatSliderControls.forEach((control, index) => {
    control.row.firstElementChild.textContent = labels[index];
  });
}
syncDynamicCoatParameterLayout();
dynamicCoatOptions.hidden = !params.dynamicCoat;
refreshers.push(() => {
  dynamicCoatControl.sync();
  dynamicCoatOptions.hidden = !params.dynamicCoat;
  dynamicCoatBaseControl.sync();
  dynamicCoatAControl.sync();
  dynamicCoatBControl.sync();
  syncDynamicCoatParameterLayout();
});
const eyeSec = controlGroup(coatSec, '眼睛');
const leftEyeColorControl = colorRow(eyeSec, '眼睛颜色', {
  get: () => params.eyeColor,
  set: (value) => { params.eyeColor = value; rebuild('full'); },
});
const oddEyeControl = toggleRow(eyeSec, '异瞳', {
  get: () => params.oddEyes,
  set: (on) => {
    params.oddEyes = on;
    rightEyeColorControl.row.hidden = !on;
    rebuild('full');
  },
});
const rightEyeColorControl = colorRow(eyeSec, '右眼颜色', {
  get: () => params.eyeColorRight,
  set: (value) => { params.eyeColorRight = value; rebuild('full'); },
});
rightEyeColorControl.row.hidden = !params.oddEyes;
refreshers.push(() => {
  leftEyeColorControl.sync();
  oddEyeControl.sync();
  rightEyeColorControl.sync();
  rightEyeColorControl.row.hidden = !params.oddEyes;
});

for (const s of EYE_SLIDERS.filter((item) => item.key !== 'wateryEyeShape')) {
  sliderSyncs.push(sliderRow(eyeSec, s.name, {
    min: s.min, max: s.max, step: s.step,
    get: () => params[s.key],
    set: (v) => {
      params[s.key] = v;
      sliderSyncs.forEach((control) => control.sync());
      rebuildDraftThenFull();
    },
  }));
}
const wateryEyeControl = toggleRow(eyeSec, '泪眼模式', {
  get: () => params.wateryEyes,
  set: (on) => {
    params.wateryEyes = on;
    wateryShapeControl.row.hidden = !on;
    rebuild('full');
  },
});
const wateryDef = EYE_SLIDERS.find((item) => item.key === 'wateryEyeShape');
const wateryShapeControl = sliderRow(eyeSec, wateryDef.name, {
  min: wateryDef.min,
  max: wateryDef.max,
  step: wateryDef.step,
  get: () => params.wateryEyeShape,
  set: (value) => {
    params.wateryEyeShape = value;
    rebuildDraftThenFull();
  },
});
wateryShapeControl.row.hidden = !params.wateryEyes;
sliderSyncs.push(wateryShapeControl);
refreshers.push(() => {
  wateryEyeControl.sync();
  wateryShapeControl.sync();
  wateryShapeControl.row.hidden = !params.wateryEyes;
});

// —— 体型 ——
for (const s of BODY_SLIDERS) {
  sliderSyncs.push(sliderRow(bodySizeControls, s.name, {
    min: s.min, max: s.max, step: s.step,
    get: () => params[s.key],
    set: (v) => { params[s.key] = v; rebuildDraftThenFull(); },
  }));
}
const furControls = controlGroup(bodySec, '毛发');
const fluffyControl = toggleRow(furControls, '炸毛', {
  get: () => params.fluffy,
  set: (on) => {
    params.fluffy = on;
    furFluffControl.row.hidden = !on;
    rebuild('full');
  },
});
const furFluffControl = sliderRow(furControls, '炸毛程度', {
  min: FUR_SLIDERS[0].min,
  max: FUR_SLIDERS[0].max,
  step: FUR_SLIDERS[0].step,
  get: () => params.furFluff,
  set: (value) => {
    params.furFluff = value;
    rebuildDraftThenFull();
  },
});
furFluffControl.row.hidden = !params.fluffy;
sliderSyncs.push(furFluffControl);
refreshers.push(() => {
  fluffyControl.sync();
  furFluffControl.sync();
  furFluffControl.row.hidden = !params.fluffy;
});

// —— 线条：身体与眼睛的墨线 ——
const lineSec = controlGroup(sceneSec, '线条');
sliderSyncs.push(sliderRow(lineSec, '手绘抖动', {
  min: 0, max: 1, step: 0.01,
  get: () => params.outlineJitter,
  set: (v) => { params.outlineJitter = v; rebuildDraftThenFull(); },
}));

// —— 捏猫：软体交互手感（实时生效）——
const pokeSec = controlGroup(sceneSec, '捏猫');
sliderRow(pokeSec, '范围', {
  min: 0.15, max: 0.78, step: 0.01,
  get: () => pokeUniforms.uPokeRadius.value,
  set: (v) => { pokeUniforms.uPokeRadius.value = v; },
});
sliderRow(pokeSec, '软硬', {
  min: 1.8, max: 9, step: 0.1,
  get: () => pokeFeel.freq,
  set: (v) => { pokeFeel.freq = v; },
});
sliderRow(pokeSec, 'Q弹', {
  min: 0, max: 1, step: 0.01,
  get: () => 1 - (pokeFeel.damping - 0.05) / 0.45, // 越大抖越久
  set: (v) => { pokeFeel.damping = 0.05 + (1 - v) * 0.45; },
});

// —— 垫子：可单独显示/隐藏，也可只随机垫子而不改变猫和玩具 ——
const rugSec = controlGroup(sceneSec, '垫子');
toggleRow(rugSec, '显示垫子', {
  get: () => rugState.enabled,
  set: (on) => {
    rugState.enabled = on;
    rugLayer.setVisible(on);
    syncRugPlacement();
  },
});
actionButton(rugSec, '随机垫子', () => {
  rugState.seed = randomSeed();
  rugLayer.setSeed(rugState.seed);
  rugLayer.fitToCat(cat);
  syncRugPlacement();
});

// —— 木地板：程序化 CanvasTexture，全部参数实时重绘 ——
const floorSec = controlGroup(sceneSec, '木地板');
actionButton(floorSec, '随机木地板', randomizeWoodFloor);
const floorBaseColorControl = colorRow(floorSec, '木板底色', {
  get: () => floorParams.baseColor,
  set: (value) => { floorParams.baseColor = value; drawWoodFloor(); },
});
const floorSeamColorControl = colorRow(floorSec, '缝隙颜色', {
  get: () => floorParams.seamColor,
  set: (value) => { floorParams.seamColor = value; drawWoodFloor(); },
});
const floorGrainColorControl = colorRow(floorSec, '木纹颜色', {
  get: () => floorParams.grainColor,
  set: (value) => { floorParams.grainColor = value; drawWoodFloor(); },
});
floorColorSyncs.push(floorBaseColorControl, floorSeamColorControl, floorGrainColorControl);
floorSliderSyncs.push(sliderRow(floorSec, '木板宽度', {
  min: 0.35, max: 1.6, step: 0.01,
  get: () => floorParams.plankWidth,
  set: (value) => { floorParams.plankWidth = value; drawWoodFloor(); },
}));
floorSliderSyncs.push(sliderRow(floorSec, '木纹密度', {
  min: 0, max: 1.5, step: 0.01,
  get: () => floorParams.grainDensity,
  set: (value) => { floorParams.grainDensity = value; drawWoodFloor(); },
}));
floorSliderSyncs.push(sliderRow(floorSec, '地板方向', {
  min: 0, max: 180, step: 1,
  get: () => floorParams.direction,
  set: (value) => { floorParams.direction = value; drawWoodFloor(); },
}));

// —— 排线参数组：影子（uHatch*）和身上（uBody*）各一套，UI 结构相同 ——
// 平行线与虚线共享粗细、密度、抖动和倾斜；切换时只改变连续/断续样式。
function hatchControls(parent, prefix) {
  const u = (name) => hatchUniforms[`u${prefix}${name}`];
  const syncs = [];
  chipGroup(parent, HATCH_PRESETS,
    () => u('Style').value,
    (id) => { u('Style').value = Number(id); });
  syncs.push(sliderRow(parent, '粗细', {
    min: 0.02, max: 0.2, step: 0.005,
    get: () => 0.95 - u('Width').value,
    set: (v) => { u('Width').value = 0.95 - v; },
  }));
  syncs.push(sliderRow(parent, '密度', {
    min: 60, max: 260, step: 1,
    get: () => u('Freq').value,
    set: (v) => { u('Freq').value = v; },
  }));
  syncs.push(sliderRow(parent, '抖动', {
    min: 0, max: 0.5, step: 0.01,
    get: () => u('Jitter').value,
    set: (v) => { u('Jitter').value = v; },
  }));
  syncs.push(sliderRow(parent, '倾斜', {
    min: 0, max: 180, step: 1,
    get: () => Math.round(THREE.MathUtils.radToDeg(u('Angle').value)),
    set: (v) => { u('Angle').value = THREE.MathUtils.degToRad(v); },
  }));
  syncs.push(sliderRow(parent, '虚线水平拉伸', {
    min: 0.35, max: 4, step: 0.05,
    get: () => u('DashStretch').value,
    set: (v) => { u('DashStretch').value = v; },
  }));
}

// —— 影子排线 ——
const shadowSec = controlGroup(sceneSec, '地面影子');
colorRow(shadowSec, '排线颜色', {
  get: () => `#${hatchUniforms.uGroundHatchColor.value.getHexString()}`,
  set: (value) => {
    hatchUniforms.uGroundHatchColor.value.set(value);
    sketchShadowMat.color.set(value);
  },
});
colorRow(shadowSec, '色块颜色', {
  get: () => `#${hatchUniforms.uGroundShadowColor.value.getHexString()}`,
  set: (value) => {
    hatchUniforms.uGroundShadowColor.value.set(value);
    blockShadowMat.color.set(value);
  },
});
// 屏幕对齐开关：所有排线（影子 + 身上）方向锁定屏幕，转镜头不变
toggleRow(shadowSec, '对齐镜头', {
  get: () => hatchUniforms.uHatchScreen.value === 1,
  set: (on) => { hatchUniforms.uHatchScreen.value = on ? 1 : 0; },
});
hatchControls(shadowSec, 'Hatch');

// —— 身上阴影：暗面色块 + 独立参数的排线（实时生效）——
const shadeSec = controlGroup(sceneSec, '身上阴影');
sliderRow(shadeSec, '阴影浓度', {
  min: 0, max: 1, step: 0.01,
  get: () => hatchUniforms.uShadeAlpha.value,
  set: (v) => { hatchUniforms.uShadeAlpha.value = v; },
});
colorRow(shadeSec, '阴影颜色', {
  get: () => `#${hatchUniforms.uShadeColor.value.getHexString()}`,
  set: (v) => { hatchUniforms.uShadeColor.value.set(v); },
});
sliderRow(shadeSec, '排线浓度', {
  min: 0, max: 1, step: 0.01,
  get: () => hatchUniforms.uBodyHatch.value,
  set: (v) => { hatchUniforms.uBodyHatch.value = v; },
});
hatchControls(shadeSec, 'Body');

// 调整展示顺序：先承载猫猫的场景物件，再到线条 / 捏猫，最后集中阴影参数。
sceneSec.append(rugSec, floorSec, lineSec, pokeSec, shadowSec, shadeSec);

// —— 光照球：用画布右上角的二维拖拽同时控制方位角和仰角 ——
// 同步更新平行光位置（含阴影相机）和猫身暗面判定用的 uKeyDir。
const lightAngles = { azimuth: 53, elevation: 46 }; // 默认等于原 (3.2, 5.5, 4.2)
const lightOrb = document.getElementById('light-orb');
const lightOrbHandle = document.getElementById('light-orb-handle');
function updateKeyLight() {
  const az = THREE.MathUtils.degToRad(lightAngles.azimuth);
  const el = THREE.MathUtils.degToRad(lightAngles.elevation);
  const r = 7.6;
  key.position.set(
    Math.cos(el) * Math.cos(az) * r,
    Math.sin(el) * r,
    Math.cos(el) * Math.sin(az) * r
  );
  hatchUniforms.uKeyDir.value.copy(key.position).normalize();
}

function syncLightOrb() {
  const x = THREE.MathUtils.clamp(lightAngles.azimuth / 150, -1, 1);
  const y = THREE.MathUtils.clamp((45 - lightAngles.elevation) / 37, -1, 1);
  lightOrbHandle.style.left = `${50 + x * 35}%`;
  lightOrbHandle.style.top = `${50 + y * 35}%`;
  lightOrb.style.setProperty('--light-x', `${50 + x * 28}%`);
  lightOrb.style.setProperty('--light-y', `${50 + y * 28}%`);
  lightOrb.setAttribute(
    'aria-valuetext',
    `方位 ${Math.round(lightAngles.azimuth)} 度，仰角 ${Math.round(lightAngles.elevation)} 度`
  );
}

function setLightFromPointer(event) {
  const rect = lightOrb.getBoundingClientRect();
  const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
  const y = THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
  const length = Math.hypot(x, y);
  const nx = length > 1 ? x / length : x;
  const ny = length > 1 ? y / length : y;
  lightAngles.azimuth = nx * 150;
  lightAngles.elevation = THREE.MathUtils.clamp(45 - ny * 37, 8, 82);
  updateKeyLight();
  syncLightOrb();
}

lightOrb.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  lightOrb.setPointerCapture(event.pointerId);
  setLightFromPointer(event);
});
lightOrb.addEventListener('pointermove', (event) => {
  if (!lightOrb.hasPointerCapture(event.pointerId)) return;
  setLightFromPointer(event);
});
lightOrb.addEventListener('keydown', (event) => {
  const keyStep = event.shiftKey ? 8 : 3;
  if (event.key === 'ArrowLeft') lightAngles.azimuth -= keyStep;
  else if (event.key === 'ArrowRight') lightAngles.azimuth += keyStep;
  else if (event.key === 'ArrowUp') lightAngles.elevation += keyStep;
  else if (event.key === 'ArrowDown') lightAngles.elevation -= keyStep;
  else return;
  event.preventDefault();
  lightAngles.azimuth = THREE.MathUtils.clamp(lightAngles.azimuth, -150, 150);
  lightAngles.elevation = THREE.MathUtils.clamp(lightAngles.elevation, 8, 82);
  updateKeyLight();
  syncLightOrb();
});
updateKeyLight();
syncLightOrb();

// —— 天气：光色、地板色调、云层、雨幕、鱼雨和程序化音效统一联动 ——
const weatherButtons = [...document.querySelectorAll('.weather-chip')];
const viewport = document.getElementById('viewport');
const lightningFlash = document.getElementById('lightning-flash');
const lightningArt = document.getElementById('lightning-art');
const lightningOutline = document.getElementById('lightning-outline');
const lightningCore = document.getElementById('lightning-core');
const weatherParameters = document.querySelector('.weather-parameters');
const weatherAmounts = {
  rain: 1,
  cloud: 1,
  fish: 1,
};
const weatherAmountControls = {
  rain: {
    input: document.getElementById('weather-rain-amount'),
    output: document.getElementById('weather-rain-value'),
    row: document.getElementById('weather-rain-amount').closest('.weather-parameter'),
  },
  cloud: {
    input: document.getElementById('weather-cloud-amount'),
    output: document.getElementById('weather-cloud-value'),
    row: document.getElementById('weather-cloud-amount').closest('.weather-parameter'),
  },
  fish: {
    input: document.getElementById('weather-fish-amount'),
    output: document.getElementById('weather-fish-value'),
    row: document.getElementById('weather-fish-amount').closest('.weather-parameter'),
  },
};
const weatherPresets = {
  sunny: {
    background: '#efe9dd', key: '#fff0da', keyIntensity: 2.4,
    ambient: '#fff2e2', ambientIntensity: 0.85,
    floorTint: '#ffffff',
  },
  cloudy: {
    background: '#d9dbd8', key: '#e8edf2', keyIntensity: 1.35,
    ambient: '#dfe5e8', ambientIntensity: 1.05,
    floorTint: '#dfe6e4',
  },
  thunder: {
    background: '#858c99', key: '#bdc8dc', keyIntensity: 0.72,
    ambient: '#8792a3', ambientIntensity: 0.58,
    floorTint: '#9da8bb',
  },
  fishRain: {
    background: '#aebfc5', key: '#d9e4e6', keyIntensity: 1.15,
    ambient: '#c4d1d3', ambientIntensity: 0.9,
    floorTint: '#bdd1d4',
  },
};
let weatherMode = 'sunny';
let thunderEnabled = false;
let thunderCountdown = 0;
let thunderFlash = 0;
let thunderFluffTimer = 0;
let thunderFluffPeak = 0;
const THUNDER_FLUFF_DURATION = 0.7;
const targetWeatherColor = new THREE.Color(weatherPresets.sunny.background);
const targetKeyColor = new THREE.Color(weatherPresets.sunny.key);
const targetAmbientColor = new THREE.Color(weatherPresets.sunny.ambient);
const targetFloorTint = new THREE.Color(weatherPresets.sunny.floorTint);

function boltPolygon(points, startWidth, endWidth) {
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    const normalX = -dy / length;
    const normalY = dx / length;
    const width = THREE.MathUtils.lerp(
      startWidth,
      endWidth,
      index / Math.max(1, points.length - 1)
    );
    left.push({ x: point.x + normalX * width, y: point.y + normalY * width });
    right.push({ x: point.x - normalX * width, y: point.y - normalY * width });
  }
  return [
    `M ${left[0].x.toFixed(1)} ${left[0].y.toFixed(1)}`,
    ...left.slice(1).map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
    ...right.reverse().map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
    'Z',
  ].join(' ');
}

function lightningPaths() {
  let x = THREE.MathUtils.randFloat(42, 58);
  let y = -5;
  const mainPoints = [{ x, y }];
  while (y < 94) {
    y = Math.min(96, y + THREE.MathUtils.randFloat(7, 13));
    const direction = mainPoints.length % 2 === 0 ? -1 : 1;
    x = THREE.MathUtils.clamp(
      x + direction * THREE.MathUtils.randFloat(6.5, 14.5) + THREE.MathUtils.randFloat(-2.8, 2.8),
      16,
      84
    );
    mainPoints.push({ x, y });
  }
  const bolts = [mainPoints];
  const branchIndexes = [2, 4, Math.min(6, mainPoints.length - 2)];
  for (let branchIndex = 0; branchIndex < branchIndexes.length; branchIndex++) {
    const root = mainPoints[branchIndexes[branchIndex]];
    if (!root || Math.random() < 0.12) continue;
    const side = branchIndex % 2 === 0 ? -1 : 1;
    let bx = root.x;
    let by = root.y;
    const branch = [{ x: bx, y: by }];
    const steps = 2 + Math.floor(Math.random() * 3);
    for (let step = 0; step < steps; step++) {
      bx = THREE.MathUtils.clamp(
        bx + side * THREE.MathUtils.randFloat(5, 11) + THREE.MathUtils.randFloat(-2, 2),
        4,
        96
      );
      by += THREE.MathUtils.randFloat(5, 10);
      branch.push({ x: bx, y: by });
    }
    bolts.push(branch);
  }
  return {
    outline: bolts
      .map((points, index) => boltPolygon(points, index === 0 ? 3.1 : 1.65, index === 0 ? 0.72 : 0.28))
      .join(' '),
    core: bolts
      .map((points, index) => boltPolygon(points, index === 0 ? 1.9 : 0.9, index === 0 ? 0.3 : 0.12))
      .join(' '),
  };
}

function restoreThunderFluff() {
  thunderFluffTimer = 0;
  thunderFluffPeak = 0;
  cat?.userData.setTransientFluff?.(0);
  viewport.dataset.thunderFluffAmount = '0.000';
}

function syncThunderFluffVisual() {
  const amount = thunderFluffTimer > 0
    ? thunderFluffPeak * Math.sqrt(thunderFluffTimer / THUNDER_FLUFF_DURATION)
    : 0;
  cat?.userData.setTransientFluff?.(amount);
  viewport.dataset.thunderFluffAmount = amount.toFixed(3);
}

function triggerLightning() {
  thunderFlash = 1;
  const paths = lightningPaths();
  lightningOutline.setAttribute('d', paths.outline);
  lightningCore.setAttribute('d', paths.core);
  weatherAudio.playThunder(THREE.MathUtils.randFloat(0.82, 1.08));

  // 闪电炸毛只形变现有视觉网格，不重建小猫，也不替换猫身碰撞球。
  // 这样靠近小猫的玩具不会因为新碰撞球与它们重叠而被解算器炸飞。
  const existingFluff = params.fluffy ? params.furFluff : 0;
  thunderFluffPeak = Math.max(0.75, 2.72 - existingFluff);
  thunderFluffTimer = THUNDER_FLUFF_DURATION;
  syncThunderFluffVisual();
}

function syncWeatherButtons() {
  for (const button of weatherButtons) {
    const buttonMode = button.dataset.weather;
    const active = buttonMode === 'thunder'
      ? thunderEnabled
      : buttonMode === weatherMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function syncWeatherParameterVisibility() {
  const raining = weatherMode === 'fishRain';
  const cloudsActive = weatherMode === 'cloudy' || thunderEnabled;
  weatherAmountControls.rain.row.hidden = !raining;
  weatherAmountControls.fish.row.hidden = !raining;
  weatherAmountControls.cloud.row.hidden = !cloudsActive;
  weatherParameters.hidden = !raining && !cloudsActive;
}

function syncWeatherLayers() {
  const raining = weatherMode === 'fishRain';
  fishRain.setEnabled(raining);
  rainField.setEnabled(raining);
  weatherAudio.setRain(raining);
  cloudField.setMode(thunderEnabled ? 'thunder' : weatherMode);
  syncWeatherButtons();
  syncWeatherParameterVisibility();
  viewport.dataset.weather = weatherMode;
  viewport.dataset.thunder = String(thunderEnabled);
}

function setThunder(nextEnabled) {
  nextEnabled = !!nextEnabled;
  if (thunderEnabled === nextEnabled) return;
  thunderEnabled = nextEnabled;
  if (thunderEnabled) {
    weatherAudio.prepare();
    thunderCountdown = 0;
  } else {
    restoreThunderFluff();
    thunderCountdown = 4;
  }
  thunderFlash = 0;
  syncWeatherLayers();
}

function setWeather(mode) {
  if (mode === 'thunder') {
    setThunder(!thunderEnabled);
    return;
  }
  if (!['sunny', 'cloudy', 'fishRain'].includes(mode)) return;
  weatherMode = mode;
  syncWeatherLayers();
}

function setWeatherAmount(type, nextAmount) {
  if (!(type in weatherAmounts)) return;
  const amount = THREE.MathUtils.clamp(
    Number(nextAmount) || 0,
    0,
    WEATHER_AMOUNT_LIMITS[type] ?? 2
  );
  weatherAmounts[type] = amount;
  const control = weatherAmountControls[type];
  control.input.value = String(amount);
  control.output.value = amount.toFixed(2);
  control.output.textContent = amount.toFixed(2);
  if (type === 'rain') {
    rainField.setAmount(amount);
    weatherAudio.setRainAmount(amount);
  } else if (type === 'cloud') {
    cloudField.setAmount(amount);
  } else if (type === 'fish') {
    fishRain.setAmount(amount);
  }
  viewport.dataset[`${type}Amount`] = amount.toFixed(2);
}

function updateWeather(dt) {
  const preset = weatherPresets[thunderEnabled ? 'thunder' : weatherMode];
  cloudField.update(dt);
  rainField.update(dt);
  targetWeatherColor.set(preset.background);
  targetKeyColor.set(preset.key);
  targetAmbientColor.set(preset.ambient);
  targetFloorTint.set(preset.floorTint);
  const blend = 1 - Math.exp(-dt * 4.5);
  scene.background.lerp(targetWeatherColor, blend);
  scene.fog.color.copy(scene.background);
  key.color.lerp(targetKeyColor, blend);
  ambient.color.lerp(targetAmbientColor, blend);
  ground.material.color.lerp(targetFloorTint, blend);
  ambient.intensity += (preset.ambientIntensity - ambient.intensity) * blend;

  if (thunderEnabled) {
    thunderCountdown -= dt;
    if (thunderCountdown <= 0) {
      triggerLightning();
      thunderCountdown = THREE.MathUtils.randFloat(2.6, 5.4);
    }
    thunderFlash = Math.max(0, thunderFlash - dt * 1.3);
  } else {
    thunderFlash = Math.max(0, thunderFlash - dt * 8);
  }
  if (thunderFluffTimer > 0) {
    thunderFluffTimer -= dt;
    if (thunderFluffTimer <= 0) restoreThunderFluff();
    else syncThunderFluffVisual();
  }
  key.intensity = preset.keyIntensity + thunderFlash * 4.8;
  lightningFlash.style.opacity = String(thunderFlash * 0.46);
  lightningArt.style.opacity = String(Math.min(1, thunderFlash * 1.4));
  viewport.dataset.fishCount = String(fishRain.count);
  viewport.dataset.rainDropCount = String(rainField.count);
  viewport.dataset.cloudCount = String(cloudField.count);
  viewport.dataset.cloudsVisible = String(cloudField.group.visible);
  viewport.dataset.thunderFluff = String(thunderFluffTimer > 0);
  viewport.dataset.weatherFloorTint = `#${ground.material.color.getHexString()}`;
  const audioState = weatherAudio.getState();
  viewport.dataset.weatherAudio = audioState.contextState;
  viewport.dataset.rainAudio = String(audioState.rainActive);
  viewport.dataset.thunderVoices = String(audioState.thunderVoices);
}

weatherButtons.forEach((button) => {
  button.addEventListener('click', () => setWeather(button.dataset.weather));
});
for (const [type, control] of Object.entries(weatherAmountControls)) {
  control.input.addEventListener('input', () => setWeatherAmount(type, control.input.value));
  setWeatherAmount(type, control.input.value);
}
setWeather('sunny');

// ---------------------------------------------------------------- 随机与导出
function randomizeAll() {
  const randomizeStartedAt = performance.now();
  params.seed = randomSeed();
  rugState.seed = params.seed;
  const rng = createRng(params.seed);
  params.containerSeed = Math.floor(rng.range(0, 1e9));
  const nextPose = rng.pick(POSES).id;
  if (params.motionDebug) {
    staticPoseBeforeMotion = nextPose;
    params.pose = 'standing';
  } else {
    params.pose = nextPose;
    staticPoseBeforeMotion = nextPose;
  }
  params.coatId = rng.pick(COATS).id;
  applyDynamicCoatPreset(params.coatId);
  const eyePalette = EYE_COLORS.filter((eye) => eye.color !== 'odd');
  params.eyeColor = rng.pick(eyePalette).color;
  params.oddEyes = rng.chance(0.24);
  params.wateryEyes = rng.chance(0.3);
  const alternateEyes = eyePalette.filter((eye) => eye.color !== params.eyeColor);
  params.eyeColorRight = rng.pick(alternateEyes).color;
  for (const s of RANDOM_SLIDERS) {
    params[s.key] = Math.round(rng.range(s.min, s.max) / s.step) * s.step;
  }
  refreshers.forEach((r) => r());
  sliderSyncs.forEach((s) => s.sync());
  rebuild('full');
  document.getElementById('viewport').dataset.lastRandomizeMs =
    (performance.now() - randomizeStartedAt).toFixed(1);
}

document.getElementById('btn-random').addEventListener('click', randomizeAll);

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const shareCardCapture = createShareCardCapture({
  viewport: document.getElementById('viewport'),
  renderer,
  scene,
  camera,
  controls,
  sceneCanvas: canvas,
  getSubject: () => cat,
  getSeed: () => params.seed,
  getPalette: () => ({
    base: params.dynamicCoatBase,
    primary: params.dynamicCoatA,
    secondary: params.dynamicCoatB,
    accent: params.eyeColor,
  }),
  getLocale: () => i18n.locale,
  downloadBlob: download,
});

document.getElementById('btn-export-glb').addEventListener('click', () => {
  const restoreDynamicCoat = cat.userData.prepareDynamicCoatExport?.();
  new GLTFExporter().parse(
    cat,
    (result) => {
      restoreDynamicCoat?.();
      download(new Blob([result], { type: 'model/gltf-binary' }), `kitten_${params.seed}.glb`);
    },
    (err) => {
      restoreDynamicCoat?.();
      console.error('GLB export failed', err);
    },
    { binary: true }
  );
});

document.getElementById('btn-export-png').addEventListener('click', () => {
  if (shareCardCapture.active) shareCardCapture.close();
  else shareCardCapture.open();
});

createCodexPetPreview({
  trigger: document.getElementById('btn-codex-pet'),
  capturePreview: () => canvas.toDataURL('image/png'),
  getPetDescriptor: () => ({
    schema: 'meow-generator/codex-pet-draft@1',
    name: `Meow #${params.seed}`,
    seed: params.seed,
    createdAt: new Date().toISOString(),
    status: 'experimental',
    generator: 'Meow Generator',
    parameters: { ...params },
  }),
});

// Mobile uses a compact, tabbed parameter console instead of stacking every
// desktop card into one very long sheet. Desktop keeps all sections visible.
const mobileSectionNav = document.getElementById('mobile-section-nav');
const mobilePanel = document.getElementById('panel');
const mobilePanelToggle = document.getElementById('mobile-panel-toggle');
const mobilePanelToggleLabel = mobilePanelToggle?.querySelector('.mobile-panel-toggle__label');
const mobileSections = [...controlsEl.querySelectorAll(':scope > .section')];
const mobilePanelMedia = window.matchMedia(
  '(max-width: 768px), (max-height: 560px) and (orientation: landscape)'
);
const mobilePanelResizeMedia = window.matchMedia('(max-width: 768px)');
let activeMobileSection = 0;
let mobilePanelCollapsed = mobilePanelMedia.matches;
let suppressMobilePanelToggle = false;
const mobilePanelResize = {
  pointerId: -1,
  startY: 0,
  startHeight: 0,
  dragged: false,
};

const MOBILE_PANEL_COPY = {
  'zh-CN': {
    expanded: '收起参数',
    collapsed: '展开参数',
    expandedAria: '收起参数面板',
    collapsedAria: '展开参数面板',
  },
  'ja-JP': {
    expanded: '閉じる',
    collapsed: '開く',
    expandedAria: 'パラメータパネルを閉じる',
    collapsedAria: 'パラメータパネルを開く',
  },
  en: {
    expanded: 'Collapse',
    collapsed: 'Controls',
    expandedAria: 'Collapse parameter panel',
    collapsedAria: 'Expand parameter panel',
  },
};

function activeInterfaceLocale() {
  return document.querySelector('.locale-switcher button.active')?.dataset.locale ?? 'zh-CN';
}

function updateMobilePanelToggle() {
  const copy = MOBILE_PANEL_COPY[activeInterfaceLocale()] ?? MOBILE_PANEL_COPY['zh-CN'];
  const label = mobilePanelCollapsed ? copy.collapsed : copy.expanded;
  const ariaLabel = mobilePanelCollapsed ? copy.collapsedAria : copy.expandedAria;
  if (mobilePanelToggleLabel) mobilePanelToggleLabel.textContent = label;
  mobilePanelToggle?.setAttribute('aria-label', ariaLabel);
  mobilePanelToggle?.setAttribute('aria-expanded', String(!mobilePanelCollapsed));
}

function setMobilePanelCollapsed(collapsed) {
  mobilePanelCollapsed = mobilePanelMedia.matches && collapsed;
  mobilePanel.classList.toggle('mobile-panel-collapsed', mobilePanelCollapsed);
  updateMobilePanelToggle();
  if (!mobilePanelCollapsed) mobilePanel.scrollTop = 0;
}

mobilePanelToggle?.addEventListener('click', () => {
  if (suppressMobilePanelToggle) {
    suppressMobilePanelToggle = false;
    return;
  }
  setMobilePanelCollapsed(!mobilePanelCollapsed);
});

mobilePanelToggle?.addEventListener('pointerdown', (event) => {
  if (!mobilePanelResizeMedia.matches || event.button !== 0) return;
  mobilePanelResize.pointerId = event.pointerId;
  mobilePanelResize.startY = event.clientY;
  mobilePanelResize.startHeight = mobilePanelCollapsed
    ? window.innerHeight / 3
    : mobilePanel.getBoundingClientRect().height;
  mobilePanelResize.dragged = false;
  mobilePanel.classList.add('mobile-panel-resizing');
});

window.addEventListener('pointermove', (event) => {
  if (event.pointerId !== mobilePanelResize.pointerId) return;
  const delta = mobilePanelResize.startY - event.clientY;
  if (!mobilePanelResize.dragged && Math.abs(delta) < 4) return;
  mobilePanelResize.dragged = true;
  if (mobilePanelCollapsed) setMobilePanelCollapsed(false);
  const minHeight = Math.max(128, window.innerHeight * 0.18);
  const maxHeight = window.innerHeight * 0.72;
  const height = THREE.MathUtils.clamp(
    mobilePanelResize.startHeight + delta,
    minHeight,
    maxHeight
  );
  mobilePanel.style.setProperty('--mobile-panel-height', `${Math.round(height)}px`);
  event.preventDefault();
});

function finishMobilePanelResize(event, cancelled = false) {
  if (event.pointerId !== mobilePanelResize.pointerId) return;
  suppressMobilePanelToggle = mobilePanelResize.dragged && !cancelled;
  mobilePanelResize.pointerId = -1;
  mobilePanelResize.dragged = false;
  mobilePanel.classList.remove('mobile-panel-resizing');
}

window.addEventListener('pointerup', (event) => finishMobilePanelResize(event), { capture: true });
window.addEventListener('pointercancel', (event) => finishMobilePanelResize(event, true), { capture: true });

function mobileSectionTitle(sectionElement) {
  const title = sectionElement.querySelector(':scope > h2 > .section-title')?.textContent?.trim() ?? '';
  const badge = sectionElement.querySelector(':scope > h2 > .section-badge')?.textContent?.trim() ?? '';
  return badge ? `${title} · ${badge}` : title;
}

function selectMobileSection(index, { scroll = true } = {}) {
  activeMobileSection = THREE.MathUtils.clamp(index, 0, Math.max(mobileSections.length - 1, 0));
  mobileSections.forEach((sectionElement, sectionIndex) => {
    const active = sectionIndex === activeMobileSection;
    sectionElement.classList.toggle('mobile-section-active', active);
    if (mobilePanelMedia.matches) sectionElement.setAttribute('aria-hidden', String(!active));
    else sectionElement.removeAttribute('aria-hidden');
    const heading = sectionElement.querySelector(':scope > h2');
    if (
      active
      && mobilePanelMedia.matches
      && sectionElement.classList.contains('collapsed')
    ) heading?.click();
  });
  [...mobileSectionNav.children].forEach((button, buttonIndex) => {
    const active = buttonIndex === activeMobileSection;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (scroll && mobilePanelMedia.matches) {
    mobilePanel.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

mobileSections.forEach((sectionElement, index) => {
  const id = `mobile-panel-section-${index}`;
  sectionElement.id = sectionElement.id || id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mobile-section-tab';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', sectionElement.id);
  button.textContent = mobileSectionTitle(sectionElement);
  button.addEventListener('click', () => {
    setMobilePanelCollapsed(false);
    selectMobileSection(index);
  });
  mobileSectionNav.appendChild(button);
});
mobileSectionNav.setAttribute('role', 'tablist');
selectMobileSection(0, { scroll: false });
mobilePanelMedia.addEventListener('change', () => {
  mobilePanel.style.removeProperty('--mobile-panel-height');
  setMobilePanelCollapsed(mobilePanelMedia.matches);
  selectMobileSection(activeMobileSection, { scroll: false });
});

window.addEventListener('meow:localechange', () => {
  [...mobileSectionNav.children].forEach((button, index) => {
    button.textContent = mobileSectionTitle(mobileSections[index]);
  });
  updateMobilePanelToggle();
  speechBubbles.refreshLocale();
});
setMobilePanelCollapsed(mobilePanelMedia.matches);

// ---------------------------------------------------------------- 启动
resize();
rebuild('full');
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    finishInitialLoaderWhenReady('first-frame');
  });
});

// 调试 / 自动化验证入口：按指定尺寸和机位离屏渲染一帧
window.__shot = (w = 1280, h = 800, cam = null) => {
  if (cam) {
    camera.position.set(cam[0], cam[1], cam[2]);
    controls.target.set(cam[3] ?? 0, cam[4] ?? 0.75, cam[5] ?? 0);
    controls.update();
  }
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
    camera.updateProjectionMatrix();
    syncScreenScale();
    toyWorld.updateFishPupils(camera);
    renderer.render(scene, camera);
  const url = canvas.toDataURL('image/png');
  resize();
  return url;
};
window.__setParams = (patch, quality = 'full') => {
  Object.assign(params, patch);
  if (params.motionDebug) params.pose = 'standing';
  if (
    patch.coatId &&
    patch.dynamicCoatBase == null &&
    patch.dynamicCoatA == null &&
    patch.dynamicCoatB == null
  ) applyDynamicCoatPreset(patch.coatId);
  refreshers.forEach((r) => r());
  sliderSyncs.forEach((s) => s.sync());
  rebuild(quality);
};
window.__poke = (px, py, pz, ox, oy, oz, holdMs = 0) => {
  const id = beginGrab(new THREE.Vector3(px, py, pz));
  setGrabTarget(id, new THREE.Vector3(ox, oy, oz));
  if (holdMs > 0) setTimeout(() => endGrab(id), holdMs);
  return id;
};
window.__endPoke = (id) => endGrab(id);
window.__lift = (amount) => { lift.holding = true; lift.target = amount; };
window.__drop = () => { lift.holding = false; };
window.__getCat = () => cat;
window.__getLift = () => ({ ...lift });
window.__toyWorld = () => toyWorld;
window.__rug = () => rugLayer.getState();
window.__weather = () => ({
  mode: weatherMode,
  thunderEnabled,
  amounts: { ...weatherAmounts },
  fishCount: fishRain.count,
  maxFish: fishRain.maxCount,
  rainDropCount: rainField.count,
  rainVisible: rainField.group.visible,
  audio: weatherAudio.getState(),
  floorTint: `#${ground.material.color.getHexString()}`,
  lightAngles: { ...lightAngles },
  cloudsVisible: cloudField.group.visible,
  cloudCount: cloudField.count,
  cloudY: cloudField.group.children
    .filter((cloud) => cloud.visible)
    .map((cloud) => Number(cloud.position.y.toFixed(2))),
  thunderFluff: thunderFluffTimer > 0,
  thunderFluffAmount: Number(viewport.dataset.thunderFluffAmount ?? 0),
});
window.__setWeather = setWeather;
window.__setThunder = setThunder;
window.__setWeatherAmount = setWeatherAmount;
window.__animationActions = MESH2MOTION_ACTIONS;
window.__setAnimation = ({
  enabled = params.motionDebug,
  stateMachine = params.motionStateMachine,
  action = params.motionAction,
  speed = params.motionSpeed,
  intensity = params.motionIntensity,
  restart = true,
} = {}) => {
  const wasEnabled = params.motionDebug;
  params.motionDebug = !!enabled;
  if (params.motionDebug) {
    if (!wasEnabled) staticPoseBeforeMotion = params.pose;
    params.pose = 'standing';
  } else if (wasEnabled) {
    params.pose = staticPoseBeforeMotion || 'standing';
  }
  params.motionStateMachine = !!stateMachine;
  params.motionAction = action;
  params.motionSpeed = speed;
  params.motionIntensity = intensity;
  if (restart) motionElapsed = 0;
  refreshers.forEach((refresh) => refresh());
  if (wasEnabled !== params.motionDebug) rebuild('full');
  return window.__getAnimation();
};
window.__getAnimation = () => ({
  enabled: params.motionDebug,
  action: params.motionAction,
  elapsed: motionElapsed,
  speed: params.motionSpeed,
  intensity: params.motionIntensity,
  state: motionRig?.getState(),
  stateMachine: params.motionStateMachine,
  controller: motionMachine.getState(),
  bindingPose: params.motionDebug ? 'standing' : params.pose,
  sourceFrame: motionRig?.getState()?.retarget?.sourceFrame ?? null,
  compatibility: motionRig?.getCompatibility(params.motionAction),
  vertexCount: cat?.getObjectByName('fur')?.geometry?.getAttribute('position')?.count ?? 0,
});
window.__setMotionKey = (code, down = true) => {
  motionMachine.setKey(code, down);
  return motionMachine.getState();
};
window.__triggerMotion = (action) => {
  motionElapsed = 0;
  return motionMachine.trigger(action);
};
window.__resetMotionWorld = () => {
  resetMotionWorld();
  return motionMachine.getState();
};
window.__hatch = hatchUniforms;
window.__zone = (x, y, z) => grabZone(new THREE.Vector3(x, y, z));
// 手动推进模拟（隐藏标签页里 rAF 不跑，自动化验证用）
window.__step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) stepSim(dt); };
window.__pokeState = () => pokeUniforms.uPokeOff.value.map((v) => +v.length().toFixed(4));
window.__setHatch = ({ freq, width, jitter, style, dashStretch } = {}) => {
  if (freq !== undefined) hatchUniforms.uHatchFreq.value = freq;
  if (width !== undefined) hatchUniforms.uHatchWidth.value = width;
  if (jitter !== undefined) hatchUniforms.uHatchJitter.value = jitter;
  if (style !== undefined) hatchUniforms.uHatchStyle.value = style;
  if (dashStretch !== undefined) hatchUniforms.uHatchDashStretch.value = dashStretch;
};
