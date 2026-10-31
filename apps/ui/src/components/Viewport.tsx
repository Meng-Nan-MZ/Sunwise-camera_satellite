import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { captureFov } from '../scene';
import { errorMessage } from '../api';
import type { ModelInfo, SceneSettings, ViewMode } from '../types';

interface Props {
  model: ModelInfo | undefined;
  scene: SceneSettings;
  mode: ViewMode;
  axes: boolean;
  safeFrame: boolean;
  reset: number;
  onReady: (modelId: string | null) => void;
}

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  textures.forEach((texture) => {
    const image: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    texture.dispose();
  });
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

export default function Viewport(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState('正在准备三维视口…');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    const model = props.model;
    props.onReady(null);
    if (!host || !model) return;
    setStatus('loading');
    setDetail('正在加载本地模型…');
    const abort = new AbortController();
    let stopped = false;
    let animation = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      captureFov(model.radius_m);
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      setStatus('error');
      setDetail(`无法创建三维视口，请检查显卡与 WebGL 支持。${errorMessage(error)}`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x030609);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    host.appendChild(renderer.domElement);
    const world = new THREE.Scene();
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const inspectionEnvironment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    world.environmentIntensity = 0.7;
    const target = new THREE.Group();
    world.add(target);
    const radius = model.radius_m;
    const axisHelper = new THREE.AxesHelper(radius * 0.85);
    target.add(axisHelper);
    const captureCamera = new THREE.PerspectiveCamera();
    captureCamera.up.set(0, 1, 0);
    const inspectCamera = new THREE.PerspectiveCamera(
      40,
      1,
      Math.max(radius * 0.001, 0.00001),
      radius * 1000,
    );
    inspectCamera.up.set(0, 1, 0);
    const controls = new OrbitControls(inspectCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.enablePan = false;
    controls.minDistance = radius * 1.25;
    controls.maxDistance = radius * 30;
    const resetInspect = () => {
      inspectCamera.position.set(radius * 2.4, radius * 1.6, radius * 3.2);
      controls.target.set(0, 0, 0);
      inspectCamera.lookAt(0, 0, 0);
      controls.update();
    };
    resetInspect();
    const sun = new THREE.DirectionalLight(0xffffff, 4);
    const ambient = new THREE.HemisphereLight(0xdceaff, 0x4e535c, 0.5);
    const fill = new THREE.DirectionalLight(0xc3d9ff, 0.8);
    fill.position.set(-radius * 3, radius * 2, radius * 3);
    world.add(sun, ambient, fill);
    let size = { width: 1, height: 1 };
    const resize = () => {
      size = { width: Math.max(host.clientWidth, 1), height: Math.max(host.clientHeight, 1) };
      renderer.setSize(size.width, size.height, false);
      inspectCamera.aspect = size.width / size.height;
      inspectCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const onLost = (event: Event) => {
      event.preventDefault();
      setStatus('error');
      setDetail('显卡上下文已丢失，请重新加载视口。');
      latest.current.onReady(null);
    };
    renderer.domElement.addEventListener('webglcontextlost', onLost);
    let lastReset = props.reset;
    const animate = () => {
      if (stopped) return;
      const current = latest.current;
      const inspect = current.mode === 'inspect';
      target.quaternion.fromArray(current.scene.quaternion_xyzw);
      axisHelper.visible = current.axes;
      controls.enabled = inspect;
      if (current.reset !== lastReset) {
        resetInspect();
        lastReset = current.reset;
      }
      if (inspect) controls.update();
      ambient.visible = inspect;
      fill.visible = inspect;
      world.environment = inspect ? inspectionEnvironment.texture : null;
      const azimuth = THREE.MathUtils.degToRad(current.scene.lighting.azimuth_deg);
      const elevation = THREE.MathUtils.degToRad(current.scene.lighting.elevation_deg);
      sun.position
        .set(
          Math.cos(elevation) * Math.sin(azimuth),
          Math.sin(elevation),
          Math.cos(elevation) * Math.cos(azimuth),
        )
        .multiplyScalar(radius * 5);
      sun.intensity = inspect ? 2 : current.scene.lighting.energy;
      const distance = current.scene.distance_m;
      captureCamera.position.set(0, 0, distance);
      captureCamera.lookAt(0, 0, 0);
      captureCamera.aspect = size.width / size.height;
      const fov = captureFov(radius);
      captureCamera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(fov / 2) / Math.min(captureCamera.aspect, 1)),
      );
      captureCamera.near = Math.max(0.001, distance - radius * 2);
      captureCamera.far = distance + radius * 2 + 1;
      captureCamera.updateProjectionMatrix();
      renderer.render(world, inspect ? inspectCamera : captureCamera);
      animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);

    void (async () => {
      try {
        const response = await fetch(model.preview_url, { signal: abort.signal });
        if (!response.ok) throw new Error(`模型文件读取失败（HTTP ${response.status}）`);
        const buffer = await response.arrayBuffer();
        if (stopped) return;
        const manager = new THREE.LoadingManager();
        let resourceFailed = false;
        manager.onError = () => {
          resourceFailed = true;
        };
        const gltf = await new GLTFLoader(manager).parseAsync(
          buffer,
          new URL('.', new URL(model.preview_url, window.location.href)).href,
        );
        if (stopped) {
          disposeObject(gltf.scene);
          return;
        }
        if (resourceFailed) {
          disposeObject(gltf.scene);
          throw new Error('模型纹理加载失败，请检查模型资源和本机服务的资源访问策略。');
        }
        let meshCount = 0;
        gltf.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) meshCount++;
        });
        if (meshCount === 0) {
          disposeObject(gltf.scene);
          throw new Error('模型未包含可显示的网格。');
        }
        // Assets already have meters, the B frame and the correct origin. Do not normalize.
        target.add(gltf.scene);
        setStatus('ready');
        latest.current.onReady(model.id);
      } catch (error) {
        if (stopped || abort.signal.aborted) return;
        setStatus('error');
        setDetail(errorMessage(error));
        latest.current.onReady(null);
      }
    })();

    return () => {
      stopped = true;
      abort.abort();
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      disposeObject(world);
      inspectionEnvironment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [props.model?.id, props.model?.preview_url, retry]);

  return (
    <div className={`viewport ${props.mode}`} aria-label="交互式卫星三维预览">
      <div className="canvas-host" ref={hostRef} />
      {props.mode === 'capture' && props.safeFrame && (
        <div className="safe-frame" aria-hidden="true">
          <span>80% 安全边界</span>
          <i className="center-mark" />
        </div>
      )}
      <div className="viewport-top">
        <span className="view-badge">{props.mode === 'capture' ? '采集相机' : '自由观察'}</span>
        <span className="mono">{props.mode === 'capture' ? '1024 × 1024' : 'ORBIT VIEW'}</span>
      </div>
      {status !== 'ready' && (
        <div className="viewport-message" role={status === 'error' ? 'alert' : 'status'}>
          {status === 'loading' && <span className="spinner" />}
          <strong>
            {!props.model ? '等待模型清单' : status === 'error' ? '模型预览不可用' : '载入模型'}
          </strong>
          <p>{props.model ? detail : '本机服务连接成功后自动加载。'}</p>
          {status === 'error' && (
            <button className="button" onClick={() => setRetry((value) => value + 1)}>
              重新加载
            </button>
          )}
        </div>
      )}
      {status === 'ready' && (
        <div className="viewport-bottom">
          <span>
            {props.mode === 'inspect'
              ? '拖动旋转 · 滚轮缩放 · 观察状态不改变采集参数'
              : '固定视场 · 世界 +Y 向上 · 相机位于 +Z'}
          </span>
          {props.axes && (
            <span className="axis-key">
              <b>X</b>
              <b>Y</b>
              <b>Z</b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
