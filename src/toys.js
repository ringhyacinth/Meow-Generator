import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createRng } from './rng.js';
import { createFlatFishFin, createFlatFishTail } from './fishTail.js';

export const FISH_GRAB_HIT_AREA = Object.freeze({
  width: 0.82,
  height: 0.34,
  depth: 0.3,
  centerX: -0.065,
});

export function createFishGrabHitArea() {
  const area = new THREE.Mesh(
    new THREE.BoxGeometry(
      FISH_GRAB_HIT_AREA.width,
      FISH_GRAB_HIT_AREA.height,
      FISH_GRAB_HIT_AREA.depth
    ),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    })
  );
  area.name = 'fish-grab-hit-area';
  area.position.x = FISH_GRAB_HIT_AREA.centerX;
  area.userData.toyPickSurface = true;
  area.userData.skipShadow = true;
  area.castShadow = false;
  return area;
}

/**
 * 猫周围的玩具 + 刚体物理（cannon-es）。
 * 玩具可被鼠标抓起拖拽、甩出去摔；与地面、彼此、猫身碰撞。
 * 视觉与猫同语言：Toon 材质 + 反壳描边 + 投影进素描影子。
 */

const OUTLINE_COLOR = '#4a3428';
// 刚体仍真实落地；只把可见网格抬高约 1–2 像素，防止反壳描边被接触面吞掉。
const VISUAL_CONTACT_LIFT = 0.01;
// 玩具使用贴地的独立阴影代理。真实网格会随物理碰撞弹起、翻滚；如果直接
// 接受斜向主光投影，小体积玩具的影子会被放大到离本体很远。代理始终贴近
// 地面/地毯接触层，只把轮廓写入 ShadowMap，不参与正常颜色和深度渲染。
export const TOY_SHADOW_SURFACE_Y = 0.055;
export const TOY_SHADOW_PROFILES = Object.freeze({
  bed: Object.freeze({ x: 0.92, z: 0.75 }),
  yarn: Object.freeze({ x: 0.92, z: 0.75 }),
  ball: Object.freeze({ x: 0.95, z: 0.78 }),
  fish: Object.freeze({ x: 0.98, z: 0.42 }),
  duck: Object.freeze({ x: 0.82, z: 0.62 }),
  toy: Object.freeze({ x: 0.88, z: 0.68 }),
});

export function createToyShadowProxy(kind, radius) {
  const profile = TOY_SHADOW_PROFILES[kind] ?? TOY_SHADOW_PROFILES.toy;
  const geometry = new THREE.CircleGeometry(1, 32);
  const material = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    side: THREE.DoubleSide,
    colorWrite: false,
    depthWrite: false,
  });
  const caster = new THREE.Mesh(geometry, material);
  caster.name = `${kind}-contact-shadow-caster`;
  caster.rotation.x = -Math.PI / 2;
  caster.scale.set(radius * profile.x, radius * profile.z, 1);
  caster.castShadow = true;
  caster.receiveShadow = false;
  caster.userData.toyShadowProxy = true;
  // The color-pass material must not touch the framebuffer, while the shadow
  // pass still needs a normal depth writer. Without this explicit override,
  // Three.js inherits `depthWrite: false` and the proxy casts no shadow at all.
  caster.customDepthMaterial = new THREE.MeshDepthMaterial({
    side: THREE.DoubleSide,
    depthWrite: true,
    colorWrite: true,
  });

  const proxy = new THREE.Group();
  proxy.name = `${kind}-contact-shadow-proxy`;
  proxy.position.y = TOY_SHADOW_SURFACE_Y;
  proxy.userData.toyShadowProxy = true;
  proxy.add(caster);
  return proxy;
}

function toonMat(color, gradientMap) {
  return new THREE.MeshToonMaterial({ color, gradientMap });
}

function gradientMap() {
  const data = new Uint8Array([232, 255]);
  const tex = new THREE.DataTexture(data, 2, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// 反壳描边
function outlineOf(geo, thickness = 0.01) {
  const og = geo.clone();
  const op = og.getAttribute('position');
  const on = og.getAttribute('normal');
  for (let i = 0; i < op.count; i++) {
    op.setXYZ(
      i,
      op.getX(i) + on.getX(i) * thickness,
      op.getY(i) + on.getY(i) * thickness,
      op.getZ(i) + on.getZ(i) * thickness
    );
  }
  op.needsUpdate = true;
  return new THREE.Mesh(og, new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide }));
}

