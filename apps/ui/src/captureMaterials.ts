import { Mesh } from 'three';
import type { IUniform, Material, Object3D } from 'three';

/** Desaturate model pixels only, after the existing tone/output color pipeline. */
export function configureCaptureMaterials(root: Object3D, captureGray: IUniform<number>): void {
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh)
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material);
  });
  for (const material of materials) {
    const originalCompile = material.onBeforeCompile;
    const originalCacheKey = material.customProgramCacheKey();
    material.onBeforeCompile = function (shader, renderer) {
      originalCompile.call(this, shader, renderer);
      shader.uniforms.uCaptureGray = captureGray;
      shader.fragmentShader = `uniform float uCaptureGray;\n${shader.fragmentShader}`.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float captureLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(captureLuma), uCaptureGray);`,
      );
    };
    material.customProgramCacheKey = function () {
      return `${originalCacheKey}|model-capture-gray-v1`;
    };
    material.needsUpdate = true;
  }
}
