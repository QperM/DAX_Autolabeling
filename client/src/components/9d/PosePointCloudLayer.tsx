import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { annotationApi, depthApi, meshApi, pose9dApi } from '../../services/api';
import { toAbsoluteUrl } from '../../utils/urls';
import { useAppAlert } from '../common/AppAlert';
import { debugLog } from '../../utils/debugSettings';
import { fillInitialPosesByMasks } from './poseInitialPoseAutoFill';

type Props = {
  visible: boolean;
  projectId: number | null;
  imageId: number | null;
  depthMode?: 'raw' | 'fix';
  saveRequestId?: number;
  saveInitialRequestId?: number;
  fillInitialPosesRequestId?: number;
  convertInitialToFinalRequestId?: number;
  clear6dRequestId?: number;
  onSaveFinalPoseStart?: (meta: { total: number }) => void;
  onSaveFinalPoseProgress?: (meta: { total: number; completed: number; currentText: string }) => void;
  onSaveFinalPoseComplete?: (ok: boolean) => void;
};

type Intrinsics = {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  depthScale?: number;
};

const toNum = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const MESH_UNIT_TO_CM = 100; // 临时单位统一：mesh(m) -> scene(cm)

function parseNpy(buf: ArrayBuffer): { shape: number[]; dtype: string; data: Float32Array | Uint16Array | Uint32Array } {
  const magic = new Uint8Array(buf, 0, 6);
  const signature = String.fromCharCode(...magic);
  if (signature !== '\x93NUMPY') throw new Error('非法 npy 文件');
  const vMajor = new DataView(buf).getUint8(6);
  const headerLen = vMajor <= 1 ? new DataView(buf).getUint16(8, true) : new DataView(buf).getUint32(8, true);
  const off = vMajor <= 1 ? 10 : 12;
  const header = new TextDecoder().decode(new Uint8Array(buf, off, headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] || '';
  const shapeRaw = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || '';
  const shape = shapeRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  const dataOffset = off + headerLen;
  if (descr.endsWith('f4')) {
    return { shape, dtype: descr, data: new Float32Array(buf, dataOffset) };
  }
  if (descr.endsWith('u2')) {
    return { shape, dtype: descr, data: new Uint16Array(buf, dataOffset) };
  }
  if (descr.endsWith('u4')) {
    return { shape, dtype: descr, data: new Uint32Array(buf, dataOffset) };
  }
  throw new Error(`暂不支持的 npy dtype: ${descr}`);
}

const identity16 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EPS = 1e-6;
const matrixEquals = (a?: number[] | null, b?: number[] | null) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 16 || b.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(Number(a[i]) - Number(b[i])) > EPS) return false;
  }
  return true;
};

// 将 CV 坐标系下的 pose44 变换成 threejs 的 Matrix4（坐标系翻转：C = diag(1,-1,-1)）
const cvPoseToThree44ToMatrix = (pose44: number[][]): THREE.Matrix4 => {
  const C = [1, -1, -1];
  const out = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 1],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i][j] = C[i] * toNum(pose44?.[i]?.[j], i === j ? 1 : 0) * C[j];
  }
  out[0][3] = C[0] * toNum(pose44?.[0]?.[3], 0);
  out[1][3] = C[1] * toNum(pose44?.[1]?.[3], 0);
  out[2][3] = C[2] * toNum(pose44?.[2]?.[3], 0);
  const flat = [
    out[0][0], out[0][1], out[0][2], out[0][3],
    out[1][0], out[1][1], out[1][2], out[1][3],
    out[2][0], out[2][1], out[2][2], out[2][3],
    0, 0, 0, 1,
  ];
  return new THREE.Matrix4().set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15],
  );
};

type TransformHistoryEntry = {
  instanceKey: string;
  meshId: number;
  maskId: string | null;
  before: number[];
  after: number[];
};

type PoseMode = 'final' | 'initial';

type InstancePosePair = {
  initial: number[][] | null;
  final: number[][] | null;
};

type InstanceMeta = {
  instanceKey: string;
  meshId: number;
  maskId: string | null;
  maskIndex: number | null;
};

const COLOR_FINAL = 0xff8a00;
const COLOR_INITIAL = 0x22c55e;

const normalizeMaskId = (v: any): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

const getInstanceKey = (meshId: number, maskId: string | null, fallback = 'nomask') =>
  `mesh:${Number(meshId)}|mask:${maskId || fallback}`;

type MaskPolygon = {
  points: Array<{ x: number; y: number }>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  color: [number, number, number];
};

const parseMaskColor = (input: any): [number, number, number] => {
  try {
    const c = new THREE.Color();
    const raw = String(input || '').trim();
    if (!raw) return [1, 0.2, 0.2];
    // 尽可能兼容 #RRGGBB / rgb(...) / 颜色名等
    if (raw.startsWith('#') || raw.startsWith('rgb') || raw.startsWith('hsl')) c.setStyle(raw);
    else c.set(raw as any);
    return [c.r, c.g, c.b];
  } catch (_) {
    return [1, 0.2, 0.2];
  }
};

