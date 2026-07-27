import assert from 'node:assert/strict';
import {
  MESH2MOTION_ACTIONS,
  getRigCompatibility,
  sampleGaitFoot,
  sampleMesh2MotionAction,
} from '../src/mesh2motionRig.js';
import {
  MOTION_ACTION_HOTKEYS,
  MOTION_POSTURE_HOTKEYS,
  createCatMotionStateMachine,
} from '../src/catMotionStateMachine.js';
import {
  MESH2MOTION_SOURCE_INFO,
  SOURCE_BONE_ORDER,
  getSourceClip,
  sampleMesh2MotionSource,
} from '../src/mesh2motionSource.js';
import {
  MESH2MOTION_SKIN_INFO,
  computeProportionMotionSafety,
  sampleLegSkinWeights,
} from '../src/mesh2motionSkinRig.js';
import { POSES } from '../src/coats.js';
import {
  CONTAINER_TYPES,
  createContainer,
  getContainerDescriptor,
} from '../src/container.js';
import { meshFromSDF, roundCone, roundedBox, sphere } from '../src/sdf.js';
import { WEATHER_AMOUNT_LIMITS } from '../src/weather.js';
import {
  CAT_MESH_QUALITY,
  EYE_SPACING_RANGE,
  resolveEyeHorizontalOffset,
  resolveCatMeshCellSize,
} from '../src/catBuilder.js';
import { createFlatFishTail } from '../src/fishTail.js';

