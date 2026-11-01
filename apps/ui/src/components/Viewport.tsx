import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { captureFov, toRenderQuaternion } from '../scene';
import { applyArcballDrag } from '../poseManipulation';
import { createClientAxes } from '../renderCoordinates';
import { configureCaptureMaterials } from '../captureMaterials';
import { errorMessage } from '../api';
import type { ModelInfo, QuaternionTuple, SceneSettings, ViewMode } from '../types';

interface Props {
  model: ModelInfo | undefined;
  scene: SceneSettings;
  mode: ViewMode;
  axes: boolean;
  safeFrame: boolean;
  reset: number;
  poseEditable: boolean;
  poseEditEpoch: number;
  poseEditHint: string;
  onPoseChange: (quaternion: QuaternionTuple) => void;
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
    let modelLoaded = false;
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
    const captureGray = { value: props.mode === 'capture' ? 1 : 0 };
    world.add(target);
    const radius = model.radius_m;
    const axisHelper = createClientAxes(radius * 0.85);
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
    let inspectDistance = radius * 4.4;
    let drag: {
      pointer: number;
      start: [number, number];
      quaternion: QuaternionTuple;
      width: number;
      height: number;
      left: number;
      top: number;
      epoch: number;
    } | null = null;
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    const endDrag = () => {
      const pointer = drag?.pointer;
      drag = null;
      canvas.classList.remove('is-dragging');
      if (pointer !== undefined && canvas.hasPointerCapture(pointer))
        canvas.releasePointerCapture(pointer);
    };
    const resetInspect = () => {
      endDrag();
      inspectDistance = radius * 4.4;
      inspectCamera.position.set(0, 0, inspectDistance);
      inspectCamera.lookAt(0, 0, 0);
    };
    resetInspect();
    const canEdit = () =>
      !stopped && modelLoaded && latest.current.mode === 'inspect' && latest.current.poseEditable;
    const onPointerDown = (event: PointerEvent) => {
      if (!canEdit() || drag || !event.isPrimary || event.button !== 0) return;
      // Pointer capture prevents the normal focus change. Commit a pending
      // number edit before taking the starting pose for this gesture.
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement) flushSync(() => focused.blur());
      if (!canEdit()) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const { W, X, Y, Z } = latest.current.scene.sat_quat;
      drag = {
        pointer: event.pointerId,
        start: [event.clientX - bounds.left, event.clientY - bounds.top],
        quaternion: [X, Y, Z, W],
        width: bounds.width,
        height: bounds.height,
        left: bounds.left,
        top: bounds.top,
        epoch: latest.current.poseEditEpoch,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!canEdit() || latest.current.poseEditEpoch !== drag.epoch) {
        endDrag();
        return;
      }
      const point: [number, number] = [event.clientX - drag.left, event.clientY - drag.top];
      const next = applyArcballDrag(drag.quaternion, drag.start, point, drag.width, drag.height);
      // Follow the pointer path incrementally, keeping rotation and its sign
      // continuous through long gestures instead of returning to the initial anchor.
      drag.start = point;
      drag.quaternion = next;
      latest.current.onPoseChange(next);
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag?.pointer !== event.pointerId) return;
      onPointerMove(event);
      endDrag();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (drag?.pointer === event.pointerId) endDrag();
    };
    const onWheel = (event: WheelEvent) => {
      if (latest.current.mode !== 'inspect') return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      const delta = Math.max(-1000, Math.min(1000, event.deltaY * scale));
      inspectDistance = Math.max(
        radius * 1.25,
        Math.min(radius * 30, inspectDistance * Math.exp(delta * 0.001)),
      );
      event.preventDefault();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', endDrag);
    const sun = new THREE.DirectionalLight(0xffffff, 4);
    const ambient = new THREE.HemisphereLight(0xdceaff, 0x4e535c, 0.5);
    const fill = new THREE.DirectionalLight(0xc3d9ff, 0.8);
    fill.position.set(-radius * 3, radius * 2, radius * 3);
    world.add(sun, ambient, fill);
    let size = { width: 1, height: 1 };
    const resize = () => {
      endDrag();
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
      modelLoaded = false;
      endDrag();
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
      captureGray.value = inspect ? 0 : 1;
      const { W, X, Y, Z } = current.scene.sat_quat;
      target.quaternion.fromArray(toRenderQuaternion([X, Y, Z, W]));
      axisHelper.visible = current.axes;
      if (drag && (!canEdit() || drag.epoch !== current.poseEditEpoch)) endDrag();
      if (current.reset !== lastReset) {
        resetInspect();
        lastReset = current.reset;
      }
      inspectCamera.position.set(0, 0, inspectDistance);
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
        // Keep the existing engine-basis geometry, meters and origin unchanged.
        configureCaptureMaterials(gltf.scene, captureGray);
        target.add(gltf.scene);
        modelLoaded = true;
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
      endDrag();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', endDrag);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      disposeObject(world);
      inspectionEnvironment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [props.model?.id, props.model?.preview_url, retry]);

  return (
    <div
      className={`viewport ${props.mode}${props.poseEditable ? ' pose-editable' : ''}`}
      aria-label="交互式卫星三维预览"
    >
      <div className="canvas-host" ref={hostRef} />
      {props.mode === 'capture' && props.safeFrame && (
        <div className="safe-frame" aria-hidden="true">
          <span>80% 安全边界</span>
          <i className="center-mark" />
        </div>
      )}
      <div className="viewport-top">
        <span className="view-badge">
          {props.mode === 'capture' ? '采集相机' : props.poseEditable ? '拖动调姿' : '模型预览'}
        </span>
        {props.mode === 'capture' && <span className="mono">1024 × 1024</span>}
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
              ? props.poseEditHint
              : '左手系 · X 向右 · Y 朝观测相机 · Z 向上'}
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