const toMaskPolygon = (mask: any): MaskPolygon | null => {
  const flat = Array.isArray(mask?.points) ? mask.points.flat(Infinity) : [];
  const vals = flat.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v));
  if (vals.length < 6) return null;
  const points: Array<{ x: number; y: number }> = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < vals.length; i += 2) {
    const x = vals[i];
    const y = vals[i + 1];
    points.push({ x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (points.length < 3) return null;
  return {
    points,
    minX,
    maxX,
    minY,
    maxY,
    color: parseMaskColor(mask?.color),
  };
};

const pointInPolygon = (x: number, y: number, poly: Array<{ x: number; y: number }>) => {
  // Ray casting: 点在多边形内返回 true
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const parseMtlNameFromObjText = (objText: string) => {
  const lines = String(objText || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.toLowerCase().startsWith('mtllib ')) return t.slice(7).trim();
  }
  return null;
};

const resolveMaskColorAt = (u: number, v: number, masks: MaskPolygon[]): [number, number, number] | null => {
  for (const m of masks) {
    if (u < m.minX || u > m.maxX || v < m.minY || v > m.maxY) continue;
    if (pointInPolygon(u, v, m.points)) return m.color;
  }
  return null;
};

const PosePointCloudLayer: React.FC<Props> = ({
  visible,
  projectId,
  imageId,
  depthMode = 'raw',
  saveRequestId = 0,
  saveInitialRequestId = 0,
  fillInitialPosesRequestId = 0,
  convertInitialToFinalRequestId = 0,
  clear6dRequestId = 0,
  onSaveFinalPoseStart,
  onSaveFinalPoseProgress,
  onSaveFinalPoseComplete,
}) => {
  const { confirm, alert } = useAppAlert();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('准备中...');
  const [matrixValues, setMatrixValues] = useState<number[]>(identity16());
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const [renderTextured, setRenderTextured] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteBusyRef = useRef(false);
  const [convertInitToFinalBusy, setConvertInitToFinalBusy] = useState(false);
  const [, setClear6dBusy] = useState(false);
  const [activeInstanceKey, setActiveInstanceKey] = useState<string | null>(null);
  const [sceneRefreshId, setSceneRefreshId] = useState(0);
  const [matrixPos, setMatrixPos] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  // 颜色/姿态渲染与可拖拽行为由每个 mesh 是否存在 initialPose 决定，无需额外模式开关
  // 缓存每个实例(image+mesh+mask)的初始位姿/最终位姿
  const pose44ByInstanceRef = useRef<Record<string, InstancePosePair>>({});
  // 当前点云场景渲染的所有实例
  const targetInstancesRef = useRef<InstanceMeta[]>([]);
  const transformRef = useRef<TransformControls | null>(null);
  const meshObjRef = useRef<THREE.Object3D | null>(null);
  const meshByInstanceRef = useRef<Map<string, THREE.Object3D>>(new Map());
  // 为了“删除 mesh 不重建场景”：保留 scene / 拾取列表引用，删除时做局部移除
  const sceneRef = useRef<THREE.Scene | null>(null);
  const selectableRootsRef = useRef<THREE.Object3D[]>([]);
  const pickTargetsRef = useRef<THREE.Object3D[]>([]);
  const pickTargetToRootRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const undoStackRef = useRef<TransformHistoryEntry[]>([]);
  const redoStackRef = useRef<TransformHistoryEntry[]>([]);
  const dragStartMatrixRef = useRef<number[] | null>(null);
  const materialEntriesRef = useRef<
    Array<{ mesh: THREE.Mesh; instanceKey: string; textured: THREE.Material | THREE.Material[]; wire: THREE.MeshBasicMaterial }>
  >([]);
  const dragStateRef = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({ dragging: false, offsetX: 0, offsetY: 0 });
  const lastHandledFillInitialPosesRequestIdRef = useRef(0);
  const lastHandledSaveRequestIdRef = useRef(0);
  const lastHandledClear6dRequestIdRef = useRef(0);
  const lastHandledConvertInitToFinalRequestIdRef = useRef(0);

  const activeInstanceKeyRef = useRef<string | null>(activeInstanceKey);
  useEffect(() => {
    activeInstanceKeyRef.current = activeInstanceKey;
  }, [activeInstanceKey]);

  useEffect(() => {
    deleteBusyRef.current = deleteBusy;
  }, [deleteBusy]);

  const matrixText = useMemo(() => {
    const m = matrixValues;
    if (!Array.isArray(m) || m.length !== 16) return '[]';
    const r = [m.slice(0, 4), m.slice(4, 8), m.slice(8, 12), m.slice(12, 16)];
    return JSON.stringify(r);
  }, [matrixValues]);

  const undoLastTransform = useCallback(() => {
    const hist = undoStackRef.current;
    if (!hist.length) {
      setStatus('没有可回退的操作');
      return;
    }
    const last = hist.pop()!;
    const obj = meshByInstanceRef.current.get(last.instanceKey) || null;
    if (!obj) {
      setStatus(`回退失败：场景中找不到实例 ${last.instanceKey}`);
      return;
    }
    const m = new THREE.Matrix4();
    m.fromArray(last.before as any);
    obj.matrix.copy(m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
    meshObjRef.current = obj;
    setActiveInstanceKey(last.instanceKey);
    setMatrixValues(obj.matrix.toArray());
    if (transformRef.current) transformRef.current.attach(obj);
    redoStackRef.current.push(last);
    setStatus(`已回退实例(${last.meshId}${last.maskId ? `/${last.maskId}` : ''}) 上一步操作（可重做 ${redoStackRef.current.length} 步）`);
  }, []);

  const redoLastTransform = useCallback(() => {
    const hist = redoStackRef.current;
    if (!hist.length) {
      setStatus('没有可重做的操作');
      return;
    }
    const last = hist.pop()!;
    const obj = meshByInstanceRef.current.get(last.instanceKey) || null;
    if (!obj) {
      setStatus(`重做失败：场景中找不到实例 ${last.instanceKey}`);
      return;
    }
    const m = new THREE.Matrix4();
    m.fromArray(last.after as any);
    obj.matrix.copy(m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
    meshObjRef.current = obj;
    setActiveInstanceKey(last.instanceKey);
    setMatrixValues(obj.matrix.toArray());
    if (transformRef.current) transformRef.current.attach(obj);
    undoStackRef.current.push(last);
    setStatus(`已重做实例(${last.meshId}${last.maskId ? `/${last.maskId}` : ''}) 上一步操作（可回退 ${undoStackRef.current.length} 步）`);
  }, []);

  useEffect(() => {
    const entries = materialEntriesRef.current;
    if (!entries || entries.length === 0) return;
    for (const e of entries) {
      // 颜色固定由“是否存在人工初始位姿”决定：
      // - 有初始位姿：绿色
      // - 无初始位姿：橙色
      const pair = pose44ByInstanceRef.current[e.instanceKey];
      const shouldGreen = !!pair?.initial;
      e.wire.color.setHex(shouldGreen ? COLOR_INITIAL : COLOR_FINAL);
      if (!(e.mesh.material instanceof Array) && e.mesh.material === e.wire) {
        e.mesh.material.needsUpdate = true;
      }
    }
  }, [visible, sceneRefreshId]);

  useEffect(() => {
    const entries = materialEntriesRef.current;
    if (!entries || entries.length === 0) return;
    for (const e of entries) {
      e.mesh.material = renderTextured ? e.textured : e.wire;
    }
  }, [renderTextured, visible]);

  useEffect(() => {
    if (!visible) return;
    const onMove = (ev: MouseEvent) => {
      if (!dragStateRef.current.dragging) return;
      const wrapRect = canvasWrapRef.current?.getBoundingClientRect();
      const wrapLeft = wrapRect?.left ?? 0;
      const wrapTop = wrapRect?.top ?? 0;
      setMatrixPos({
        x: Math.max(8, ev.clientX - wrapLeft - dragStateRef.current.offsetX),
        y: Math.max(8, ev.clientY - wrapTop - dragStateRef.current.offsetY),
      });
    };
    const onUp = () => {
      dragStateRef.current.dragging = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [visible]);

  const applyPoseToInstance = (instanceKey: string, targetMode: PoseMode) => {
    const obj = meshByInstanceRef.current.get(instanceKey);
    if (!obj) return false;

    const pair = pose44ByInstanceRef.current[instanceKey];
    const pose44 = targetMode === 'initial' ? pair?.initial : pair?.final;
    if (!pose44) return false;

    // 用对应位姿矩阵刷新 mesh 的变换，并同步到 Matrix 面板/TransformControls
    const m = cvPoseToThree44ToMatrix(pose44);
    obj.matrix.copy(m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.scale.multiplyScalar(MESH_UNIT_TO_CM);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);

    meshObjRef.current = obj;
    if (transformRef.current) transformRef.current.attach(obj);
    setMatrixValues(obj.matrix.toArray());
    return true;
  };

  const updateWireColorForInstance = (instanceKey: string) => {
    const pair = pose44ByInstanceRef.current[instanceKey];
    const shouldGreen = !!pair?.initial;
    const hex = shouldGreen ? COLOR_INITIAL : COLOR_FINAL;
    const entries = materialEntriesRef.current;
    if (!entries || entries.length === 0) return;
    for (const e of entries) {
      if (e.instanceKey !== instanceKey) continue;
      e.wire.color.setHex(hex);
      if (!(e.mesh.material instanceof Array) && e.mesh.material === e.wire) {
        e.mesh.material.needsUpdate = true;
      }
    }
  };

  useEffect(() => {
    if (!visible || !hostRef.current || !projectId || !imageId) return;
    let cancelled = false;

    const host = hostRef.current;
    const width = Math.max(320, host.clientWidth || 640);
    const height = Math.max(240, host.clientHeight || 360);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 20000);
    camera.position.set(0, 0, 260);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const fitCameraToObjects = (objects: THREE.Object3D[], padding = 1.35) => {
      if (!objects || objects.length === 0) return;
      const box = new THREE.Box3();
      let hasValid = false;
      for (const obj of objects) {
        if (!obj) continue;
        box.expandByObject(obj);
        hasValid = true;
      }
      if (!hasValid || box.isEmpty()) return;

      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const fov = (camera.fov * Math.PI) / 180;
      const fitDist = (maxDim / (2 * Math.tan(fov / 2))) * padding;

      const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();

      controls.target.copy(center);
      camera.position.copy(center.clone().add(dir.multiplyScalar(fitDist)));
      camera.near = Math.max(0.1, fitDist / 200);
      camera.far = Math.max(5000, fitDist * 40);
      camera.updateProjectionMatrix();
      controls.update();
    };

    scene.add(new THREE.AxesHelper(30));
    scene.add(new THREE.GridHelper(300, 20, 0x334155, 0x1e293b));
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(50, 80, 120);
    scene.add(dir);

    let frameId = 0;
    let transform: TransformControls | null = null;
    let orbit: OrbitControls | null = controls;
    let meshObj: THREE.Object3D | null = null;
    const selectableRoots: THREE.Object3D[] = [];
    const pickTargets: THREE.Object3D[] = [];
    const pickTargetToRoot = new Map<string, THREE.Object3D>();
    selectableRootsRef.current = selectableRoots;
    pickTargetsRef.current = pickTargets;
    pickTargetToRootRef.current = pickTargetToRoot;
    let onPointerDown: ((ev: PointerEvent) => void) | null = null;

    const renderLoop = () => {
      frameId = requestAnimationFrame(renderLoop);
      controls.update();
      renderer.render(scene, camera);
    };

    const cvPoseToThree = (pose44: number[][]): THREE.Matrix4 => {
      // C = diag(1,-1,-1), T_three = C * T_cv * C
      const C = [1, -1, -1];
      const out = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 1],
      ];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) out[i][j] = C[i] * toNum(pose44?.[i]?.[j], i === j ? 1 : 0) * C[j];
      }
      out[0][3] = C[0] * toNum(pose44?.[0]?.[3], 0);
      out[1][3] = C[1] * toNum(pose44?.[1]?.[3], 0);
      out[2][3] = C[2] * toNum(pose44?.[2]?.[3], 0);
      const flat = [
        out[0][0], out[0][1], out[0][2], out[0][3],
        out[1][0], out[1][1], out[1][2], out[1][3],
        out[2][0], out[2][1], out[2][2], out[2][3],
        0, 0, 0, 1,
      ];
      return new THREE.Matrix4().set(
        flat[0], flat[1], flat[2], flat[3],
        flat[4], flat[5], flat[6], flat[7],
        flat[8], flat[9], flat[10], flat[11],
        flat[12], flat[13], flat[14], flat[15],
      );
    };

    const load = async () => {
      try {
        setStatus('加载点云输入...');
        const depthRows = await depthApi.getDepth(projectId, imageId);
        const npy = (depthRows || []).find((d: any) =>
          d?.modality === 'depth_raw' || String(d?.filename || '').toLowerCase().endsWith('.npy'),
        );
        const intr = (depthRows || []).find((d: any) => d?.modality === 'intrinsics' || /intrinsics_/i.test(String(d?.filename || '')));
        const npyUrlCandidate =
          depthMode === 'fix'
            ? (npy as any)?.depthRawFixUrl || (npy as any)?.depthRawFixPath || null
            : (npy as any)?.url || null;
        if (!npyUrlCandidate) throw new Error(depthMode === 'fix' ? '未找到 depth_raw_fix npy（修复深度缺失）' : '未找到 depth_raw npy');
        if (!intr?.url) throw new Error('未找到 intrinsics json');

        const npyUrl = toAbsoluteUrl(npyUrlCandidate) || npyUrlCandidate;
        const intrUrl = toAbsoluteUrl(intr.url) || intr.url;

        const [npyBuf, intrJs, annoResp] = await Promise.all([
          fetch(npyUrl).then((r) => r.arrayBuffer()),
          fetch(intrUrl).then((r) => r.json()),
          annotationApi.getAnnotation(Number(imageId)).catch(() => null),
        ]);
        const masksRaw = Array.isArray((annoResp as any)?.annotation?.masks) ? (annoResp as any).annotation.masks : [];
        const maskPolygons = masksRaw
          .map((m: any) => toMaskPolygon(m))
          .filter((m: MaskPolygon | null): m is MaskPolygon => !!m);

        const parsed = parseNpy(npyBuf);
        const h = toNum(parsed.shape?.[0], 0);
        const w = toNum(parsed.shape?.[1], 0);
        if (!h || !w) throw new Error('npy shape 非法');

        const intri: Intrinsics = {
          fx: toNum(intrJs?.fx, 1),
          fy: toNum(intrJs?.fy, 1),
          cx: toNum(intrJs?.cx, w / 2),
          cy: toNum(intrJs?.cy, h / 2),
          depthScale: toNum(intrJs?.depth_scale ?? intrJs?.depthScale ?? intrJs?.depthscale, 0.001),
        };

        setStatus('生成点云...');
        const depth = parsed.data;
        const positions: number[] = [];
        const colors: number[] = [];
        const step = Math.max(1, Math.round(Math.max(w, h) / 220));
        const pick = (idx: number): number => Number((depth as any)[idx]);
        for (let v = 0; v < h; v += step) {
          for (let u = 0; u < w; u += step) {
            const idx = v * w + u;
            let z = pick(idx);
            if (!Number.isFinite(z) || z <= 0) continue;
            if (parsed.dtype.endsWith('f4')) {
              // float npy 常为米，转厘米
              z = z * 100.0;
            } else {
              z = z * intri.depthScale! * 100.0;
            }
            if (z <= 0.1 || z > 3000) continue;
            const x = ((u - intri.cx) * z) / intri.fx;
            const y = ((v - intri.cy) * z) / intri.fy;
            positions.push(x, -y, -z);
            const maskColor = maskPolygons.length ? resolveMaskColorAt(u, v, maskPolygons) : null;
            if (maskColor) {
              colors.push(maskColor[0], maskColor[1], maskColor[2]);
            } else {
              const c = Math.min(1, Math.max(0, z / 250));
              colors.push(0.2 + 0.8 * c, 0.5 * (1 - c), 1 - c);
            }
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
          size: 0.8,
          vertexColors: true,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        });
        const cloud = new THREE.Points(g, mat);
        cloud.renderOrder = 1;
        scene.add(cloud);

        setStatus('加载姿态与 mesh...');
        const [posesResp, meshes] = await Promise.all([
          pose9dApi.listPose9D(imageId),
          meshApi.getMeshes(projectId),
        ]);
        const poses = Array.isArray(posesResp?.poses) ? posesResp.poses : [];
        const dbInstances: InstanceMeta[] = poses
          .map((p: any, idx: number) => {
            const meshId = Number(p?.meshId ?? p?.mesh_id ?? p?.mesh?.id ?? 0);
            const maskId = normalizeMaskId(p?.maskId ?? p?.mask_id ?? null);
            const maskIndexRaw = p?.maskIndex ?? p?.mask_index ?? null;
            const maskIndex = Number.isFinite(Number(maskIndexRaw)) ? Number(maskIndexRaw) : null;
            if (!Number.isFinite(meshId) || meshId <= 0) return null;
            return {
              instanceKey: getInstanceKey(meshId, maskId, `row-${idx}`),
              meshId,
              maskId,
              maskIndex,
            } as InstanceMeta;
          })
          .filter((v: InstanceMeta | null): v is InstanceMeta => !!v);
        const targetInstances: InstanceMeta[] = dbInstances;
        if (targetInstances.length === 0) {
          setStatus('未找到 diffdope pose44，仅显示点云');
          fitCameraToObjects([cloud]);
          renderLoop();
          return;
        }
        targetInstancesRef.current = targetInstances;
        meshByInstanceRef.current.clear();
        undoStackRef.current = [];
        redoStackRef.current = [];
        const allMaterialEntries: Array<{
          mesh: THREE.Mesh;
          instanceKey: string;
          textured: THREE.Material | THREE.Material[];
          wire: THREE.MeshBasicMaterial;
        }> = [];
        pose44ByInstanceRef.current = {};
        let lastObj: THREE.Object3D | null = null;
        let lastMeshSize = new THREE.Vector3(0, 0, 0);
        let lastActiveInstanceKey: string | null = null;

        for (const instance of targetInstances) {
          const { instanceKey, meshId, maskId } = instance;
          const selectedPose = poses.find((p: any) => {
            const pmid = Number(p?.meshId ?? p?.mesh_id ?? p?.mesh?.id);
            const pmask = normalizeMaskId(p?.maskId ?? p?.mask_id ?? null);
            return pmid === Number(meshId) && pmask === maskId;
          }) || null;
          const initialPose44 = Array.isArray(selectedPose?.initialPose?.pose44) ? selectedPose?.initialPose?.pose44 : null;
          const finalPose44 = Array.isArray(selectedPose?.diffdope?.pose44) ? selectedPose?.diffdope?.pose44 : null;
          pose44ByInstanceRef.current[instanceKey] = { initial: initialPose44, final: finalPose44 };
          const mesh = (meshes || []).find((m: any) => Number(m?.id) === Number(meshId));
          const meshUrlRaw = mesh?.url || (mesh as any)?.filePath || (mesh as any)?.file_path || null;
          if (!meshUrlRaw) continue;

          const meshUrl = toAbsoluteUrl(meshUrlRaw) || meshUrlRaw;
          const manager = new THREE.LoadingManager();
          manager.onError = (url) => {
            debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] resource error', {
              meshId,
              url: String(url || ''),
              meshUrl,
            });
          };
          // IMPORTANT:
          // Some APIs may return a coarse assetDirUrl like `/uploads/`.
          // For OBJ/MTL/texture loading we must prefer the directory of meshUrl (pack folder),
          // otherwise MTL/texture will be requested from `/uploads/<file>` and 404, causing white model.
          const meshUrlNorm = String(meshUrl || '').replace(/\\/g, '/');
          const meshBaseDir = meshUrlNorm.includes('/') ? meshUrlNorm.slice(0, meshUrlNorm.lastIndexOf('/') + 1) : '';
          const assetDirRaw = (toAbsoluteUrl(mesh?.assetDirUrl) || mesh?.assetDirUrl || '').replace(/\\/g, '/');
          const assetDirCoarse = assetDirRaw === '/uploads' || assetDirRaw === '/uploads/';
          const assetDir = assetDirCoarse || !assetDirRaw ? meshBaseDir : assetDirRaw;
          const absAssetDir = assetDir ? (assetDir.endsWith('/') ? assetDir : `${assetDir}/`) : '';
          const meshAssets = Array.isArray(mesh?.assets) ? mesh.assets.map((a: any) => String(a || '')) : [];
          debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] asset base', {
            meshId,
            meshUrl,
            meshBaseDir,
            assetDirRaw,
            assetDir,
            absAssetDir,
            assetsCount: meshAssets.length,
          });
          manager.setURLModifier((url: string) => {
            if (!url) return url;
            if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
            const clean = String(url).replace(/\\/g, '/');
            // Root-relative uploads path should stay absolute.
            if (/^\//.test(clean)) return toAbsoluteUrl(clean) || clean;
            if (!absAssetDir) return clean;
            const base = clean.split('/').filter(Boolean).pop() || clean;
            const hit = meshAssets.find((a: string) => {
              const n = String(a || '').replace(/\\/g, '/');
              return (n.split('/').filter(Boolean).pop() || n).toLowerCase() === base.toLowerCase();
            });
            const finalName = hit || clean;
            const encoded = finalName
              .split('/')
              .filter(Boolean)
              .map((seg) => encodeURIComponent(seg))
              .join('/');
            const finalUrl = `${absAssetDir}${encoded}`;
            debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] urlModifier', {
              meshId,
              in: url,
              clean,
              picked: finalName,
              out: finalUrl,
            });
            return finalUrl;
          });

          const loader = new OBJLoader(manager);
          let obj: THREE.Group;
          const loadText = async (url: string) => {
            const abs = (toAbsoluteUrl(url) || url) as string;
            const resp = await fetch(abs, { credentials: 'include' });
            if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
            return await resp.text();
          };

          const pickMtlCandidate = (mtl: string | null, assetList: string[]) => {
            if (!mtl) return null;
            if (!assetList || assetList.length === 0) return mtl;
            const onlyMtl = assetList.filter((a) => String(a || '').toLowerCase().endsWith('.mtl'));
            if (!onlyMtl.length) return mtl;
            const mtlLower = mtl.toLowerCase();
            const mtlBaseLower = mtl.split('/').filter(Boolean).pop()?.toLowerCase() || mtlLower;
            const exact = onlyMtl.find((a) => {
              const n = String(a || '').replace(/\\/g, '/').toLowerCase();
              const bn = n.split('/').filter(Boolean).pop() || n;
              return n === mtlLower || bn === mtlBaseLower;
            });
            if (exact) return exact;
            const stem = mtl.replace(/\.mtl$/i, '').toLowerCase();
            return (
              onlyMtl.find((a) => {
                const n = String(a || '').replace(/\\/g, '/').toLowerCase();
                const bn = n.split('/').filter(Boolean).pop() || n;
                return n.includes(stem) || bn.includes(stem);
              }) || mtl
            );
          };

          const objText = await loadText(meshUrl);
          const mtlName = parseMtlNameFromObjText(objText);
          const mtlToLoad = pickMtlCandidate(mtlName, meshAssets);
          debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] parsed obj', {
            meshId,
            meshUrl,
            mtlName,
            mtlToLoad,
          });

          if (mtlToLoad) {
            try {
              const mtlAbs = toAbsoluteUrl(mtlToLoad) || mtlToLoad;
              const mtlIsAbsolute = /^(https?:\/\/|\/)/i.test(mtlToLoad);
              const mtlLoader = new MTLLoader(manager);
              debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] load mtl', {
                meshId,
                absAssetDir,
                mtlToLoad,
                mtlAbs,
                mtlIsAbsolute,
                setPath: mtlIsAbsolute ? '' : absAssetDir,
                resourcePath: absAssetDir,
              });
              mtlLoader.setPath(mtlIsAbsolute ? '' : absAssetDir);
              mtlLoader.setResourcePath(absAssetDir);
              const materials = await new Promise<any>((resolve, reject) => {
                mtlLoader.load(mtlIsAbsolute ? mtlAbs : mtlToLoad, resolve, undefined, reject);
              });
              materials.preload();
              loader.setMaterials(materials);
            } catch (e) {
              debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] mtl failed', { meshId, mtlToLoad, e });
            }
          }

          obj = loader.parse(objText);
          try {
            let meshCount = 0;
            let materialCount = 0;
            let mapCount = 0;
            obj.traverse((c: any) => {
              if (!c?.isMesh) return;
              meshCount += 1;
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              materialCount += mats.length;
              mats.forEach((m: any) => {
                if (m?.map) mapCount += 1;
              });
            });
            debugLog('frontend', 'frontendMeshAssets', '[PosePointCloudLayer] loaded obj stats', {
              meshId,
              meshUrl,
              meshCount,
              materialCount,
              mapCount,
            });
          } catch (_) {}
          (obj as any).userData = {
            ...(obj as any).userData,
            meshId: Number(meshId),
            maskId: maskId || null,
            instanceKey,
          };

          obj.traverse((c: any) => {
            if (c?.isMesh) {
              const wire = new THREE.MeshBasicMaterial({
                // 如果该 mesh 在数据库存在人工初始位姿，则始终渲染为绿色；
                // 否则始终渲染为橙色（AI 位姿）。
                color: initialPose44 ? COLOR_INITIAL : COLOR_FINAL,
                wireframe: true,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 1.0,
              });
              const textured = c.material;
              c.material = renderTextured ? textured : wire;
              c.renderOrder = 10;
              allMaterialEntries.push({ mesh: c as THREE.Mesh, instanceKey, textured, wire });
              pickTargets.push(c as THREE.Object3D);
              pickTargetToRoot.set((c as THREE.Object3D).uuid, obj);
            }
          });

          obj.scale.multiplyScalar(MESH_UNIT_TO_CM);
          obj.matrixAutoUpdate = true;
          // 如果存在人工初始位姿，则只渲染人工初始位姿（该 mesh 显示在绿色位置）；
          // 否则渲染 AI 最终位姿（橙色位置）。
          const pose44ToApply = initialPose44 || finalPose44;
          if (Array.isArray(pose44ToApply)) {
            const m = cvPoseToThree(pose44ToApply);
            obj.matrix.copy(m);
            obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
            obj.scale.multiplyScalar(MESH_UNIT_TO_CM);
          }
          obj.updateMatrix();
          obj.updateMatrixWorld(true);
          scene.add(obj);
          meshByInstanceRef.current.set(instanceKey, obj);
          selectableRoots.push(obj);

          const bb = new THREE.Box3().setFromObject(obj);
          const sz = new THREE.Vector3();
          bb.getSize(sz);
          lastObj = obj;
          lastMeshSize = sz;
          lastActiveInstanceKey = instanceKey;
        }

        materialEntriesRef.current = allMaterialEntries;
        if (!lastObj) {
          setStatus('未找到可加载的 Mesh，仅显示点云');
          fitCameraToObjects([cloud]);
          renderLoop();
          return;
        }
        // 进入点云后：初始化选中最后一个 mesh，并允许橙色/绿色都能被拖拽
        setActiveInstanceKey(lastActiveInstanceKey);
        meshObj = lastObj;
        meshObjRef.current = lastObj;

        transform = new TransformControls(camera, renderer.domElement);
        transformRef.current = transform;
        transform.setMode('translate');
        transform.attach(lastObj);
        transform.addEventListener('dragging-changed', (ev: any) => {
          if (orbit) orbit.enabled = !ev.value;
          // 仅在一次拖拽结束时记录历史，避免 change 事件高频写入。
          if (ev?.value) {
            const objNow = transform?.object;
            dragStartMatrixRef.current = objNow ? (objNow.matrix.toArray() as number[]) : null;
          } else {
            const objNow = transform?.object;
            const mid = Number((objNow as any)?.userData?.meshId ?? 0);
            const maskId = normalizeMaskId((objNow as any)?.userData?.maskId ?? null);
            const instanceKey = String((objNow as any)?.userData?.instanceKey || getInstanceKey(mid, maskId, 'drag'));
            const before = dragStartMatrixRef.current;
            const after = objNow ? (objNow.matrix.toArray() as number[]) : null;
            if (Number.isFinite(mid) && mid > 0 && before && after && !matrixEquals(before, after)) {
              const stack = undoStackRef.current;
              stack.push({ instanceKey, meshId: mid, maskId, before: [...before], after: [...after] });
              if (stack.length > 100) stack.shift();
              // 产生新操作后，重做链失效
              redoStackRef.current = [];
            }
            dragStartMatrixRef.current = null;
          }
        });
        transform.addEventListener('change', () => {
          if (transform?.object?.matrixAutoUpdate) {
            transform.object.updateMatrix();
            transform.object.updateMatrixWorld(true);
          }
          const arr = transform?.object?.matrix?.toArray?.() || identity16();
          setMatrixValues(arr as number[]);
        });
        scene.add(transform.getHelper());
        setMatrixValues(lastObj.matrix.toArray());
        // 首次进入点云场景时，按点云+Mesh 的整体包围盒自动贴合相机距离
        fitCameraToObjects([cloud, ...selectableRoots]);
        onPointerDown = (ev: PointerEvent) => {
          if (!renderer?.domElement || !transform) return;
          // 正在使用 TransformControls（拖拽或悬停到轴）时，不进行 mesh 重选，避免误切对象。
          if ((transform as any)?.dragging || (transform as any)?.axis) return;
          if (ev.button !== 0) return;
          const rect = renderer.domElement.getBoundingClientRect();
          const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
          const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
          const hits = raycaster.intersectObjects(pickTargets, true);
          if (!hits || hits.length === 0) return;
          const hitObj = hits[0].object as THREE.Object3D;
          const root =
            pickTargetToRoot.get(hitObj.uuid) ||
            selectableRoots.find((r) => r === hitObj || r.children.includes(hitObj)) ||
            null;
          if (!root) return;
          const mid = Number((root as any)?.userData?.meshId ?? 0);
          const maskId = normalizeMaskId((root as any)?.userData?.maskId ?? null);
          const instanceKey = String((root as any)?.userData?.instanceKey || getInstanceKey(mid, maskId, 'pick'));
          if (Number.isFinite(mid) && mid > 0) {
            transform.attach(root);
            meshObj = root;
            meshObjRef.current = root;
            setActiveInstanceKey(instanceKey);
            // 指针选中时不要强制“还原”到数据库 pose，避免覆盖未保存的拖拽结果
            setMatrixValues(root.matrix.toArray());
          }
          setStatus(`已选中实例 ${Number.isFinite(mid) && mid > 0 ? `${mid}${maskId ? `/${maskId}` : ''}` : 'unknown'}（可拖拽编辑）`);
        };
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        setStatus(
          `点云场景就绪（单位: cm，W: 平移 / E或R: 旋转） | instances=${targetInstances.length} | activeSize=(${lastMeshSize.x.toFixed(2)}, ${lastMeshSize.y.toFixed(2)}, ${lastMeshSize.z.toFixed(2)})`,
        );
        renderLoop();
      } catch (e: any) {
        setStatus(e?.message || '点云加载失败');
        renderLoop();
      }
    };

    const onResize = () => {
      if (!hostRef.current) return;
      const w = Math.max(320, hostRef.current.clientWidth || 640);
      const h = Math.max(240, hostRef.current.clientHeight || 360);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const onKey = (ev: KeyboardEvent) => {
      const k = String(ev.key || '').toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) redoLastTransform();
        else undoLastTransform();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && k === 'y') {
        ev.preventDefault();
        redoLastTransform();
        return;
      }
      if (!transform) return;
      if (k === 'w') {
        transform.setMode('translate');
        setMode('translate');
      } else if (k === 'e' || k === 'r') {
        transform.setMode('rotate');
        setMode('rotate');
      }
      // 删除：从场景移除 Mesh，并同步删除后端 pose9d_annotations
      // 说明：mesh 的选择通过 meshObjRef.current 完成，所以这里优先读取其 userData.meshId。
      if (!deleteBusyRef.current && (k === 'delete' || k === 'backspace') && !ev.repeat) {
        const target = ev.target as HTMLElement | null;
        const tag = String(target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (target as any)?.isContentEditable) return;

        const mid = Number((meshObjRef.current as any)?.userData?.meshId ?? 0);
        const maskId = normalizeMaskId((meshObjRef.current as any)?.userData?.maskId ?? null);
        const instanceKey = String((meshObjRef.current as any)?.userData?.instanceKey || getInstanceKey(mid, maskId, 'delete'));
        if (Number.isFinite(mid) && mid > 0 && imageId) {
          ev.preventDefault();
          ev.stopPropagation();
          (async () => {
            try {
              setDeleteBusy(true);
              const ok = await confirm(`确定删除当前实例的 9D 标注（meshId=${mid}${maskId ? `, maskId=${maskId}` : ''}）并从场景移除？`, {
                title: '确认删除',
              });
              if (!ok) return;
              await pose9dApi.deletePose9D(imageId, mid, maskId);
              setActiveInstanceKey(null);
              setMatrixValues(identity16());
              setStatus(`已删除实例 ${mid}${maskId ? `/${maskId}` : ''} 的 9D 标注`);
              // 删除时不重建场景：只做局部移除，避免相机视角刷新跳动
              const obj = meshByInstanceRef.current.get(instanceKey);
              if (obj) {
                // 1) 从场景移除
                sceneRef.current?.remove(obj);

                // 2) 从拾取/高亮列表移除（射线拾取依赖这两个数组）
                const selectableIdx = selectableRootsRef.current.indexOf(obj);
                if (selectableIdx >= 0) selectableRootsRef.current.splice(selectableIdx, 1);

                // pickTargets 持有的是 obj 内的 mesh 子节点，需要一并移除
                const childMeshList: THREE.Object3D[] = [];
                obj.traverse((c: any) => {
                  if (c?.isMesh) childMeshList.push(c as THREE.Object3D);
                });
                for (const child of childMeshList) {
                  const pickIdx = pickTargetsRef.current.indexOf(child);
                  if (pickIdx >= 0) pickTargetsRef.current.splice(pickIdx, 1);
                  pickTargetToRootRef.current.delete(child.uuid);
                }
              }

              meshByInstanceRef.current.delete(instanceKey);
              delete pose44ByInstanceRef.current[instanceKey];
              meshObjRef.current = null;
              // 断开 TransformControls，避免继续操作已删除对象
              transformRef.current?.detach();
              // 同时更新本地选中引用（onKey 末尾会用到）
              meshObj = null;
            } catch (e: any) {
              console.error('[PosePointCloudLayer] 删除失败:', e);
              setStatus(e?.response?.data?.message || e?.message || '删除失败');
            } finally {
              setDeleteBusy(false);
            }
          })();
        }
      }
      if (meshObj) setMatrixValues(meshObj.matrix.toArray());
    };
    window.addEventListener('keydown', onKey);

    load();

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      if (frameId) cancelAnimationFrame(frameId);
      if (onPointerDown) {
        try {
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        } catch (_) {}
      }
      transform?.dispose();
      transformRef.current = null;
      meshObjRef.current = null;
      meshByInstanceRef.current.clear();
      undoStackRef.current = [];
      redoStackRef.current = [];
      dragStartMatrixRef.current = null;
      materialEntriesRef.current = [];
      orbit?.dispose();
      renderer.dispose();
      try {
        host.innerHTML = '';
      } catch (_) {}
      if (cancelled) return;
    };
  }, [visible, projectId, imageId, depthMode, sceneRefreshId, undoLastTransform, redoLastTransform]);

  const matrixValuesToCvPose44 = () => {
    const m = new THREE.Matrix4();
    m.fromArray(matrixValues as any);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    const rotOnly = new THREE.Matrix4().makeRotationFromQuaternion(q);
    rotOnly.setPosition(p);
    const e = rotOnly.elements;
    const gl = [
      [e[0], e[4], e[8], e[12]],
      [e[1], e[5], e[9], e[13]],
      [e[2], e[6], e[10], e[14]],
      [0, 0, 0, 1],
    ];
    const C = [1, -1, -1];
    const cv = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ] as number[][];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) cv[i][j] = C[i] * Number(gl[i][j]) * C[j];
    }
    cv[0][3] = C[0] * Number(gl[0][3]);
    cv[1][3] = C[1] * Number(gl[1][3]);
    cv[2][3] = C[2] * Number(gl[2][3]);
    return cv;
  };

  const matrixArrayToCvPose44 = (matrixArr: number[]) => {
    const m = new THREE.Matrix4();
    m.fromArray(matrixArr as any);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    const rotOnly = new THREE.Matrix4().makeRotationFromQuaternion(q);
    rotOnly.setPosition(p);
    const e = rotOnly.elements;
    const gl = [
      [e[0], e[4], e[8], e[12]],
      [e[1], e[5], e[9], e[13]],
      [e[2], e[6], e[10], e[14]],
      [0, 0, 0, 1],
    ];
    const C = [1, -1, -1];
    const cv = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ] as number[][];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) cv[i][j] = C[i] * Number(gl[i][j]) * C[j];
    }
    cv[0][3] = C[0] * Number(gl[0][3]);
    cv[1][3] = C[1] * Number(gl[1][3]);
    cv[2][3] = C[2] * Number(gl[2][3]);
    return cv;
  };

  const saveCurrentPose44 = async () => {
    if (!imageId || saveBusy) return;
    const instances = targetInstancesRef.current || [];
    if (!instances.length) {
      setStatus('当前没有可保存的实例');
      onSaveFinalPoseComplete?.(false);
      return;
    }
    let ok = false;
    try {
      setSaveBusy(true);
      // 进度条把“写入实例位姿（N 步）+ 拟合图层合成（1 步）”一起算进去，
      // 避免合成阶段耗时但进度条已提前到 100%。
      const totalWork = instances.length + 1;
      onSaveFinalPoseStart?.({ total: totalWork });
      // 保存“最终位姿”：对当前点云场景内的所有实例都写入 diffdope_json
      let completed = 0;
      const activeKeyNow = activeInstanceKeyRef.current;
      for (const inst of instances) {
        const obj = meshByInstanceRef.current.get(inst.instanceKey);
        if (!obj) {
          completed += 1;
          onSaveFinalPoseProgress?.({
            total: totalWork,
            completed,
            currentText: `跳过实例 ${inst.meshId}${inst.maskId ? `/${inst.maskId}` : ''}（场景中不存在）`,
          });
          continue;
        }
        obj.updateMatrixWorld(true);
        const matrixArr = obj.matrix.toArray() as number[];
        const cv = matrixArrayToCvPose44(matrixArr);
        // 单个实例保存时不做拟合图层合成；由“保存全部实例最终位姿”统一触发一次
        await pose9dApi.saveDiffdopePose44(imageId, inst.meshId, cv, inst.maskId, { skipFitOverlay: true });
          // 保存最终位姿后，清空该实例的人工初始位姿，确保“最终/初始互斥”
          await pose9dApi.deleteInitialPose(imageId, inst.meshId, inst.maskId);
          pose44ByInstanceRef.current[inst.instanceKey] = { ...pose44ByInstanceRef.current[inst.instanceKey], initial: null, final: cv };
          updateWireColorForInstance(inst.instanceKey);
        completed += 1;
        onSaveFinalPoseProgress?.({
          total: totalWork,
          completed,
          currentText: `正在保存实例 ${inst.meshId}${inst.maskId ? `/${inst.maskId}` : ''}（${completed}/${instances.length}）`,
        });
      }
      // 保存完成后只合成一次拟合图层（fit_overlay_path）
      onSaveFinalPoseProgress?.({
        total: totalWork,
        completed,
        currentText: '正在合成拟合图层（Diff-DOPE）…',
      });
      await pose9dApi.regenerateCompositeFitOverlay(imageId);
      completed += 1;
      onSaveFinalPoseProgress?.({
        total: totalWork,
        completed,
        currentText: '拟合图层合成完成',
      });

      ok = true;
      setStatus('所有实例的最终位姿已保存到数据库（diffdope_json），并已更新拟合图层');

      // 如果当前正在选中的实例也参与了本次保存，则切到“最终位姿(橙色)”
      if (activeKeyNow && pose44ByInstanceRef.current[activeKeyNow]?.final) {
        applyPoseToInstance(activeKeyNow, 'final');
        updateWireColorForInstance(activeKeyNow);
      }
    } catch (e: any) {
      setStatus(e?.response?.data?.message || e?.message || '保存失败');
    } finally {
      setSaveBusy(false);
      onSaveFinalPoseComplete?.(ok);
    }
  };

  const saveCurrentInitialPose44 = async () => {
    if (!imageId || !activeInstanceKey || saveBusy) return;
    try {
      setSaveBusy(true);
      const cv = matrixValuesToCvPose44();
      const inst = targetInstancesRef.current.find((x) => x.instanceKey === activeInstanceKey);
      if (!inst) throw new Error('未找到当前选中实例');
      // 保存初始位姿后清空最终位姿，确保“初始/最终互斥”
      await pose9dApi.saveInitialPose(imageId, { meshId: inst.meshId, maskId: inst.maskId, maskIndex: inst.maskIndex, pose44: cv });
      await pose9dApi.clearDiffdopePose44(imageId, inst.meshId, inst.maskId);

      pose44ByInstanceRef.current[inst.instanceKey] = { ...pose44ByInstanceRef.current[inst.instanceKey], initial: cv, final: null };
      updateWireColorForInstance(inst.instanceKey);
      // 确保该实例以“初始位姿（绿色）”渲染
      applyPoseToInstance(inst.instanceKey, 'initial');
      setStatus(`初始位姿已保存到数据库（实例 ${inst.meshId}${inst.maskId ? `/${inst.maskId}` : ''} 变为绿色，并清空最终位姿）`);
    } catch (e: any) {
      setStatus(e?.response?.data?.message || e?.message || '保存初始位姿失败');
    } finally {
      setSaveBusy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    if (!saveRequestId) return;
    if (saveRequestId === lastHandledSaveRequestIdRef.current) return;
    lastHandledSaveRequestIdRef.current = saveRequestId;
    saveCurrentPose44();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveRequestId, visible]);

  useEffect(() => {
    if (!visible) return;
    if (!saveInitialRequestId) return;
    saveCurrentInitialPose44();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveInitialRequestId, visible]);

  // “保存为最终位姿”：把当前选中实例的人工初始位姿写入 diffdope_json，
  // 然后清除人工初始位姿（initial_pose_json），保证后续流程都以最终位姿为准。
  useEffect(() => {
    if (!visible) return;
    if (!convertInitialToFinalRequestId) return;
    if (convertInitialToFinalRequestId === lastHandledConvertInitToFinalRequestIdRef.current) return;
    if (!imageId || !projectId) return;

    lastHandledConvertInitToFinalRequestIdRef.current = convertInitialToFinalRequestId;

    (async () => {
      if (convertInitToFinalBusy) return;

      const instanceKey = activeInstanceKeyRef.current;
      if (!instanceKey) {
        setStatus('未选中实例，无法转换');
        return;
      }
      const inst = targetInstancesRef.current.find((x) => x.instanceKey === instanceKey);
      if (!inst) {
        setStatus('未找到当前选中实例，无法转换');
        return;
      }

      const pair = pose44ByInstanceRef.current[instanceKey];
      if (!pair?.initial) {
        setStatus(`实例 ${inst.meshId}${inst.maskId ? `/${inst.maskId}` : ''} 没有人工初始位姿，无法转换为最终位姿`);
        return;
      }

      try {
        setConvertInitToFinalBusy(true);
        setStatus('正在将人工初始位姿写入最终位姿并清除初始位姿...');

        const cv = matrixValuesToCvPose44();
        if (!cv) throw new Error('无法从当前矩阵生成 pose44');

        // “保存为最终位姿（单实例）”不触发拟合图层合成
        await pose9dApi.saveDiffdopePose44(imageId, inst.meshId, cv, inst.maskId, { skipFitOverlay: true });

        // 先更新本地渲染状态，后端清除 initial_pose_json
        pose44ByInstanceRef.current[instanceKey] = { ...pose44ByInstanceRef.current[instanceKey], initial: null, final: cv };
        updateWireColorForInstance(instanceKey);

        await pose9dApi.deleteInitialPose(imageId, inst.meshId, inst.maskId);
        applyPoseToInstance(instanceKey, 'final');

        setStatus(`已将实例 ${inst.meshId}${inst.maskId ? `/${inst.maskId}` : ''} 转为最终位姿，并清除人工初始位姿`);
      } catch (e: any) {
        setStatus(e?.response?.data?.message || e?.message || '转换为最终位姿失败');
      } finally {
        setConvertInitToFinalBusy(false);
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convertInitialToFinalRequestId, visible, imageId, projectId]);

  // “补全初始位姿”：根据当前 2D masks 统计缺失实例，写入 initial_pose_json
  useEffect(() => {
    if (!visible) return;
    if (!fillInitialPosesRequestId) return;
    if (fillInitialPosesRequestId === lastHandledFillInitialPosesRequestIdRef.current) return;
    if (!imageId || !projectId) return;

    lastHandledFillInitialPosesRequestIdRef.current = fillInitialPosesRequestId;

    (async () => {
      try {
        const ok = await confirm(
          '确定根据当前图片的 2D masks 补全初始位姿吗？\n\n该操作会：\n1) 按 mask.label 找到对应 Mesh（mesh.skuLabel）\n2) 对缺失的 (meshId, maskId) 实例写入 initial_pose_json\n3) 若该实例已有最终位姿（diffdope_json）或已有人工初始位姿，则跳过',
          { title: '确认补全初始位姿' },
        );
        if (!ok) return;

        setStatus('补全初始位姿：读取 mask/mesh/深度与写回数据库...');
        const r = await fillInitialPosesByMasks({
          projectId,
          imageId,
          depthMode: depthMode || 'raw',
        });

        if (r.totalMasks === 0) {
          await alert('当前图片没有 2D mask，因此无法补全初始位姿。\n\n请先在 2D 人工标注页生成并保存 mask。', {
            title: '无法补全初始位姿（无 mask）',
          });
          setStatus('补全初始位姿：跳过（无 mask）');
          return;
        }

        // 触发完整重载，确保颜色/渲染姿态与 DB 同步。
        setSceneRefreshId((v) => v + 1);
        setStatus(
          `补全初始位姿完成：created=${r.created} updated=${r.updated} skipHave=${r.skippedAlreadyHave} skipNoMesh=${r.skippedNoMesh} skipNoIntr=${r.skippedNoIntrinsics}`,
        );

        if (r.missingLabels && r.missingLabels.length > 0) {
          const listText = r.missingLabels.map((l) => `- ${l}`).join('\n');
          await alert(
            `检测到以下 mask label 在项目中找不到对应 Mesh（mesh.skuLabel）：\n${listText}\n\n说明：以上标签对应的实例无法导入/补全；已能成功补全的实例仍已写入数据库。`,
            { title: '无法完全补全初始位姿（缺少 Mesh）' },
          );
        } else if (r.skippedNoMesh > 0) {
          // 兜底：skippedNoMesh>0 但 missingLabels 为空（极端情况下 label 为空等）
          await alert('部分 mask 无法找到对应 Mesh，因此有实例未能补全初始位姿。', {
            title: '无法完全补全初始位姿（缺少 Mesh）',
          });
        }
      } catch (e: any) {
        console.error('[PosePointCloudLayer] 补全初始位姿失败:', e);
        setStatus(e?.response?.data?.message || e?.message || '补全初始位姿失败');
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillInitialPosesRequestId, visible, imageId, projectId, depthMode]);

  useEffect(() => {
    if (!visible) return;
    if (!clear6dRequestId) return;
    if (clear6dRequestId === lastHandledClear6dRequestIdRef.current) return;
    if (!imageId) return;
    lastHandledClear6dRequestIdRef.current = clear6dRequestId;

    (async () => {
      try {
        setClear6dBusy(true);
        const ok = await confirm('确定清除本图内所有 6D 姿态标注吗？此操作会删除 diffdope_json 与 initial_pose_json。', {
          title: '确认清除',
        });
        if (!ok) return;
        await pose9dApi.clear6dByImageId(imageId);
        // 触发完整重载，确保颜色/渲染姿态与 DB 同步。
        setSceneRefreshId((v) => v + 1);
        setStatus('已清除本图内所有 6D 姿态标注（模型回归未标注渲染）');
      } catch (e: any) {
        setStatus(e?.response?.data?.message || e?.message || '清除 6D 标注失败');
      } finally {
        setClear6dBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clear6dRequestId, visible, imageId]);

  if (!visible) return null;
  return (
    <div className="pose-pointcloud-overlay">
      <div className="pose-pointcloud-toolbar">
        <div className="pose-pointcloud-meta">
          模式：{mode === 'translate' ? '平移(W)' : '旋转(E/R)'} ｜ 当前选中：
          {activeInstanceKey && pose44ByInstanceRef.current[activeInstanceKey]?.initial ? '人工初始位姿(绿)' : 'AI最终位姿(橙)'} ｜ 输出：Matrix4
          {' '}｜ 回退：Ctrl+Z ｜ 重做：Ctrl+Y / Ctrl+Shift+Z
        </div>
        <label style={{ marginLeft: '0.25rem', fontSize: '0.8rem', color: '#e5e7eb', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <input type="checkbox" checked={renderTextured} onChange={(e) => setRenderTextured(e.target.checked)} />
          真实贴图
        </label>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <button
            type="button"
            className="pose-pointcloud-title pose-pointcloud-title-btn"
            onClick={undoLastTransform}
            title="回退上一步变换（Ctrl+Z）"
          >
            回退
          </button>
          <button
            type="button"
            className="pose-pointcloud-title pose-pointcloud-title-btn"
            onClick={redoLastTransform}
            title="重做上一步回退（Ctrl+Y / Ctrl+Shift+Z）"
          >
            重做
          </button>
        </div>
      </div>
      <div className="pose-pointcloud-status">{status}</div>
      <div className="pose-pointcloud-canvas-wrap" ref={canvasWrapRef}>
        <div ref={hostRef} className="pose-pointcloud-canvas" />
        <div
          className="pose-pointcloud-matrix-panel floating"
          style={{
            left: matrixPos.x != null ? matrixPos.x : undefined,
            top: matrixPos.y != null ? matrixPos.y : undefined,
            right: matrixPos.x == null ? 10 : 'auto',
          }}
        >
          <div
            className="pose-pointcloud-matrix-drag-handle"
            onMouseDown={(ev) => {
              const box = (ev.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
              dragStateRef.current.dragging = true;
              dragStateRef.current.offsetX = ev.clientX - box.left;
              dragStateRef.current.offsetY = ev.clientY - box.top;
            }}
            title="拖动矩阵窗口"
          >
            Matrix4
          </div>
          <textarea className="pose-pointcloud-matrix-text" readOnly value={matrixText} />
        </div>
      </div>
    </div>
  );
};

export default PosePointCloudLayer;