const poses = [
  'standing',
  'loaf',
  'stretch',
  'biped',
  'slouchSit',
  'sideFlat',
  'banana',
];
assert.equal(
  resolveEyeHorizontalOffset(1, EYE_SPACING_RANGE.max),
  0.52,
  'the previous eye distance must remain the manual maximum'
);
assert.equal(
  resolveEyeHorizontalOffset(1, EYE_SPACING_RANGE.max + 1),
  0.52,
  'eye spacing must never exceed the previous eye distance'
);
assert.equal(
  resolveEyeHorizontalOffset(1, EYE_SPACING_RANGE.min),
  0.52 * EYE_SPACING_RANGE.min,
  'the minimum must move both eyes inward without changing eye size'
);
assert.equal(
  resolveEyeHorizontalOffset(1),
  0.52,
  'missing legacy parameters must preserve the current eye distance'
);
assert.ok(
  POSES.some(({ id }) => id === 'containerCrouch'),
  'static pose catalog must expose the container crouch pose'
);
const sampledContainerTypes = new Set(
  Array.from({ length: 512 }, (_, seed) => getContainerDescriptor(seed).id)
);
assert.deepEqual(
  [...sampledContainerTypes].sort(),
  CONTAINER_TYPES.map(({ id }) => id).sort(),
  'container randomizer must be able to reach every container type'
);
const renderedContainer = createContainer(17, { fitScale: 1.25 });
assert.ok(renderedContainer.children.length >= 2, 'container generator must build visible geometry');
assert.ok(renderedContainer.userData.container?.id, 'container geometry must retain export metadata');
assert.ok(
  renderedContainer.userData.container.rimY > 0.25,
  'container rim must be high enough to visibly occlude the crouching body'
);
assert.ok(
  renderedContainer.scale.x > renderedContainer.scale.y,
  'container fit must widen the opening without making the walls taller'
);
assert.ok(
  renderedContainer.position.z < 0,
  'container opening must be centered around the crouching body footprint'
);
assert.ok(
  renderedContainer.position.y >= 0.015,
  'container base must stay above the rug so its outline remains visible'
);
assert.ok(
  renderedContainer.userData.container.openingWidth > 1,
  'container metadata must expose the fitted opening width to the cat body'
);
assert.ok(
  renderedContainer.userData.container.openingDepth > 1,
  'container metadata must expose the fitted opening depth to the cat body'
);
assert.ok(
  renderedContainer.getObjectByName('flowerpotContactStroke')
    || renderedContainer.children.some(({ name }) => name.endsWith('ContactStroke')),
  'round containers must provide a real base contact stroke above the rug'
);
const fittedCardboard = createContainer(7, { fitScale: 1.25 });
assert.ok(
  fittedCardboard.scale.z > fittedCardboard.scale.x,
  'rectangular containers need extra depth to clear the cat haunches'
);
const compactContainer = createContainer(17, { fitScale: 0.72 });
const oversizedContainer = createContainer(17, { fitScale: 1.5 });
assert.ok(
  oversizedContainer.scale.x > compactContainer.scale.x
    && oversizedContainer.scale.z > compactContainer.scale.z,
  'the cat nest size multiplier must widen and deepen the opening'
);
const containerOutlines = [];
renderedContainer.traverse((object) => {
  if (object.name.endsWith('Outline')) containerOutlines.push(object);
});
assert.ok(containerOutlines.length > 0, 'container parts must retain visible outline shells');
assert.ok(
  containerOutlines.every((outline) => Math.max(outline.scale.x, outline.scale.y, outline.scale.z) <= 1.045),
  'container outline shells must stay close to the cat outline thickness'
);
assert.deepEqual(
  WEATHER_AMOUNT_LIMITS,
  { rain: 4, cloud: 2, fish: 4 },
  'rain and fish must expose the exaggerated four-times range without inflating cloud count'
);
assert.equal(
  resolveCatMeshCellSize('full', 2.8, false),
  CAT_MESH_QUALITY.staticCell,
  'static poses must use the responsive medium-density SDF mesh'
);
assert.equal(
  resolveCatMeshCellSize('full', 2.8, true),
  CAT_MESH_QUALITY.motionCell,
  'dynamic mode must retain the original high-resolution SDF cell size'
);
assert.ok(
  CAT_MESH_QUALITY.motionCell <= 0.02
    && CAT_MESH_QUALITY.staticCell < 0.04,
  'dynamic meshes must stay high-resolution while static meshes avoid the old 0.05 regression'
);
assert.ok(
  Math.pow(
    resolveCatMeshCellSize('full', 2.8, true)
      / resolveCatMeshCellSize('full', 2.8, false),
    3
  ) < 0.25,
  'static poses must sample less than one quarter of the dynamic grid workload'
);
assert.ok(
  resolveCatMeshCellSize('full', 280, false)
    <= CAT_MESH_QUALITY.staticCell * CAT_MESH_QUALITY.staticMaxVolumeScale + 1e-12,
  'extreme static proportions must stay inside the silhouette quality cap'
);
assert.ok(
  resolveCatMeshCellSize('full', 280, true)
    <= CAT_MESH_QUALITY.motionCell * CAT_MESH_QUALITY.motionMaxVolumeScale + 1e-12,
  'extreme dynamic proportions must stay inside the skinning quality cap'
);
assert.ok(
  resolveCatMeshCellSize('draft', 2.8) > resolveCatMeshCellSize('full', 2.8, false),
  'draft slider feedback may stay lighter than the settled full mesh'
);
const flatFishTail = createFlatFishTail({
  rootX: -0.2,
  rearX: -0.4,
  halfHeight: 0.12,
  color: '#e8a66d',
});
assert.equal(
  flatFishTail.userData.fishTailStyle,
  'outlined-triangle-plane',
  'fish tails must use the shared flat outlined style'
);
assert.equal(
  flatFishTail.getObjectByName('fish-tail-fill').geometry.index.count,
  3,
  'fish tail fill must be one triangle rather than a three-sided cone'
);
assert.equal(
  flatFishTail.getObjectByName('fish-tail-fill').material.side,
  2,
  'the flat fish tail must stay visible from both sides'
);
const softFillBox = roundedBox({
  c: { x: 0, y: 0.4, z: 0 },
  half: [0.5, 0.25, 0.45],
  r: 0.16,
});
assert.ok(softFillBox.dist(0, 0.4, 0) < 0, 'container soft fill must contain its center');
assert.ok(softFillBox.dist(0.8, 0.4, 0) > 0, 'container soft fill must reject distant points');
const sparseSurface = meshFromSDF([
  sphere({ c: { x: 0, y: 0.55, z: 0 }, r: 0.42, k: 0.12 }),
  roundCone({
    a: { x: 0.28, y: 0.5, z: -0.24 },
    b: { x: 0.96, y: 0.78, z: -0.82 },
    r1: 0.16,
    r2: 0.08,
    k: 0.08,
  }),
], 0.06);
const sparsePositions = sparseSurface.getAttribute('position');
const sparseNormals = sparseSurface.getAttribute('normal');
assert.ok(sparsePositions.count > 500, 'sparse SDF sampling must retain a detailed connected surface');
for (let index = 0; index < sparsePositions.count; index++) {
  const normalLength = Math.hypot(
    sparseNormals.getX(index),
    sparseNormals.getY(index),
    sparseNormals.getZ(index)
  );
  assert.ok(Number.isFinite(normalLength), 'sparse SDF normals must stay finite');
  assert.ok(normalLength > 0.98 && normalLength < 1.02, 'sparse SDF normals must stay normalized');
}
const numericKeys = [
  'rootLift',
  'rootPitch',
  'rootYaw',
  'rootRoll',
  'rootX',
  'rootZ',
  'squash',
  'crouch',
  'bodyWave',
  'headLift',
  'headX',
  'headThrust',
  'headYaw',
  'gaitAmplitude',
  'stride',
  'tailSway',
];

