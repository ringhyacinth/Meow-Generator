import assert from 'node:assert/strict';
import {
  createToyShadowProxy,
  TOY_SHADOW_PROFILES,
  TOY_SHADOW_SURFACE_Y,
} from '../src/toys.js';

const kinds = ['ball', 'yarn', 'duck', 'fish', 'bed'];

for (const kind of kinds) {
  const radius = 0.4;
  const proxy = createToyShadowProxy(kind, radius);
  const caster = proxy.children[0];

  assert.equal(
    proxy.position.y,
    TOY_SHADOW_SURFACE_Y,
    `${kind} shadow must stay on the contact layer`
  );
  assert.equal(
    caster.geometry.type,
    'CircleGeometry',
    `${kind} shadow must not use a square proxy`
  );
  assert.equal(caster.castShadow, true, `${kind} contact proxy must cast a shadow`);
  assert.equal(
    caster.material.colorWrite,
    false,
    `${kind} proxy must be invisible in the color pass`
  );
  assert.equal(
    caster.material.depthWrite,
    false,
    `${kind} proxy must not occlude the toy`
  );
  assert.equal(
    caster.customDepthMaterial.depthWrite,
    true,
    `${kind} proxy must write shadow depth`
  );
  assert.equal(
    caster.customDepthMaterial.colorWrite,
    true,
    `${kind} shadow depth pass must stay enabled`
  );
  assert.equal(
    caster.scale.x,
    radius * TOY_SHADOW_PROFILES[kind].x,
    `${kind} proxy width must follow its silhouette profile`
  );
  assert.equal(
    caster.scale.y,
    radius * TOY_SHADOW_PROFILES[kind].z,
    `${kind} proxy depth must follow its silhouette profile`
  );
}

console.log(JSON.stringify({
  status: 'ok',
  kinds,
  surfaceY: TOY_SHADOW_SURFACE_Y,
  geometry: 'CircleGeometry',
}, null, 2));
