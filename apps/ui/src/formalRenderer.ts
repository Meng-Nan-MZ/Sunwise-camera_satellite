import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { configureCaptureMaterials } from './captureMaterials.ts';
import { captureCameraParameters, formalProfile as profile } from './formalProfile.ts';
import { toRenderQuaternion } from './scene.ts';
import { matrixRows, projectCaptureBounds } from './captureGeometry.ts';
import type { BridgeTask, CaptureDevice, CaptureResult } from './renderBridge.ts';

function disposeObject(root: THREE.Object3D): void {
  const geometry = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometry.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach((texture) => {
    const data: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    texture.dispose();
  });
  materials.forEach((material) => material.dispose());
  geometry.forEach((item) => item.dispose());
}
/** Sole owner of a hidden fixed-size scene; no references to preview state or objects. */
export class FormalRenderer implements CaptureDevice {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private target = new THREE.Group();
  private camera = new THREE.PerspectiveCamera();
  private sun = new THREE.DirectionalLight(0xffffff);
  private fill = new THREE.DirectionalLight(0xffffff, profile.fill_intensity);
  private environment: THREE.WebGLRenderTarget;
  private asset: THREE.Object3D | null = null;
  private assetKey = '';
  private disposed = false;
  private actualAntialias: boolean;
  private onLost: (event: Event) => void;

  constructor(onContextLost: () => void) {
    if (THREE.REVISION !== profile.three_revision)
      throw new Error('网页引擎版本与正式出图配置不一致。');
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.onLost = (event) => {
      event.preventDefault();
      onContextLost();
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onLost);
    this.renderer.domElement.hidden = true;
    this.renderer.domElement.style.display = 'none';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    document.body.append(this.renderer.domElement);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(profile.internal_resolution, profile.internal_resolution, false);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = profile.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.actualAntialias = Boolean(this.renderer.getContext().getContextAttributes()?.antialias);
    const room = new RoomEnvironment(),
      pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.world.environment = this.environment.texture;
    this.world.environmentIntensity = profile.environment_intensity;
    this.world.add(this.target, this.sun, this.sun.target, this.fill);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(profile.shadow_map_size, profile.shadow_map_size);
    this.sun.shadow.bias = profile.shadow_bias;
  }

  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed || this.renderer.getContext().isContextLost())
      throw new Error('网页正式采集上下文已关闭或丢失。');
  }

  async capture(task: BridgeTask, signal: AbortSignal): Promise<CaptureResult> {
    this.check(signal);
    const start = performance.now(),
      { model, frame } = task;
    const key = `${model.preview_sha256}:${model.preview_url}`;
    if (this.assetKey !== key) {
      if (this.asset) {
        this.target.remove(this.asset);
        disposeObject(this.asset);
        this.asset = null;
        this.assetKey = '';
      }
      const response = await fetch(model.preview_url, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`正式模型读取失败（HTTP ${response.status}）`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
        v.toString(16).padStart(2, '0'),
      ).join('');
      this.check(signal);
      if (digest !== model.preview_sha256.toLowerCase())
        throw new Error('正式 GLB 的 SHA256 校验失败。');
      const manager = new THREE.LoadingManager();
      let resourceFailed = false;
      manager.onError = () => {
        resourceFailed = true;
      };
      const gltf = await new GLTFLoader(manager).parseAsync(
        bytes,
        new URL('.', new URL(model.preview_url, window.location.href)).href,
      );
      try {
        this.check(signal);
        if (resourceFailed) throw new Error('正式模型纹理载入失败。');
      } catch (error) {
        disposeObject(gltf.scene);
        throw error;
      }
      // GLB already uses engine geometry; source_to_body is metadata and is not applied again.
      configureCaptureMaterials(gltf.scene, { value: 1 });
      gltf.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      this.asset = gltf.scene;
      this.assetKey = key;
      this.target.add(this.asset);
    }
    const radius = model.radius_m,
      distance = frame.distance_m;
    const { W, X, Y, Z } = frame.sat_quat;
    this.target.quaternion.fromArray(toRenderQuaternion([X, Y, Z, W]));
    Object.assign(this.camera, captureCameraParameters(radius, distance));
    this.camera.aspect = 1;
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(0, 0, distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    const azimuth = THREE.MathUtils.degToRad(frame.lighting.azimuth_deg),
      elevation = THREE.MathUtils.degToRad(frame.lighting.elevation_deg);
    this.sun.position
      .set(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
      )
      .multiplyScalar(radius * profile.shadow_distance_radius);
    this.sun.intensity = frame.lighting.energy;
    const shadow = this.sun.shadow.camera,
      extent = radius * profile.shadow_extent_radius;
    Object.assign(shadow, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      near: Math.max(0.001, radius * 0.001),
      far: radius * profile.shadow_far_radius,
    });
    shadow.updateProjectionMatrix();
    this.sun.shadow.normalBias = radius * profile.shadow_normal_bias_radius;
    this.fill.position.fromArray([...profile.fill_position_radius]).multiplyScalar(radius);
    this.world.updateMatrixWorld(true);
    const bbox = projectCaptureBounds(this.target, this.camera, profile.output_resolution);
    this.check(signal);
    this.renderer.render(this.world, this.camera);
    this.check(signal);
    const png = this.renderer.domElement.toDataURL('image/png');
    if (!png.startsWith('data:image/png;base64,')) throw new Error('无法编码正式 PNG。');
    return {
      png_base64: png.slice(png.indexOf(',') + 1),
      metadata: {
        bbox_xyxy: bbox,
        camera_world: matrixRows(this.camera.matrixWorld),
        projection_matrix: matrixRows(this.camera.projectionMatrix),
        asset_sha256: model.preview_sha256,
        three_revision: THREE.REVISION,
        profile_id: profile.profile_id,
        settings: { ...profile, actual_antialias: this.actualAntialias },
        render_ms: performance.now() - start,
      },
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.asset) disposeObject(this.asset);
    this.asset = null;
    this.environment.dispose();
    this.sun.shadow.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
