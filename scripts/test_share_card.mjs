import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  getShareCardDescriptor,
  getShareCardFilename,
  getShareCardSubjectPanOffset,
  SHARE_CARD_REPOSITORY,
} from '../src/shareCard.js';

const first = getShareCardDescriptor(0);
const repeat = getShareCardDescriptor(0);
const nextTheme = getShareCardDescriptor(1);
const normalized = getShareCardDescriptor(-1);

assert.equal(first.serial, '0052');
assert.equal(first.theme.name, 'peach');
assert.deepEqual(first, repeat, 'the same seed should produce the same card');
assert.equal(nextTheme.theme.name, 'sky');
assert.equal(nextTheme.serial, '0125');
assert.deepEqual(normalized, nextTheme, 'negative seeds should normalize consistently');

const catPalette = {
  base: '#f6dfbd',
  primary: '#e6913f',
  secondary: '#ad5d22',
  accent: '#d99a2b',
};
const catSignature = getShareCardDescriptor(42, catPalette);
const alternate = getShareCardDescriptor(42, catPalette, 9876);
const alternateRepeat = getShareCardDescriptor(42, catPalette, 9876);

assert.equal(catSignature.theme.name, 'cat-signature');
assert.equal(catSignature.theme.pattern, 'cat-paws');
assert.equal(catSignature.theme.primary, catPalette.primary);
assert.ok(['R', 'SR', 'AR'].includes(catSignature.rarity));
assert.match(alternate.theme.name, /^cat-remix-/);
assert.notDeepEqual(alternate.theme, catSignature.theme, 'alternate skin should visibly remix the cat palette');
assert.deepEqual(alternate, alternateRepeat, 'the same skin variant should be reproducible');
assert.equal(SHARE_CARD_REPOSITORY.label, 'github.com/ringhyacinth/Meow-Generator');
assert.equal(SHARE_CARD_REPOSITORY.url, 'https://github.com/ringhyacinth/Meow-Generator');
assert.equal(getShareCardFilename(42), 'meow_card_42.png');
assert.equal(getShareCardFilename(-42), 'meow_card_42.png');

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0, 0, 5);
const orbitTarget = new THREE.Vector3(0, 0, 0);
camera.lookAt(orbitTarget);
camera.updateMatrixWorld(true);
const subject = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial()
);
subject.position.set(1, 0, 0);
subject.updateMatrixWorld(true);
const beforeDirection = camera.getWorldDirection(new THREE.Vector3()).clone();
const panOffset = getShareCardSubjectPanOffset({
  camera,
  subject,
  frameRect: { left: 0, top: 0, width: 1000, height: 1000 },
  canvasRect: { left: 0, top: 0, width: 1000, height: 1000 },
});
assert.ok(panOffset.x > 0.9 && panOffset.x < 1.1, 'off-center kitten should pan into the card');
camera.position.add(panOffset);
orbitTarget.add(panOffset);
camera.lookAt(orbitTarget);
camera.updateMatrixWorld(true);
const centered = new THREE.Box3()
  .setFromObject(subject)
  .getCenter(new THREE.Vector3())
  .project(camera);
const afterDirection = camera.getWorldDirection(new THREE.Vector3());
assert.ok(Math.abs(centered.x) < 1e-6, 'camera pan should center the kitten in the card window');
assert.ok(
  beforeDirection.distanceTo(afterDirection) < 1e-8,
  'camera pan must preserve the user rotation angle'
);

console.log('share card descriptor checks passed');
