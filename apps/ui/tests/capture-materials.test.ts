import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';

test('capture does not desaturate the shared canvas containing RGB body axes', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.capture\s+\.canvas-host\s*\{[^}]*grayscale/s);
});

test('only mesh materials receive switchable grayscale after the original color pipeline', async () => {
  const module = await import('../src/captureMaterials.ts').catch(() => null);
  assert.ok(module, 'Model-only capture material shader is missing');
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xff9900 });
  const other = new THREE.MeshBasicMaterial({ color: 0x3366ff });
  const geometry = new THREE.BoxGeometry();
  root.add(new THREE.Mesh(geometry, [material, other]), new THREE.Mesh(geometry, material));
  const axes = new THREE.AxesHelper(1);
  root.add(axes);
  const axisCompile = axes.material.onBeforeCompile;
  const captureGray = { value: 1 };
  let originalCalls = 0;
  material.onBeforeCompile = function (shader) {
    assert.equal(this, material);
    originalCalls++;
    shader.uniforms.originalUniform = { value: 2 };
  };
  material.customProgramCacheKey = () => 'existing-key';
  const originalColor = material.color.clone();
  const originalRoughness = material.roughness;
  module.configureCaptureMaterials(root, captureGray);
  assert.equal(axes.material.onBeforeCompile, axisCompile, 'helper shader must remain RGB');
  for (const [mat, kind] of [
    [material, 'standard'],
    [other, 'basic'],
  ] as const) {
    const shader = { ...THREE.ShaderLib[kind], uniforms: {} };
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    assert.equal(shader.uniforms.uCaptureGray, captureGray);
    assert.match(shader.fragmentShader, /uniform float uCaptureGray;/);
    assert.ok(
      shader.fragmentShader.indexOf('gl_FragColor.rgb = vec3(captureLuma)') >
        shader.fragmentShader.indexOf('#include <dithering_fragment>'),
      'capture must assign one luminance value directly to all output channels',
    );
    assert.doesNotMatch(
      shader.fragmentShader,
      /mix\(\s*gl_FragColor\.rgb,\s*vec3\(captureLuma\)/,
      'interpolating from RGB can retain endpoint rounding differences on native ANGLE',
    );
    assert.match(
      shader.fragmentShader,
      /dot\(\s*gl_FragColor.rgb,\s*vec3\(0.2126, 0.7152, 0.0722\)\s*\)/,
    );
    captureGray.value = 0;
    assert.equal(
      shader.uniforms.uCaptureGray.value,
      0,
      'inspect toggles the shared uniform without rebuilding material',
    );
    captureGray.value = 1;
  }
  assert.equal(originalCalls, 1, 'shared mesh materials patched once');
  assert.match(material.customProgramCacheKey(), /^existing-key/);
  assert.notEqual(material.customProgramCacheKey(), other.customProgramCacheKey());
  assert.ok(material.color.equals(originalColor));
  assert.equal(material.roughness, originalRoughness);
  let disposed = false;
  material.addEventListener('dispose', () => {
    disposed = true;
  });
  material.dispose();
  assert.equal(disposed, true, 'original material retains disposal lifecycle');
  other.dispose();
  geometry.dispose();
  axes.geometry.dispose();
  axes.material.dispose();
});