// 毛线球纹理：底色 + 缠绕线
function yarnTexture(base, thread) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = thread;
  g.lineWidth = 4;
  g.globalAlpha = 0.75;
  for (let i = 0; i < 10; i++) {
    g.beginPath();
    const y0 = 12 + i * 24;
    g.moveTo(0, y0);
    g.bezierCurveTo(85, y0 + 34 * (i % 2 ? 1 : -1), 170, y0 - 34 * (i % 2 ? 1 : -1), 256, y0);
    g.stroke();
  }
  g.globalAlpha = 0.45;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    const x0 = 20 + i * 42;
    g.moveTo(x0, 0);
    g.bezierCurveTo(x0 + 30, 85, x0 - 30, 170, x0, 256);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 小鱼布偶纹理：低对比度弯曲条纹，保留手绘与布面感。
function fishTexture(base, accent) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = accent;
  g.lineCap = 'round';
  g.globalAlpha = 0.4;
  for (let i = 0; i < 4; i++) {
    const x = 58 + i * 46;
    g.lineWidth = 9 + (i % 2) * 2;
    g.beginPath();
    g.moveTo(x, 24);
    g.bezierCurveTo(x - 17, 88, x + 20, 164, x - 4, 232);
    g.stroke();
  }
  g.globalAlpha = 0.2;
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(18, 184);
  g.bezierCurveTo(72, 160, 184, 208, 238, 168);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createToyWorld(scene) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  const mat = new CANNON.Material('toy');
  world.addContactMaterial(new CANNON.ContactMaterial(mat, mat, { friction: 0.35, restitution: 0.4 }));
  world.defaultContactMaterial.friction = 0.35;
  world.defaultContactMaterial.restitution = 0.4;

  // 地面
  const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: mat, shape: new CANNON.Plane() });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const grad = gradientMap();
  const group = new THREE.Group();
  group.name = 'toys';
  scene.add(group);

  const toys = []; // { mesh, body, kind, radius, baseRadius, scale, ... }
  let currentCatColliders = [];
  const fishEyes = [];
  const fishWorldPos = new THREE.Vector3();
  const fishWorldQuat = new THREE.Quaternion();
  const fishLocalView = new THREE.Vector3();
  const fishEyeView = new THREE.Vector3();
  const toyShadowEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  function snapshotShape(shape, offset) {
    const base = {
      offset: new CANNON.Vec3(offset.x, offset.y, offset.z),
      type: 'other',
    };
    if (shape instanceof CANNON.Sphere) {
      base.type = 'sphere';
      base.radius = shape.radius;
    } else if (shape instanceof CANNON.Box) {
      base.type = 'box';
      base.halfExtents = new CANNON.Vec3(
        shape.halfExtents.x,
        shape.halfExtents.y,
        shape.halfExtents.z
      );
    }
    return base;
  }

  function addToy(mesh, body, radius, kind = 'toy') {
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      // 可见模型只负责自身 Toon 明暗；统一由贴地代理产生完整、不漂移的影子。
      // 这也避免透明命中盒、反壳描边和双面鱼鳍把阴影扩成方块或毛边。
      o.castShadow = false;
    });
    const shadowProxy = createToyShadowProxy(kind, radius);
    group.add(mesh, shadowProxy);
    world.addBody(body);
    toys.push({
      mesh,
      shadowProxy,
      body,
      kind,
      radius,
      baseRadius: radius,
      scale: 1,
      baseMass: body.mass,
      baseMeshScale: mesh.scale.clone(),
      baseShapes: body.shapes.map((shape, index) => snapshotShape(shape, body.shapeOffsets[index])),
    });
  }

  function setToyScale(toy, factor) {
    toy.scale = factor;
    toy.radius = toy.baseRadius * factor;
    toy.mesh.scale.set(
      toy.baseMeshScale.x * factor,
      toy.baseMeshScale.y * factor,
      toy.baseMeshScale.z * factor
    );
    toy.shadowProxy.scale.setScalar(factor);

    for (let i = 0; i < toy.body.shapes.length; i++) {
      const shape = toy.body.shapes[i];
      const base = toy.baseShapes[i];
      toy.body.shapeOffsets[i].set(
        base.offset.x * factor,
        base.offset.y * factor,
        base.offset.z * factor
      );
      if (base.type === 'sphere') {
        shape.radius = base.radius * factor;
        shape.updateBoundingSphereRadius();
      } else if (base.type === 'box') {
        shape.halfExtents.set(
          base.halfExtents.x * factor,
          base.halfExtents.y * factor,
          base.halfExtents.z * factor
        );
        shape.updateConvexPolyhedronRepresentation();
        shape.updateBoundingSphereRadius();
      }
    }

    toy.body.mass = toy.baseMass * Math.pow(factor, 2.35);
    toy.body.updateMassProperties();
    toy.body.updateBoundingRadius();
    toy.body.aabbNeedsUpdate = true;
    toy.body.wakeUp();
  }

  function restingBodyY(toy) {
    let minY = Infinity;
    for (let i = 0; i < toy.body.shapes.length; i++) {
      const shape = toy.body.shapes[i];
      const offset = toy.body.shapeOffsets[i];
      if (shape instanceof CANNON.Sphere) {
        minY = Math.min(minY, offset.y - shape.radius);
      } else if (shape instanceof CANNON.Box) {
        minY = Math.min(minY, offset.y - shape.halfExtents.y);
      }
    }
    return Number.isFinite(minY) ? Math.max(0.016, 0.016 - minY) : toy.radius + 0.016;
  }

  // ---- 猫窝：浅碗 ---------------------------------------------------------
  {
    const pts = [];
    // 碗形剖面：底 → 外壁 → 圆唇 → 内壁
    pts.push(new THREE.Vector2(0, 0.02));
    pts.push(new THREE.Vector2(0.3, 0.02));
    pts.push(new THREE.Vector2(0.4, 0.05));
    pts.push(new THREE.Vector2(0.44, 0.14));
    pts.push(new THREE.Vector2(0.42, 0.2));
    pts.push(new THREE.Vector2(0.36, 0.18));
    pts.push(new THREE.Vector2(0.32, 0.08));
    pts.push(new THREE.Vector2(0, 0.07));
    const bowlGeo = new THREE.LatheGeometry(pts, 36);
    bowlGeo.computeVertexNormals();
    const bowl = new THREE.Mesh(bowlGeo, toonMat('#c9a06a', grad));
    const cushion = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.05, 28), toonMat('#8a5a3c', grad));
    cushion.position.y = 0.075;
    const bed = new THREE.Group();
    bed.add(bowl, cushion, outlineOf(bowlGeo, 0.012));
    const body = new CANNON.Body({
      mass: 1.2, material: mat,
      position: new CANNON.Vec3(-1.25, 0.4, -0.5),
      linearDamping: 0.3, angularDamping: 0.6,
    });
    // 视觉原点在碗底，碰撞盒中心抬到半高对齐
    // 碰撞底面略低于视觉原点，让包含描边的碗底停在地板上方。
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.4, 0.123, 0.4)), new CANNON.Vec3(0, 0.11, 0));
    addToy(bed, body, 0.56, 'bed');
  }

  // ---- 毛线球 x5：大小和配色错落，避免像复制粘贴 --------------------------
  const yarnDefs = [
    { r: 0.15, base: '#e2718a', thread: '#b34a63', pos: [1.05, 0.5, 0.55] },
    { r: 0.12, base: '#6f9fd8', thread: '#46699a', pos: [1.35, 0.5, -0.35] },
    { r: 0.085, base: '#8bc7a2', thread: '#4f8b68', pos: [-1.3, 0.42, 0.45] },
    { r: 0.11, base: '#b8a0d8', thread: '#7c63a3', pos: [0.45, 0.46, -1.12] },
    { r: 0.18, base: '#e8a466', thread: '#b76e3f', pos: [-0.35, 0.54, 1.2] },
  ];
  for (const d of yarnDefs) {
    const geo = new THREE.SphereGeometry(d.r, 24, 18);
    const mesh = new THREE.Group();
    const ball = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ map: yarnTexture(d.base, d.thread), gradientMap: grad }));
    mesh.add(ball, outlineOf(geo, 0.009));
    const body = new CANNON.Body({
      mass: 0.25, material: mat,
      // 刚体半径包含反壳描边，避免球体最下缘被地板吞掉。
      shape: new CANNON.Sphere(d.r + 0.009),
      position: new CANNON.Vec3(...d.pos),
      linearDamping: 0.25, angularDamping: 0.25,
    });
    addToy(mesh, body, d.r + 0.009, 'yarn');
  }

  // ---- 小皮球 -------------------------------------------------------------
  {
    const r = 0.1;
    const geo = new THREE.SphereGeometry(r, 22, 16);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#e9c46a'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#e76f51'; g.fillRect(0, 22, 128, 20);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Group();
    mesh.add(
      new THREE.Mesh(geo, new THREE.MeshToonMaterial({ map: tex, gradientMap: grad })),
      outlineOf(geo, 0.008)
    );
    const body = new CANNON.Body({
      mass: 0.15, material: mat,
      shape: new CANNON.Sphere(r + 0.008),
      position: new CANNON.Vec3(-0.75, 0.4, 0.95),
      linearDamping: 0.2, angularDamping: 0.2,
    });
    addToy(mesh, body, r + 0.008, 'ball');
  }

  // ---- 小鱼布偶 x3 --------------------------------------------------------
  // 椭圆身体、三角尾鳍与小眼睛都使用 Toon + 反壳描边；刚体可抓取和碰撞。
  const fishDefs = [
    { base: '#7fb7a8', accent: '#4e8178', fin: '#e8a66d', pos: [-0.82, 0.28, 0.22], yaw: -0.45 },
    { base: '#f0a4a8', accent: '#bd6c73', fin: '#f2c46f', pos: [0.82, 0.28, 0.92], yaw: 0.5 },
    { base: '#8da9d4', accent: '#5f77a5', fin: '#e5a277', pos: [0.08, 0.28, 1.02], yaw: -0.08 },
  ];
  for (const d of fishDefs) {
    const fish = new THREE.Group();
    fish.name = 'fishToy';

    const bodyGeo = new THREE.SphereGeometry(0.155, 24, 18);
    bodyGeo.scale(1.62, 0.72, 0.52);
    const bodyPosition = bodyGeo.getAttribute('position');
    for (let i = 0; i < bodyPosition.count; i++) {
      const x = bodyPosition.getX(i);
      const headBias = THREE.MathUtils.clamp((x + 0.251) / 0.502, 0, 1);
      const taper = THREE.MathUtils.lerp(0.76, 1.03, headBias);
      bodyPosition.setY(i, bodyPosition.getY(i) * taper);
      bodyPosition.setZ(i, bodyPosition.getZ(i) * THREE.MathUtils.lerp(0.84, 1.02, headBias));
    }
    bodyPosition.needsUpdate = true;
    bodyGeo.computeVertexNormals();
    bodyGeo.computeBoundingSphere();
    const bodyMesh = new THREE.Mesh(bodyGeo, new THREE.MeshToonMaterial({
      map: fishTexture(d.base, d.accent),
      gradientMap: grad,
    }));
    bodyMesh.name = 'fish-pick-surface';
    bodyMesh.userData.toyPickSurface = true;
    fish.add(
      bodyMesh,
      outlineOf(bodyGeo, 0.009)
    );

    // 透明命中体覆盖鱼身、鱼鳍和尾巴，让抓取手感按完整轮廓计算。
    // 它只参与射线拾取，不渲染、也不改变 Cannon 刚体碰撞范围。
    fish.add(createFishGrabHitArea());

    fish.add(createFlatFishTail({
      rootX: -0.205,
      rearX: -0.39,
      halfHeight: 0.12,
      color: d.fin,
      gradientMap: grad,
      outlineColor: OUTLINE_COLOR,
    }));

    const dorsalFin = createFlatFishFin({
      rootWidth: 0.11,
      height: 0.13,
      sweep: -0.025,
      color: d.fin,
      gradientMap: grad,
      outlineColor: OUTLINE_COLOR,
    });
    dorsalFin.position.set(-0.025, 0.092, 0);
    dorsalFin.rotation.z = -0.08;
    fish.add(dorsalFin);

    for (const side of [-1, 1]) {
      const sideFin = createFlatFishFin({
        rootWidth: 0.125,
        height: 0.15,
        sweep: -0.05,
        color: d.fin,
        gradientMap: grad,
        outlineColor: OUTLINE_COLOR,
      });
      sideFin.position.set(0.005, -0.012, side * 0.079);
      sideFin.rotation.set(side * -0.12, 0, -1.02);
      sideFin.scale.setScalar(0.94);
      fish.add(sideFin);
    }

    // 眼白固定长在鱼头侧面，只让瞳孔沿眼球表面追随镜头。
    // 镜头绕到背面时，眼睛会由鱼身的真实深度关系自然遮挡。
    for (const side of [-1, 1]) {
      const eyeRoot = new THREE.Group();
      eyeRoot.name = `fish-eye-${side > 0 ? 'front' : 'back'}`;
      eyeRoot.position.set(0.14, 0.035, side * 0.073);
      if (side < 0) eyeRoot.rotation.y = Math.PI;

      const eyeOutline = new THREE.Mesh(
        new THREE.CircleGeometry(0.034, 24),
        new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.DoubleSide })
      );
      eyeOutline.position.z = 0.001;
      const eyeWhite = new THREE.Mesh(
        new THREE.CircleGeometry(0.0285, 24),
        new THREE.MeshBasicMaterial({ color: '#fff8e8', side: THREE.DoubleSide })
      );
      eyeWhite.position.z = 0.002;
      const pupil = new THREE.Mesh(
        new THREE.CircleGeometry(0.0115, 20),
        new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.DoubleSide })
      );
      pupil.position.z = 0.003;
      eyeRoot.add(eyeOutline, eyeWhite, pupil);
      fish.add(eyeRoot);
      fishEyes.push({
        fish,
        eyeRoot,
        pupil,
        side,
        outward: new THREE.Vector3(0, 0, side),
      });
    }

    const body = new CANNON.Body({
      mass: 0.16,
      material: mat,
      position: new CANNON.Vec3(...d.pos),
      linearDamping: 0.3,
      angularDamping: 0.38,
    });
    // 尾鳍的垂直半径比鱼身更大，碰撞盒按完整轮廓而不是只按椭圆身体计算。
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.34, 0.125, 0.13)));
    body.quaternion.setFromEuler(0, d.yaw, 0);
    addToy(fish, body, 0.37, 'fish');
  }

  // ---- 小鸭子 x3 ----------------------------------------------------------
  // 圆身体、圆头、扁嘴、小翅膀与短尾均使用 Toon + 反壳描边，
  // 并以不同缩放接入独立刚体、抓取与猫身碰撞。
  const duckDefs = [
    { scale: 0.78, pos: [-1.2, 0.34, 0.66], yaw: -0.22 },
    { scale: 1, pos: [1.2, 0.38, -0.72], yaw: 0.32 },
    { scale: 1.18, pos: [0.18, 0.42, 1.25], yaw: -0.48 },
  ];
  for (const definition of duckDefs) {
    const scale = definition.scale;
    const duck = new THREE.Group();
    duck.name = 'duckToy';
    const addOutlinedPart = (geometry, color, outline = 0.007) => {
      duck.add(
        new THREE.Mesh(geometry, toonMat(color, grad)),
        outlineOf(geometry, outline)
      );
    };

    const bodyGeo = new THREE.SphereGeometry(0.145, 24, 18);
    bodyGeo.scale(1.22, 0.88, 0.92);
    bodyGeo.translate(-0.035, 0.015, 0);
    addOutlinedPart(bodyGeo, '#f2c94c', 0.009);

    const headGeo = new THREE.SphereGeometry(0.108, 22, 16);
    headGeo.scale(1.02, 1.04, 0.98);
    headGeo.translate(0.105, 0.145, 0);
    addOutlinedPart(headGeo, '#f7d65e', 0.008);

    // 扁圆嘴比三角锥更像柔软布偶，也不容易出现尖锐穿模。
    const beakGeo = new THREE.SphereGeometry(0.066, 18, 12);
    beakGeo.scale(1.32, 0.38, 0.7);
    beakGeo.translate(0.215, 0.125, 0);
    addOutlinedPart(beakGeo, '#ee9145', 0.006);

    for (const side of [-1, 1]) {
      const wingGeo = new THREE.SphereGeometry(0.08, 16, 12);
      wingGeo.scale(1.2, 0.46, 0.32);
      wingGeo.rotateY(side * 0.25);
      wingGeo.translate(-0.045, 0.03, side * 0.115);
      addOutlinedPart(wingGeo, '#dfa934', 0.006);

      const eyeGeo = new THREE.SphereGeometry(0.016, 12, 8);
      eyeGeo.translate(0.166, 0.174, side * 0.084);
      duck.add(new THREE.Mesh(eyeGeo, new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR })));

      const highlightGeo = new THREE.SphereGeometry(0.0055, 8, 6);
      highlightGeo.translate(0.171, 0.18, side * 0.097);
      duck.add(new THREE.Mesh(highlightGeo, new THREE.MeshBasicMaterial({ color: '#fff9e8' })));

      const footGeo = new THREE.SphereGeometry(0.043, 14, 9);
      footGeo.scale(1.35, 0.28, 0.72);
      footGeo.translate(0.015, -0.102, side * 0.075);
      addOutlinedPart(footGeo, '#ee9145', 0.005);
    }

    const tailGeo = new THREE.ConeGeometry(0.06, 0.12, 3);
    tailGeo.rotateZ(Math.PI / 2);
    tailGeo.translate(-0.185, 0.055, 0);
    addOutlinedPart(tailGeo, '#f7d65e', 0.006);
    duck.scale.setScalar(scale);

    const body = new CANNON.Body({
      mass: 0.2 * scale * scale,
      material: mat,
      position: new CANNON.Vec3(...definition.pos),
      linearDamping: 0.28,
      angularDamping: 0.42,
    });
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.18 * scale, 0.125 * scale, 0.14 * scale)),
      new CANNON.Vec3(-0.035 * scale, 0.015 * scale, 0)
    );
    body.addShape(
      new CANNON.Sphere(0.108 * scale),
      new CANNON.Vec3(0.105 * scale, 0.145 * scale, 0)
    );
    body.addShape(
      new CANNON.Sphere(0.066 * scale),
      new CANNON.Vec3(0.215 * scale, 0.125 * scale, 0)
    );
    body.quaternion.setFromEuler(0, definition.yaw, 0);
    addToy(duck, body, 0.32 * scale, 'duck');
  }

  // ---- 猫身碰撞体（静态球组，随重建更新）----------------------------------
  let catBody = null;
  let catColliderSource = [];
  function setCatColliders(spheres) {
    if (catBody) world.removeBody(catBody);
    catColliderSource = spheres.map((s) => ({
      x: s.c.x,
      y: s.c.y,
      z: s.c.z,
      r: s.r,
    }));
    currentCatColliders = spheres.map((s) => ({
      x: s.c.x,
      y: s.c.y,
      z: s.c.z,
      r: s.r,
    }));
    catBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: mat });
    for (const s of spheres) {
      catBody.addShape(new CANNON.Sphere(s.r), new CANNON.Vec3(s.c.x, s.c.y, s.c.z));
    }
    world.addBody(catBody);
  }

  function setCatTransform(x = 0, z = 0, yaw = 0) {
    if (!catBody) return;
    catBody.position.set(x, 0, z);
    catBody.quaternion.setFromEuler(0, yaw, 0);
    catBody.aabbNeedsUpdate = true;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    currentCatColliders = catColliderSource.map((collider) => ({
      x: x + collider.x * c + collider.z * s,
      y: collider.y,
      z: z - collider.x * s + collider.z * c,
      r: collider.r,
    }));
  }

  // ---- 石头碰撞体（静态球组，随环境重建更新）------------------------------
  let rockBody = null;
  function setRockColliders(spheres) {
    if (rockBody) world.removeBody(rockBody);
    rockBody = null;
    if (!spheres.length) return;
    rockBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: mat });
    for (const s of spheres) {
      rockBody.addShape(new CANNON.Sphere(s.r), new CANNON.Vec3(s.c.x, s.c.y, s.c.z));
    }
    world.addBody(rockBody);
  }

  // 只在随机生成新猫时重抽尺寸和散落点；普通调参不会重置用户拖动过的玩具。
  function randomizeToyScales(rng) {
    const giantCandidates = toys.filter((toy) => toy.kind === 'fish' || toy.kind === 'duck');
    const giants = new Set();
    if (rng.chance(0.38)) {
      giants.add(rng.pick(giantCandidates));
      if (rng.chance(0.1)) {
        const remaining = giantCandidates.filter((toy) => !giants.has(toy));
        if (remaining.length) giants.add(rng.pick(remaining));
      }
    }

    const ranges = {
      bed: [0.82, 1.45],
      yarn: [0.65, 2.25],
      ball: [0.72, 2],
      fish: [0.7, 1.95],
      duck: [0.68, 1.9],
    };

    for (const toy of toys) {
      let factor;
      if (giants.has(toy)) {
        factor = toy.kind === 'fish'
          ? rng.range(3.6, 6.2)
          : rng.range(3.3, 5.8);
      } else {
        const [min, max] = ranges[toy.kind] || [0.75, 1.7];
        factor = rng.range(min, max);
      }
      setToyScale(toy, Math.round(factor * 50) / 50);
    }
  }

  function shuffleWithRng(items, rng) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function isPlacementClear(x, z, radius, placed) {
    for (const other of placed) {
      const minDistance = radius + other.radius + 0.09;
      const dx = x - other.x;
      const dz = z - other.z;
      if (dx * dx + dz * dz < minDistance * minDistance) return false;
    }

    for (const collider of currentCatColliders) {
      const minDistance = radius + collider.r * 0.78 + 0.1;
      const dx = x - collider.x;
      const dz = z - collider.z;
      if (dx * dx + dz * dz < minDistance * minDistance) return false;
    }
    return true;
  }

  function placeToyBody(toy, x, z, yaw, rng) {
    const dropHeight = rng.range(1.45, 3.6) + Math.min(toy.radius * 0.62, 1.35);
    toy.body.position.set(x, restingBodyY(toy) + dropHeight, z);
    toy.body.velocity.set(
      rng.range(-0.24, 0.24),
      rng.range(-0.08, 0.06),
      rng.range(-0.24, 0.24)
    );
    toy.body.angularVelocity.set(
      rng.range(-2.2, 2.2),
      rng.range(-2.2, 2.2),
      rng.range(-2.2, 2.2)
    );
    toy.body.force.set(0, 0, 0);
    toy.body.torque.set(0, 0, 0);
    toy.body.quaternion.setFromEuler(0, yaw, 0);
    toy.body.aabbNeedsUpdate = true;
    toy.body.wakeUp();
  }

  // 新 seed 同时重抽玩具尺寸和位置。大约三至四成玩具落在地毯内，
  // 其余围绕地毯边缘；所有候选点都会避开猫体和已经放好的玩具。
  function scatterAroundRug(bounds, seed) {
    const rng = createRng((seed ^ 0x31d2c88f) >>> 0);
    randomizeToyScales(rng);

    const halfWidth = bounds.width * 0.5;
    const halfDepth = bounds.depth * 0.5;
    const insideTarget = Math.round(toys.length * rng.range(0.3, 0.46));
    const insideEligible = shuffleWithRng(
      toys.filter((toy) => toy.radius < Math.min(halfWidth, halfDepth) * 0.3),
      rng
    );
    const insideSet = new Set(insideEligible.slice(0, insideTarget));
    const ordered = [...toys].sort((a, b) => b.radius - a.radius);
    const placed = [];

    for (const toy of ordered) {
      const wantsInside = insideSet.has(toy);
      let selected = null;

      for (let attempt = 0; attempt < 180; attempt++) {
        let x;
        let z;
        if (wantsInside) {
          const availableX = Math.max(0.18, halfWidth * 0.84 - toy.radius);
          const availableZ = Math.max(0.18, halfDepth * 0.84 - toy.radius);
          const angle = rng.range(0, Math.PI * 2);
          const radial = Math.sqrt(rng.next());
          x = bounds.centerX + Math.cos(angle) * availableX * radial;
          z = bounds.centerZ + Math.sin(angle) * availableZ * radial;
        } else {
          const angle = rng.range(0, Math.PI * 2);
          const gap = rng.range(0.12, 0.56);
          // 半径只加一部分，让外圈玩具有机会自然压住地毯边缘。
          const ringX = halfWidth * rng.range(0.82, 1.02) + toy.radius * 0.62 + gap;
          const ringZ = halfDepth * rng.range(0.82, 1.02) + toy.radius * 0.62 + gap;
          x = bounds.centerX + Math.cos(angle) * ringX;
          z = bounds.centerZ + Math.sin(angle) * ringZ;
        }

        if (isPlacementClear(x, z, toy.radius, placed)) {
          selected = { x, z };
          break;
        }
      }

      // 极端大尺寸或拥挤 seed 的兜底：逐步扩大的黄金角环，仍然检查碰撞。
      if (!selected) {
        for (let attempt = 0; attempt < 120; attempt++) {
          const angle = (placed.length + attempt) * 2.399963229728653;
          const expansion = Math.floor(attempt / 12) * 0.35;
          const ringX = halfWidth * 0.92 + toy.radius + 0.3 + expansion;
          const ringZ = halfDepth * 0.92 + toy.radius + 0.3 + expansion;
          const x = bounds.centerX + Math.cos(angle) * ringX;
          const z = bounds.centerZ + Math.sin(angle) * ringZ;
          if (isPlacementClear(x, z, toy.radius, placed)) {
            selected = { x, z };
            break;
          }
        }
      }

      if (!selected) {
        const angle = placed.length * 2.399963229728653;
        const distance = Math.max(halfWidth, halfDepth) + toy.radius + 2.5 + placed.length * 0.45;
        selected = {
          x: bounds.centerX + Math.cos(angle) * distance,
          z: bounds.centerZ + Math.sin(angle) * distance,
        };
      }

      placeToyBody(toy, selected.x, selected.z, rng.range(-Math.PI, Math.PI), rng);
      placed.push({ x: selected.x, z: selected.z, radius: toy.radius });
    }
  }

  // ---- 鼠标抓取：点对点约束挂到运动学小球上 --------------------------------
  const mouseBody = new CANNON.Body({ type: CANNON.Body.KINEMATIC, shape: new CANNON.Sphere(0.02) });
  mouseBody.collisionResponse = false;
  world.addBody(mouseBody);
  let constraint = null;

  function grabToy(toy, worldPoint) {
    mouseBody.position.set(worldPoint.x, worldPoint.y, worldPoint.z);
    const local = toy.body.pointToLocalFrame(new CANNON.Vec3(worldPoint.x, worldPoint.y, worldPoint.z));
    constraint = new CANNON.PointToPointConstraint(toy.body, local, mouseBody, new CANNON.Vec3(0, 0, 0), 60);
    world.addConstraint(constraint);
    toy.body.angularDamping = 0.7;
    toy.body.wakeUp();
    return constraint;
  }

  function moveGrab(worldPoint) {
    if (!constraint) return;
    mouseBody.position.set(worldPoint.x, Math.max(worldPoint.y, 0.06), worldPoint.z);
  }

  function releaseGrab() {
    if (!constraint) return;
    const toy = toys.find((t) => t.body === constraint.bodyA);
    if (toy) toy.body.angularDamping = 0.25;
    world.removeConstraint(constraint);
    constraint = null;
  }

  function updateFishPupils(camera) {
    group.updateMatrixWorld(true);
    for (const eye of fishEyes) {
      eye.fish.getWorldPosition(fishWorldPos);
      eye.fish.getWorldQuaternion(fishWorldQuat).invert();
      fishLocalView
        .copy(camera.position)
        .sub(fishWorldPos)
        .applyQuaternion(fishWorldQuat)
        .normalize();
      const outwardAmount = fishLocalView.dot(eye.outward);

      // 只显示朝向镜头的一侧，并把瞳孔限制在扁平眼贴内部。
      eye.eyeRoot.visible = outwardAmount > 0.08;
      if (!eye.eyeRoot.visible) continue;

      fishEyeView.copy(fishLocalView);
      fishEyeView.z = 0;
      const lateralLength = Math.min(fishEyeView.length(), 1);
      if (lateralLength > 1e-6) fishEyeView.normalize();
      const maxOffset = 0.0085 * lateralLength;
      eye.pupil.position.set(
        fishEyeView.x * eye.side * maxOffset,
        fishEyeView.y * maxOffset,
        0.003
      );
    }
  }

  function step(dt) {
    world.step(1 / 60, dt, 6);
    for (const t of toys) {
      t.mesh.position.copy(t.body.position);
      t.mesh.position.y += VISUAL_CONTACT_LIFT;
      t.mesh.quaternion.copy(t.body.quaternion);
      t.shadowProxy.position.set(
        t.body.position.x,
        TOY_SHADOW_SURFACE_Y,
        t.body.position.z
      );
      toyShadowEuler.setFromQuaternion(t.mesh.quaternion);
      t.shadowProxy.rotation.y = toyShadowEuler.y;
    }
  }

  return {
    group, toys, world, step, setCatColliders, setCatTransform, setRockColliders,
    grabToy, moveGrab, releaseGrab, scatterAroundRug, updateFishPupils,
    get dragging() { return !!constraint; },
  };
}