assert.equal(MESH2MOTION_ACTIONS.length, 14, 'Mesh2Motion catalog must expose all 14 source actions');
assert.equal(new Set(MESH2MOTION_ACTIONS.map(({ id }) => id)).size, 14, 'action ids must be unique');
assert.ok(MESH2MOTION_ACTIONS.every(({ duration, fps, frames }) =>
  duration > 0 && fps > 0 && frames[1] >= frames[0]
), 'source timing metadata must be valid');
assert.equal(MESH2MOTION_SOURCE_INFO.clips, 14, 'all source clips must be embedded');
assert.equal(MESH2MOTION_SOURCE_INFO.bones, 19, 'semantic retarget must retain 19 source landmarks');
assert.ok(MESH2MOTION_SOURCE_INFO.sampledFrames > 500, 'source frame extraction must not collapse into a few hand-authored poses');
assert.equal(MESH2MOTION_SKIN_INFO.type, 'fixed-skinned-mesh');
assert.equal(MESH2MOTION_SKIN_INFO.bones, 19, 'dynamic mode must use the full 19-bone skin');
assert.equal(MESH2MOTION_SKIN_INFO.maxInfluences, 4, 'each frozen SDF vertex must use four continuous weights');
assert.deepEqual(
  computeProportionMotionSafety(1, 0.5, 1),
  { leg: 1, tail: 1 },
  'ordinary proportions must retain the full source motion'
);
const extremeMotionSafety = computeProportionMotionSafety(1, 2.4, 4);
assert.ok(
  extremeMotionSafety.leg < 0.4 && extremeMotionSafety.tail < 0.4,
  'extreme limbs must automatically reduce unsafe local rotation arcs'
);
assert.deepEqual(
  Object.keys(MESH2MOTION_SKIN_INFO.parents),
  SOURCE_BONE_ORDER,
  'skin hierarchy must cover every source semantic bone in source order'
);
for (const boneName of SOURCE_BONE_ORDER) {
  const parentName = MESH2MOTION_SKIN_INFO.parents[boneName];
  assert.ok(
    parentName === null || SOURCE_BONE_ORDER.includes(parentName),
    `${boneName} must have a valid skin parent`
  );
}

for (const prefix of ['frontL', 'frontR', 'backL', 'backR']) {
  const top = sampleLegSkinWeights(prefix, 0);
  const knee = sampleLegSkinWeights(prefix, 0.52);
  const paw = sampleLegSkinWeights(prefix, 1);
  assert.deepEqual(top, [
    [`${prefix}Upper`, 1],
    [`${prefix}Lower`, 0],
    [`${prefix}Foot`, 0],
  ]);
  assert.ok(
    knee[1][1] > knee[0][1] && knee[1][1] > knee[2][1],
    `${prefix} knee must remain lower-bone dominant`
  );
  assert.ok(
    knee[0][1] > 0 && knee[2][1] === 0,
    `${prefix} knee must retain upper support without premature foot influence`
  );
  assert.deepEqual(paw, [
    [`${prefix}Upper`, 0],
    [`${prefix}Lower`, 0],
    [`${prefix}Foot`, 1],
  ]);
  for (let step = 0; step <= 20; step++) {
    const weights = sampleLegSkinWeights(prefix, step / 20);
    assert.ok(
      Math.abs(weights.reduce((sum, [, weight]) => sum + weight, 0) - 1) < 1e-8,
      `${prefix} continuous leg weights must stay normalized`
    );
  }
}

const sourceSignatures = new Set();
for (const action of MESH2MOTION_ACTIONS) {
  const clip = getSourceClip(action.id);
  assert.equal(clip.id, action.id, `${action.id} must resolve to its exact source clip`);
  assert.equal(clip.fps, action.fps, `${action.id} must preserve source fps`);
  const sample = sampleMesh2MotionSource(action.id, 0.43);
  assert.ok(sample.values.every(Number.isFinite), `${action.id} source transform values must be finite`);
  assert.ok(
    sample.frame >= clip.frameStart && sample.frame <= clip.frameEnd,
    `${action.id} sampled frame must remain inside the source action`
  );
  sourceSignatures.add(
    [...sample.values].filter((_, index) => index % 7 < 3).map((value) => value.toFixed(4)).join(',')
  );
}
assert.equal(sourceSignatures.size, 14, 'all 14 actions must retain distinct source bone poses');

