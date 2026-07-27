import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createFishGrabHitArea,
  FISH_GRAB_HIT_AREA,
} from '../src/toys.js';

const area = createFishGrabHitArea();
area.updateMatrixWorld(true);

function rayHitsAt(x, y) {
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, y, 1),
    new THREE.Vector3(0, 0, -1)
  );
  return raycaster.intersectObject(area, false).length > 0;
}

assert.equal(area.userData.toyPickSurface, true, 'fish hit area must be selectable');
assert.equal(area.material.opacity, 0, 'fish hit area must stay invisible');
assert.equal(area.material.colorWrite, false, 'fish hit area must not alter the frame');
assert.equal(area.castShadow, false, 'the invisible box must never cast a square fish shadow');
assert.equal(area.userData.skipShadow, true, 'toy setup must preserve the no-shadow marker');
assert(
  rayHitsAt(-0.38, 0),
  'the tail-side margin should be draggable outside the narrow body mesh'
);
assert(
  rayHitsAt(0.3, 0.14),
  'the fin-side margin should be draggable outside the narrow body mesh'
);
assert.equal(rayHitsAt(0.5, 0), false, 'the hit area should not capture distant empty space');

console.log(JSON.stringify({
  status: 'ok',
  hitArea: FISH_GRAB_HIT_AREA,
  tailMarginHit: true,
  finMarginHit: true,
  distantMiss: true,
}, null, 2));