const signatures = new Set();
let samples = 0;
for (const pose of poses) {
  for (const action of MESH2MOTION_ACTIONS) {
    const compatibility = getRigCompatibility(pose, action.id);
    assert.ok(compatibility.scale > 0 && compatibility.scale <= 1);
    for (const intensity of [0, 0.35, 1, 1.6]) {
      for (const speed of [0.25, 1, 2]) {
        for (const ratio of [0, 0.07, 0.25, 0.5, 0.82, 1.15, 2.4]) {
          const state = sampleMesh2MotionAction(action.id, action.duration * ratio, {
            pose,
            speed,
            intensity,
          });
          for (const key of numericKeys) {
            assert.ok(Number.isFinite(state[key]), `${pose}/${action.id}/${key} must be finite`);
          }
          assert.ok(state.rootLift >= -1e-8, `${pose}/${action.id} must never push the whole cat below ground`);
          assert.ok(Math.abs(state.rootRoll) <= 1.5, `${pose}/${action.id} roll exceeds safety bound`);
          if (intensity === 0) {
            assert.ok(numericKeys.every((key) => Math.abs(state[key]) < 1e-8));
          }
          samples++;
        }
      }
    }
    const signatureState = sampleMesh2MotionAction(action.id, action.duration * 0.37, {
      pose: 'standing',
      speed: 1,
      intensity: 1,
    });
    signatures.add(numericKeys.map((key) => signatureState[key].toFixed(5)).join(','));
  }
}

assert.ok(signatures.size >= 12, 'action profiles should remain meaningfully distinct');

const forwardFootBack = sampleGaitFoot(0, 0.1, 0.08, 0, 1);
const forwardFootHigh = sampleGaitFoot(Math.PI / 2, 0.1, 0.08, 0, 1);
const forwardFootFront = sampleGaitFoot(Math.PI, 0.1, 0.08, 0, 1);
assert.ok(forwardFootBack.forward < 0, 'forward gait must start its swing behind the hip');
assert.ok(forwardFootHigh.lift > 0.099, 'forward gait must lift the foot during the forward swing');
assert.ok(forwardFootFront.forward > 0, 'forward gait must finish its swing in front of the hip');
assert.equal(
  Math.sign(sampleGaitFoot(0, 0.1, 0.08, 0, -1).forward),
  -Math.sign(forwardFootBack.forward),
  'backward travel must reverse the foot cycle'
);

const machine = createCatMotionStateMachine();
machine.setKey('KeyW', true);
let machineFrame;
for (let i = 0; i < 60; i++) machineFrame = machine.update(1 / 60);
assert.equal(machineFrame.action, 'walk');
assert.ok(machineFrame.position.z > 0.5, 'W must move the cat along its forward +Z axis');
assert.equal(machineFrame.travelDirection, 1);

machine.reset();
machine.setKey('KeyS', true);
for (let i = 0; i < 60; i++) machineFrame = machine.update(1 / 60);
assert.equal(machineFrame.action, 'walk');
assert.ok(machineFrame.position.z < -0.3, 'S must move backward');
assert.equal(machineFrame.travelDirection, -1);

const reachableActions = new Set(['idle']);
machine.reset();
machine.setKey('KeyW', true);
reachableActions.add(machine.update(1 / 60).action);
machine.setKey('ShiftLeft', true);
reachableActions.add(machine.update(1 / 60).action);
machine.setKey('ShiftLeft', false);
machine.setKey('ControlLeft', true);
reachableActions.add(machine.update(1 / 60).action);
machine.reset();
for (const [code, action] of Object.entries(MOTION_POSTURE_HOTKEYS)) {
  machine.triggerCode(code);
  reachableActions.add(machine.update(1 / 60).action);
  machine.reset();
}
for (const [code, action] of Object.entries(MOTION_ACTION_HOTKEYS)) {
  machine.triggerCode(code);
  reachableActions.add(machine.update(1 / 60).action);
  machine.reset();
}
assert.deepEqual(
  [...reachableActions].sort(),
  MESH2MOTION_ACTIONS.map(({ id }) => id).sort(),
  'keyboard state machine must make all 14 actions reachable'
);

console.log(JSON.stringify({
  actions: MESH2MOTION_ACTIONS.length,
  poses: poses.length,
  samples,
  uniqueSignatures: signatures.size,
  sourceFrames: MESH2MOTION_SOURCE_INFO.sampledFrames,
  sourceBones: MESH2MOTION_SOURCE_INFO.bones,
  skinType: MESH2MOTION_SKIN_INFO.type,
  skinInfluences: MESH2MOTION_SKIN_INFO.maxInfluences,
  keyboardStates: reachableActions.size,
  gaitDirection: 'forward-corrected',
  status: 'ok',
}, null, 2));
