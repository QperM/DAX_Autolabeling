import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

function parseNpyFloat32(buffer: ArrayBuffer): { data: Float32Array; shape: number[] } {
  const bytes = new Uint8Array(buffer);
  // magic \x93NUMPY
  if (bytes.length < 10 || bytes[0] !== 0x93) throw new Error('不是有效的 .npy 文件（magic 不匹配）');
  const major = bytes[6];
  const minor = bytes[7];

  let headerLen = 0;
  let headerStart = 0;
  if (major === 1) {
    headerLen = new DataView(buffer, 8, 2).getUint16(0, true);
    headerStart = 10;
  } else if (major === 2) {
    headerLen = new DataView(buffer, 8, 4).getUint32(0, true);
    headerStart = 12;
  } else {
    throw new Error(`暂不支持的 .npy 版本: ${major}.${minor}`);
  }

  const headerBytes = bytes.slice(headerStart, headerStart + headerLen);
  const headerText = new TextDecoder('latin1').decode(headerBytes);

  const descrMatch = headerText.match(/'descr'\s*:\s*'([^']+)'/);
  const fortranMatch = headerText.match(/'fortran_order'\s*:\s*(True|False)/);
  const shapeMatch = headerText.match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!descrMatch || !fortranMatch || !shapeMatch) throw new Error('解析 .npy header 失败');

  const descr = descrMatch[1];
  const fortranOrder = fortranMatch[1] === 'True';
  if (fortranOrder) throw new Error('暂不支持 fortran_order=True 的 .npy');
  // 目前我们只需要 float32 little-endian: <f4
  if (descr !== '<f4' && descr !== '|f4') {
    throw new Error(`暂不支持的 dtype: ${descr}（目前仅支持 float32）`);
  }

  const shapeStr = shapeMatch[1].trim();
  const shape = shapeStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (shape.length < 2) throw new Error(`shape 解析失败: (${shapeStr})`);

  const dataOffset = headerStart + headerLen;
  const data = new Float32Array(buffer, dataOffset);
  return { data, shape };
}

type MeshInfo = {
  url: string;
  assetDirUrl?: string;
  assets?: string[];
};

type TransformValues = {
  position: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
};

type MeshBoundsInfo = {
  /** OBJ 原始尺寸（未做 fit-to-scene 缩放） */
  originalSize: { x: number; y: number; z: number };
  /** 场景中当前尺寸（包含 fit-to-scene 缩放 + 用户 scale） */
  sceneSize: { x: number; y: number; z: number };
  /** 加载阶段对 OBJ 做的 fit-to-scene 缩放倍率（= 0.5/maxDim） */
  fitScale: number;
};

type Props = {
  npyUrl: string | null;
  /** 默认假设深度单位是米；若是毫米可传入 0.001 */
  depthScale?: number;
  /** 点云下采样步长，越大越省性能 */
  stride?: number;
  /** 简易内参：不传时用 fx=fy=500, cx=w/2, cy=h/2 */
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
  /** 场景中需要渲染的 Mesh 列表（支持多 Mesh 同时显示） */
  meshes?: MeshInfo[] | null;
  /** 当前选中 Mesh（用于 TransformControls 绑定） */
  selectedMesh?: MeshInfo | null;
  /** 点击选中 Mesh（返回 mesh.url）；点空区域返回 null */
  onSelectMeshUrl?: (meshUrl: string | null) => void;
  /** 每个 mesh 的变换（key 使用 mesh.url） */
  meshTransformsByUrl?: Record<string, TransformValues> | null;
  /** 变换模式：'translate' | 'rotate' | 'scale' */
  transformMode?: 'translate' | 'rotate' | 'scale';
  /** 变换模式变化回调 */
  onTransformModeChange?: (mode: 'translate' | 'rotate' | 'scale') => void;
  /** 场景内 mesh 变换变化时回传到 UI（例如拖拽 TransformControls） */
  onTransformValuesChange?: (meshUrl: string, values: TransformValues) => void;
  /** Mesh 的 bounding box 信息变化回调（用于 UI 展示真实尺寸） */
  onMeshBoundsChange?: (info: MeshBoundsInfo | null) => void;
  /** 任意 mesh 加载完成后回传其 base 信息（用于“按图片批量保存”时拿到每个 mesh 的原始尺寸/fitScale） */
  onMeshBaseInfo?: (meshUrl: string, base: Pick<MeshBoundsInfo, 'originalSize' | 'fitScale'>) => void;
  /** 从 UI 发起的变换应用请求（id 用于触发应用） */
  transformRequest?: (TransformValues & { id: number; meshUrl: string }) | null;
};

const PointCloudPreview3D: React.FC<Props> = ({ 
  npyUrl, 
  depthScale = 1.0, 
  stride = 2, 
  intrinsics,
  meshes,
  selectedMesh,
  onSelectMeshUrl,
  transformMode = 'translate',
  onTransformModeChange,
  onTransformValuesChange,
  onMeshBoundsChange,
  onMeshBaseInfo,
  transformRequest,
  meshTransformsByUrl,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // three objects (persist across mesh swaps; rebuilt when npyUrl/depth params change)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const pointsRef = useRef<THREE.Points | null>(null);
  const meshGroupRef = useRef<THREE.Group | null>(null);
  const loadedMeshesRef = useRef<Map<string, THREE.Object3D>>(new Map()); // url -> object
  const loadingMeshesRef = useRef<Map<string, Promise<THREE.Object3D | null>>>(new Map()); // url -> in-flight promise
  const meshBaseByUrlRef = useRef<Map<string, Pick<MeshBoundsInfo, 'originalSize' | 'fitScale'>>>(new Map());
  const meshTransformsRef = useRef<Record<string, TransformValues> | null>(null);
  const onSelectMeshUrlRef = useRef<((meshUrl: string | null) => void) | null>(null);
  const onTransformModeChangeRef = useRef<((mode: 'translate' | 'rotate' | 'scale') => void) | null>(null);
  const selectionRingRef = useRef<THREE.Mesh | null>(null);
  const selectionRingGeomRef = useRef<THREE.RingGeometry | null>(null);
  const selectionRingMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const abortedRef = useRef<boolean>(false);
  const didAutoFitRef = useRef<boolean>(false); // only auto-fit camera on first point-cloud build

  const transformControlsRef = useRef<TransformControls | null>(null);
  const transformHelperRef = useRef<THREE.Object3D | null>(null);
  const isDraggingGizmoRef = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const transformModeRef = useRef<'translate' | 'rotate' | 'scale'>(transformMode);
  const attachedObjectRef = useRef<THREE.Object3D | null>(null);
  const onTransformValuesChangeRef = useRef<Props['onTransformValuesChange']>(onTransformValuesChange);
  const onMeshBoundsChangeRef = useRef<Props['onMeshBoundsChange']>(onMeshBoundsChange);
  const onMeshBaseInfoRef = useRef<Props['onMeshBaseInfo']>(onMeshBaseInfo);
  const lastAppliedRequestIdRef = useRef<number>(-1);
  const isSanitizingScaleRef = useRef(false);
  const meshBoundsBaseRef = useRef<Pick<MeshBoundsInfo, 'originalSize' | 'fitScale'> | null>(null);
  
  const pruneGizmo = (helper: THREE.Object3D | null) => {
    if (!helper) return;
    // 只保留 X/Y/Z 轴，把平面把手（XY/YZ/XZ）等隐藏掉，避免眼花缭乱
    helper.traverse((child: any) => {
      const name = String(child?.name || '');
      if (!name) return;
      if (name === 'XY' || name === 'YZ' || name === 'XZ' || name === 'XYZ') {
        child.visible = false;
      }
    });
  };

  // 同步 transformMode prop 到 ref 和 transformControls
  useEffect(() => {
    transformModeRef.current = transformMode;
    if (transformControlsRef.current) {
      transformControlsRef.current.setMode(transformMode);
    }
    pruneGizmo(transformHelperRef.current);
  }, [transformMode]);

  useEffect(() => {
    onTransformValuesChangeRef.current = onTransformValuesChange;
  }, [onTransformValuesChange]);

  useEffect(() => {
    onMeshBoundsChangeRef.current = onMeshBoundsChange;
  }, [onMeshBoundsChange]);

  useEffect(() => {
    onMeshBaseInfoRef.current = onMeshBaseInfo;
  }, [onMeshBaseInfo]);

  const emitMeshBounds = useCallback((payload: MeshBoundsInfo | null) => {
    onMeshBoundsChangeRef.current?.(payload);
  }, []);

  const recomputeAndEmitSceneBounds = useCallback(() => {
    const obj = attachedObjectRef.current;
    const base = meshBoundsBaseRef.current;
    if (!obj || !base) return;

    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);

    emitMeshBounds({
      originalSize: base.originalSize,
      fitScale: base.fitScale,
      sceneSize: { x: size.x, y: size.y, z: size.z },
    });
  }, [emitMeshBounds]);

  // UI -> 场景：应用 transformRequest（不触发重建场景）
  useEffect(() => {
    if (!transformRequest) return;
    if (transformRequest.id === lastAppliedRequestIdRef.current) return;
    const obj = attachedObjectRef.current;
    if (!obj) return;

    const attachedUrl = String((obj as any)?.userData?.meshUrl || '');
    if (!attachedUrl) return;
    // 关键：只把 UI 的请求应用到目标 mesh，避免切换选中时把 mesh2 的 request 套到 mesh1 上
    if (transformRequest.meshUrl !== attachedUrl) return;

    lastAppliedRequestIdRef.current = transformRequest.id;

    const { position, rotationDeg, scale } = transformRequest;
    obj.position.set(position.x, position.y, position.z);
    obj.rotation.set(
      THREE.MathUtils.degToRad(rotationDeg.x),
      THREE.MathUtils.degToRad(rotationDeg.y),
      THREE.MathUtils.degToRad(rotationDeg.z),
    );
    // 约定：UI 侧 scale 是“倍率”（相对于 fitScale），这里转换成场景中的绝对 scale
    const base = meshBoundsBaseRef.current?.fitScale ?? 1;
    const mul = Math.max(1e-6, Math.abs((scale.x + scale.y + scale.z) / 3 || 1));
    const absS = base * mul;
    obj.scale.set(absS, absS, absS);
    obj.updateMatrixWorld(true);
    recomputeAndEmitSceneBounds();

    // 同步 TransformControls 到新的 object 状态
    if (transformControlsRef.current) {
      // attach 的 object 不变，仅更新状态即可
      // three@0.183 typings: update(deltaTime) requires 1 arg
      transformControlsRef.current.update(0);
    }
  }, [transformRequest, recomputeAndEmitSceneBounds]);

  const sanitizeScaleIfNeeded = useCallback(() => {
    const obj = attachedObjectRef.current;
    const tc = transformControlsRef.current;
    if (!obj || !tc) return;
    if (transformModeRef.current !== 'scale') return;
    if (isSanitizingScaleRef.current) return;

    // TransformControls 在 scale 模式可能会把 scale 拉过 0，造成负 scale（视觉上会跳变/翻转）。
    const sx = obj.scale.x;
    const sy = obj.scale.y;
    const sz = obj.scale.z;
    const avg = (sx + sy + sz) / 3;
    const absAvg = Math.max(1e-6, Math.abs(Number.isFinite(avg) ? avg : 1));
    if (!Number.isFinite(absAvg)) return;

    const base = meshBoundsBaseRef.current?.fitScale ?? 1;
    const mul = Math.max(1e-6, absAvg / Math.max(1e-12, base));
    const absS = base * mul;

    // 只在出现负数或非等比时矫正，减少事件风暴
    const needFix =
      sx <= 0 ||
      sy <= 0 ||
      sz <= 0 ||
      Math.abs(sx - absS) > 1e-6 ||
      Math.abs(sy - absS) > 1e-6 ||
      Math.abs(sz - absS) > 1e-6;
    if (!needFix) return;

    isSanitizingScaleRef.current = true;
    obj.scale.set(absS, absS, absS);
    obj.updateMatrixWorld(true);
    // three@0.183 typings: update(deltaTime) requires 1 arg
    tc.update(0);
    recomputeAndEmitSceneBounds();
    isSanitizingScaleRef.current = false;
  }, [recomputeAndEmitSceneBounds]);

  useEffect(() => {
    setError(null);
  }, [npyUrl]);

  const emitTransformValues = useCallback(() => {
      const obj = attachedObjectRef.current;
      if (!obj) return;
      const cb = onTransformValuesChangeRef.current;
      if (!cb) return;
    const meshUrl = String((obj as any)?.userData?.meshUrl || '');
    if (!meshUrl) return;
    // scale（倍率）= 场景绝对 scale / fitScale
    const baseRaw = meshBoundsBaseRef.current?.fitScale ?? 1;
    const base = Number.isFinite(baseRaw) && Math.abs(baseRaw) > 1e-9 ? Math.abs(baseRaw) : 1;
    let mul = Math.abs(obj.scale.x) / base;
    if (!Number.isFinite(mul) || mul <= 0) mul = 1;
    // 防御：出现异常爆炸时（例如 base 异常或 scale 被污染）避免把巨大值回写到 UI 造成“700倍”
    if (mul > 200) mul = 200;
    mul = Math.max(1e-6, mul);
      cb(meshUrl, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotationDeg: {
          x: THREE.MathUtils.radToDeg(obj.rotation.x),
          y: THREE.MathUtils.radToDeg(obj.rotation.y),
          z: THREE.MathUtils.radToDeg(obj.rotation.z),
        },
      scale: { x: mul, y: mul, z: mul },
      });
  }, []);

  const updateSelectionRing = useCallback(() => {
    const selectionRing = selectionRingRef.current;
    const transformControls = transformControlsRef.current;
    if (!selectionRing || !transformControls) return;

      const obj = transformControls.object as THREE.Object3D | undefined;
      if (!obj) {
        selectionRing.visible = false;
        return;
      }

      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const r = Math.max(size.x, size.z) * 0.6 || 0.3;
      selectionRing.position.set(center.x, box.min.y + 0.001, center.z);
    selectionRing.scale.setScalar(Math.max(0.25, r));
      selectionRing.visible = true;
  }, []);

  const disposeObject = (obj: THREE.Object3D) => {
    obj.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              if (mesh.geometry) mesh.geometry.dispose();
              if (mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material.dispose();
              }
            }
          });
  };

  const removeCurrentMeshFromScene = useCallback(() => {
    const transformControls = transformControlsRef.current;
    transformControls?.detach();
    attachedObjectRef.current = null;
    meshBoundsBaseRef.current = null;
    updateSelectionRing();
    emitMeshBounds(null);
  }, [emitMeshBounds, updateSelectionRing]);

  // 将 prop 写入 ref，避免 transform 更新触发“重新加载 mesh”效果
  useEffect(() => {
    meshTransformsRef.current = (meshTransformsByUrl as any) || null;
  }, [meshTransformsByUrl]);

  useEffect(() => {
    onSelectMeshUrlRef.current = onSelectMeshUrl || null;
  }, [onSelectMeshUrl]);

  useEffect(() => {
    onTransformModeChangeRef.current = onTransformModeChange || null;
  }, [onTransformModeChange]);

  const applyTransformForMesh = useCallback((meshUrl: string, obj: THREE.Object3D, values?: TransformValues | null) => {
    if (!values) return;
    const { position, rotationDeg, scale } = values;
    obj.position.set(position.x, position.y, position.z);
    obj.rotation.set(
      THREE.MathUtils.degToRad(rotationDeg.x),
      THREE.MathUtils.degToRad(rotationDeg.y),
      THREE.MathUtils.degToRad(rotationDeg.z),
    );
    // scale 是“倍率”（相对 fitScale），而 obj.scale 在 loadMeshIntoScene 时会被设置为 fitScale
    const base = meshBaseByUrlRef.current.get(meshUrl)?.fitScale ?? meshBoundsBaseRef.current?.fitScale ?? 1;
    const mul = Math.max(1e-6, Math.abs((scale.x + scale.y + scale.z) / 3 || 1));
    const absS = base * mul;
    obj.scale.set(absS, absS, absS);
    obj.updateMatrixWorld(true);
  }, []);

  const loadMeshIntoScene = useCallback(
    async (meshInfo: MeshInfo, opts?: { attach?: boolean }) => {
      const scene = sceneRef.current;
      const transformControls = transformControlsRef.current;
      if (!scene || !transformControls) return;
      if (abortedRef.current) return;

      const shouldAttach = opts?.attach !== false;
      try {
        // 若当前已经 attach 的就是这个 mesh，则无需重复 attach（避免每次点击都触发 emit 导致 UI scale 抖动）
        const alreadyAttached = attachedObjectRef.current;
        if (shouldAttach && alreadyAttached && (alreadyAttached as any)?.userData?.meshUrl === meshInfo.url) {
          updateSelectionRing();
          recomputeAndEmitSceneBounds();
          return;
        }

        // 去重：同一个 url 已加载就直接复用
        const existing = loadedMeshesRef.current.get(meshInfo.url);
        if (existing) {
          if (shouldAttach) {
            // console.log('[PointCloudPreview3D] loadMeshIntoScene: 已存在 mesh，复用并 attach', { meshUrl: meshInfo.url });
            removeCurrentMeshFromScene();
            transformControls.attach(existing);
            attachedObjectRef.current = existing;
            // 关键：复用 attach 时也要恢复 base（fitScale），否则 emitTransformValues 会把“绝对 scale”当成“倍率”
            const base = meshBaseByUrlRef.current.get(meshInfo.url) || null;
            meshBoundsBaseRef.current = base ? { originalSize: base.originalSize, fitScale: base.fitScale } : null;
            updateSelectionRing();
            emitTransformValues();
            recomputeAndEmitSceneBounds();
          }
          return;
        }

        // 去重：同一个 url 正在加载中，则等待它完成后复用（防止并发加载导致“场景里出现两个 mesh，其中一个不可选中”）
        const inFlight = loadingMeshesRef.current.get(meshInfo.url);
        if (inFlight) {
          const obj = await inFlight;
          if (!obj) return;
          if (abortedRef.current) return;
          if (shouldAttach) {
            // console.log('[PointCloudPreview3D] loadMeshIntoScene: 等待 in-flight 加载完成后 attach', { meshUrl: meshInfo.url });
            removeCurrentMeshFromScene();
            transformControls.attach(obj);
            attachedObjectRef.current = obj;
            const base = meshBaseByUrlRef.current.get(meshInfo.url) || null;
            meshBoundsBaseRef.current = base ? { originalSize: base.originalSize, fitScale: base.fitScale } : null;
            updateSelectionRing();
            emitTransformValues();
            recomputeAndEmitSceneBounds();
          }
          return;
        }

        // 创建 in-flight promise，并立刻注册，避免并发进入
        const promise = (async (): Promise<THREE.Object3D | null> => {
          try {
            // keep camera/controls as-is；保留旧 Mesh，只切换 TransformControls 绑定目标
            // console.log('[PointCloudPreview3D] loadMeshIntoScene: 开始加载 Mesh', {
            //   imageId: undefined,
            //   meshUrl: meshInfo.url,
            //   meshAssetsCount: meshInfo.assets?.length ?? 0,
            // });
            // 仅在需要 attach 时从旧目标上拆下 TransformControls；预加载不影响当前选中
            if (shouldAttach) {
              removeCurrentMeshFromScene();
            }

            const baseDir =
              meshInfo.assetDirUrl && meshInfo.assetDirUrl.startsWith('http')
                ? meshInfo.assetDirUrl
                : meshInfo.url.includes('/')
                  ? meshInfo.url.slice(0, meshInfo.url.lastIndexOf('/') + 1)
                  : meshInfo.url;

            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url: string) => {
              if (!url) return url;
              if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
              const clean = String(url).replace(/\\/g, '/');
              const tryPickExisting = (raw: string) => {
                if (!meshInfo.assets || meshInfo.assets.length === 0) return raw;
                const base = raw.split('/').filter(Boolean).pop() || raw;
                const lower = base.toLowerCase();
                const hit = meshInfo.assets.find((a) => (a || '').toLowerCase() === lower);
                return hit || raw;
              };
              const normalized = tryPickExisting(clean);
              const encoded = normalized
                .split('/')
                .filter(Boolean)
                .map((seg) => encodeURIComponent(seg))
                .join('/');
              return `${baseDir}${encoded}`;
            });

            const resp = await fetch(meshInfo.url, { credentials: 'include' });
            if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
            const objText = await resp.text();
            if (abortedRef.current) return null;

            const parseMtlName = (text: string) => {
              const lines = text.split(/\r?\n/);
              for (const line of lines) {
                const t = line.trim();
                if (!t || t.startsWith('#')) continue;
                if (t.toLowerCase().startsWith('mtllib ')) return t.slice(7).trim();
              }
              return null;
            };

            const objLoader = new OBJLoader(manager);
            const mtlName = parseMtlName(objText);
            const pickMtlCandidate = (mtl: string | null, assetList?: string[]) => {
              if (!mtl) return null;
              if (!assetList || assetList.length === 0) return null;
              const onlyMtl = assetList.filter((a) => a.toLowerCase().endsWith('.mtl'));
              if (onlyMtl.length === 0) return null;
              const exact = onlyMtl.find((a) => a.toLowerCase() === mtl.toLowerCase());
              if (exact) return exact;
              const stem = mtl.replace(/\.mtl$/i, '').toLowerCase();
              const fuzzy = onlyMtl.find((a) => a.toLowerCase().includes(stem));
              return fuzzy || null;
            };

            const mtlToLoad = pickMtlCandidate(mtlName, meshInfo.assets);
            if (mtlToLoad) {
              const mtlLoader = new MTLLoader(manager);
              mtlLoader.setPath(baseDir);
              mtlLoader.setResourcePath(baseDir);
              const materials = await new Promise<any>((resolve, reject) => {
                mtlLoader.load(mtlToLoad, resolve, undefined, reject);
              });
              materials.preload();
              objLoader.setMaterials(materials);
            }

            const obj = objLoader.parse(objText) as THREE.Group;
            meshGroupRef.current = obj;
            (obj as any).userData = { ...(obj as any).userData, meshUrl: meshInfo.url };

            // 先计算原始 bounding box（未缩放/未居中）
            const originalBox = new THREE.Box3().setFromObject(obj);
            const originalSizeV = new THREE.Vector3();
            originalBox.getSize(originalSizeV);

            // 如果没有材质，给一个默认材质
            let hasMaterial = false;
            obj.traverse((child: THREE.Object3D) => {
              if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                if (mesh.material) hasMaterial = true;
              }
            });
            if (!hasMaterial) {
              obj.traverse((child: THREE.Object3D) => {
                if ((child as THREE.Mesh).isMesh) {
                  const mesh = child as THREE.Mesh;
                  mesh.material = new THREE.MeshStandardMaterial({
                    color: 0x93c5fd,
                    metalness: 0.15,
                    roughness: 0.7,
                  });
                }
              });
            }

            // 居中并缩放 Mesh（fit-to-scene）
            const box = new THREE.Box3().setFromObject(obj);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const fitScale = 0.5 / maxDim;
            // 默认用户倍率 = 1
            obj.scale.setScalar(fitScale * 1);
            const center = new THREE.Vector3();
            box.getCenter(center);
            obj.position.sub(center);

            // fit 后的 bounding box（此时还未做用户缩放；但 scale 已经生效）
            const sceneBox = new THREE.Box3().setFromObject(obj);
            const sceneSizeV = new THREE.Vector3();
            sceneBox.getSize(sceneSizeV);

            scene.add(obj);
            loadedMeshesRef.current.set(meshInfo.url, obj);
            meshBaseByUrlRef.current.set(meshInfo.url, {
              originalSize: { x: originalSizeV.x, y: originalSizeV.y, z: originalSizeV.z },
              fitScale,
            });
            onMeshBaseInfoRef.current?.(meshInfo.url, {
              originalSize: { x: originalSizeV.x, y: originalSizeV.y, z: originalSizeV.z },
              fitScale,
            });

            // 若提供了该 mesh 的 transform，则立即应用（不需要 attach 也能让其位置正确）
            const t = meshTransformsRef.current?.[meshInfo.url] || null;
            if (t) {
              applyTransformForMesh(meshInfo.url, obj, t);
            }

            // attach & emit（仅对当前选中）
            if (shouldAttach) {
              transformControls.attach(obj);
              attachedObjectRef.current = obj;
              meshBoundsBaseRef.current = {
                originalSize: { x: originalSizeV.x, y: originalSizeV.y, z: originalSizeV.z },
                fitScale,
              };
              updateSelectionRing();
              emitTransformValues();
              emitMeshBounds({
                originalSize: { x: originalSizeV.x, y: originalSizeV.y, z: originalSizeV.z },
                sceneSize: { x: sceneSizeV.x, y: sceneSizeV.y, z: sceneSizeV.z },
                fitScale,
              });
            }
            // console.log('[PointCloudPreview3D] loadMeshIntoScene: Mesh 已加载到场景', {
            //   originalSize: originalSizeV,
            //   sceneSize: sceneSizeV,
            //   fitScale,
            //   currentScale: obj.scale,
            // });

            return obj;
          } catch (e: any) {
            console.error('[PointCloudPreview3D] Mesh 加载失败:', e);
            return null;
          }
        })();

        loadingMeshesRef.current.set(meshInfo.url, promise);
        await promise;
        loadingMeshesRef.current.delete(meshInfo.url);
        return;
      } catch (e: any) {
        console.error('[PointCloudPreview3D] Mesh 加载失败:', e);
      }
    },
    [emitMeshBounds, emitTransformValues, recomputeAndEmitSceneBounds, removeCurrentMeshFromScene, updateSelectionRing],
  );

  // init / rebuild scene when point cloud inputs change (NOT when mesh changes)
  useEffect(() => {
    if (!containerRef.current) return;
    if (!npyUrl) return;

    const el = containerRef.current;
    const width = Math.max(1, el.clientWidth);
    const height = Math.max(1, el.clientHeight);

    // teardown any previous instance first (defensive)
    abortedRef.current = true;
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    controlsRef.current?.dispose();
    controlsRef.current = null;
    transformControlsRef.current?.dispose();
    transformControlsRef.current = null;
    transformHelperRef.current = null;

    const prevScene = sceneRef.current;
    if (prevScene) {
      const helper = transformHelperRef.current;
      if (helper) prevScene.remove(helper);
    }
    const selectionRing = selectionRingRef.current;
    if (selectionRing && sceneRef.current) sceneRef.current.remove(selectionRing);

    const points = pointsRef.current;
    if (points) {
      (points.geometry as THREE.BufferGeometry).dispose();
      (points.material as THREE.Material).dispose();
    }
    pointsRef.current = null;

    const meshGroup = meshGroupRef.current;
    if (meshGroup && sceneRef.current) {
      sceneRef.current.remove(meshGroup);
      disposeObject(meshGroup);
    }
    meshGroupRef.current = null;
    attachedObjectRef.current = null;
    loadedMeshesRef.current.clear();

    // 彻底释放旧 WebGL context，避免反复 mount 导致 "Too many active WebGL contexts"
    if (rendererRef.current) {
      try {
        rendererRef.current.forceContextLoss();
      } catch {
        // ignore
      }
      try {
        rendererRef.current.dispose();
      } catch {
        // ignore
      }
    }
    rendererRef.current = null;
    sceneRef.current = null;
    cameraRef.current = null;
    didAutoFitRef.current = false;

    // now build new instance
    abortedRef.current = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.innerHTML = '';
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#020617');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 1000);
    camera.position.set(0, 0, 2.2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(2, 2, 2);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const grid = new THREE.GridHelper(2, 10, 0x334155, 0x1f2937);
    (grid.material as any).opacity = 0.35;
    (grid.material as any).transparent = true;
    scene.add(grid);

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode(transformModeRef.current);
    transformControls.setSpace('local');
    const transformHelper = transformControls.getHelper();
    transformHelperRef.current = transformHelper;
    pruneGizmo(transformHelper);
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;

    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
      isDraggingGizmoRef.current = !!event.value;
      // 结束拖拽时同步一次最终结果（平时不要在 change 里持续回写，避免抖动/误触）
      if (!event.value) {
        emitTransformValues();
      }
    });
    transformControls.addEventListener('objectChange', () => {
      sanitizeScaleIfNeeded();
      updateSelectionRing();
      recomputeAndEmitSceneBounds();
    });
    transformControls.addEventListener('change', () => {
      sanitizeScaleIfNeeded();
      updateSelectionRing();
      // 只在拖拽 gizmo 期间回写 UI，避免鼠标轻微移动/轨道阻尼触发“误更新 scale”
      if (isDraggingGizmoRef.current) {
        emitTransformValues();
      }
      recomputeAndEmitSceneBounds();
    });

    const selectionRingGeom = new THREE.RingGeometry(0.45, 0.5, 64);
    const selectionRingMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
    });
    const selectionRingMesh = new THREE.Mesh(selectionRingGeom, selectionRingMat);
    selectionRingMesh.rotation.x = Math.PI / 2;
    selectionRingMesh.visible = false;
    scene.add(selectionRingMesh);
    selectionRingRef.current = selectionRingMesh;
    selectionRingGeomRef.current = selectionRingGeom;
    selectionRingMatRef.current = selectionRingMat;

    const buildPointCloud = async () => {
      try {
        const resp = await fetch(npyUrl, { credentials: 'include' });
        if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
        const buf = await resp.arrayBuffer();
        if (abortedRef.current) return;

        const { data, shape } = parseNpyFloat32(buf);
        const h = shape[0];
        const w = shape[1];

        const fx = intrinsics?.fx ?? 500;
        const fy = intrinsics?.fy ?? 500;
        const cx = intrinsics?.cx ?? w / 2;
        const cy = intrinsics?.cy ?? h / 2;

        const step = Math.max(1, Math.floor(stride));
        const estCount = Math.ceil(h / step) * Math.ceil(w / step);

        const positions = new Float32Array(estCount * 3);
        const colors = new Float32Array(estCount * 3);
        let k = 0;

        let zMin = Number.POSITIVE_INFINITY;
        let zMax = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const z = data[y * w + x] * depthScale;
            if (!Number.isFinite(z) || z <= 0) continue;
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
          }
        }
        if (!Number.isFinite(zMin) || zMax <= 0) {
          throw new Error('深度数据为空或全为 0，无法生成点云');
        }

        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const z = data[y * w + x] * depthScale;
            if (!Number.isFinite(z) || z <= 0) continue;

            const X = ((x - cx) / fx) * z;
            const Y = -((y - cy) / fy) * z;
            const Z = -z;

            positions[k * 3 + 0] = X;
            positions[k * 3 + 1] = Y;
            positions[k * 3 + 2] = Z;

            const t = (z - zMin) / Math.max(1e-6, zMax - zMin);
            const c = 1.0 - Math.min(1, Math.max(0, t));
            colors[k * 3 + 0] = 0.25 + 0.75 * c;
            colors[k * 3 + 1] = 0.35 + 0.45 * c;
            colors[k * 3 + 2] = 0.95;

            k++;
          }
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, k * 3), 3));
        geom.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, k * 3), 3));
        geom.computeBoundingSphere();

        const mat = new THREE.PointsMaterial({
          size: 0.006,
          vertexColors: true,
          transparent: true,
          opacity: 0.95,
          sizeAttenuation: true,
        });

        const points = new THREE.Points(geom, mat);
        pointsRef.current = points;
        scene.add(points);

        // 只在首次 build 时自动对齐视角，后续换 mesh/重渲染不抢视角
        const sphere = geom.boundingSphere;
        if (sphere && !didAutoFitRef.current) {
          didAutoFitRef.current = true;
          controls.target.copy(sphere.center);
          camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + Math.max(1.2, sphere.radius * 2.2));
          camera.near = 0.01;
          camera.far = Math.max(10, sphere.radius * 10);
          camera.updateProjectionMatrix();
        }
      } catch (e: any) {
        console.error('[PointCloudPreview3D] 点云构建失败:', e);
        setError(e?.message || '点云构建失败');
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      
      const key = event.key.toLowerCase();
      if (key === 'w' || key === 'e' || key === 'r') {
        event.preventDefault();
        let newMode: 'translate' | 'rotate' | 'scale' = transformModeRef.current;
        if (key === 'w') newMode = 'translate';
        else if (key === 'e') newMode = 'rotate';
        else if (key === 'r') newMode = 'scale';
        
        if (newMode !== transformModeRef.current) {
          transformModeRef.current = newMode;
          transformControls.setMode(newMode);
          onTransformModeChangeRef.current?.(newMode);
        }
      }
    };

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const handlePointerDown = (event: PointerEvent) => {
      // 输入框聚焦时不处理（避免误触）
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      // 正在拖拽 gizmo 时不处理（否则拖动会被当成“点击选中”）
      if (isDraggingGizmoRef.current) return;
      const r = rendererRef.current;
      const c = cameraRef.current;
      if (!r || !c) return;

      const canvas = r.domElement;
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      ndc.set(x, y);
      raycaster.setFromCamera(ndc, c);

      // 命中检测：对当前场景中已加载的 meshes 做 raycast
      const targets: THREE.Object3D[] = Array.from(loadedMeshesRef.current.values());
      const hits = raycaster.intersectObjects(targets, true);
      if (!hits || hits.length === 0) {
        onSelectMeshUrlRef.current?.(null);
        return;
      }

      // 从命中的子 mesh 往上找带 meshUrl 的根 group
      let obj: THREE.Object3D | null = hits[0].object;
      let meshUrl: string | null = null;
      while (obj) {
        const u = (obj as any).userData?.meshUrl;
        if (typeof u === 'string' && u) {
          meshUrl = u;
          break;
        }
        obj = obj.parent;
      }
      if (!meshUrl) return;
      onSelectMeshUrlRef.current?.(meshUrl);
    };

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      transformControls.update(0);
      renderer.render(scene, camera);
    };

    buildPointCloud();
    animate();
    window.addEventListener('keydown', handleKeyDown);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    
    // resize observer
    const onResize = () => {
      const r = rendererRef.current;
      const c = cameraRef.current;
      if (!containerRef.current || !r || !c) return;
      const w = Math.max(1, containerRef.current.clientWidth);
      const h = Math.max(1, containerRef.current.clientHeight);
      r.setSize(w, h);
      c.aspect = w / h;
      c.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(() => onResize());
    ro.observe(el);
    roRef.current = ro;

    return () => {
      abortedRef.current = true;
      ro.disconnect();
      roRef.current = null;
      window.removeEventListener('keydown', handleKeyDown);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;

      controls.dispose();
      transformControls.dispose();
      controlsRef.current = null;
      transformControlsRef.current = null;
      transformHelperRef.current = null;

      if (selectionRingMesh) scene.remove(selectionRingMesh);
      selectionRingGeom.dispose();
      selectionRingMat.dispose();
      selectionRingRef.current = null;
      selectionRingGeomRef.current = null;
      selectionRingMatRef.current = null;

      const pts = pointsRef.current;
      if (pts) {
        (pts.geometry as THREE.BufferGeometry).dispose();
        (pts.material as THREE.Material).dispose();
      }
      pointsRef.current = null;

      const mg = meshGroupRef.current;
      if (mg) {
        scene.remove(mg);
        disposeObject(mg);
      }
      meshGroupRef.current = null;
      attachedObjectRef.current = null;
      loadedMeshesRef.current.clear();
      meshBaseByUrlRef.current.clear();

      // 彻底释放 WebGL context（非常关键：浏览器对 context 数量有上限）
      try {
        renderer.forceContextLoss();
      } catch {
        // ignore
      }
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      didAutoFitRef.current = false;
      el.innerHTML = '';
    };
  }, [npyUrl, depthScale, stride, intrinsics, emitTransformValues, updateSelectionRing]);

  // Mesh swap: only load/unload meshes; never attach during preload (prevents selection thrash / other-mesh reset)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const list = (meshes || []).filter((m) => m && m.url);
    const wantUrls = new Set(list.map((m) => m.url));
    // 移除不再需要的 meshes
    for (const [url, obj] of loadedMeshesRef.current.entries()) {
      if (!wantUrls.has(url)) {
        const tc = transformControlsRef.current;
        if (tc && tc.object === obj) {
          tc.detach();
        }
        scene.remove(obj);
        disposeObject(obj);
        loadedMeshesRef.current.delete(url);
      }
    }
    // 加载缺失的 meshes（不抢当前选中/控制器绑定）
    (async () => {
      for (const m of list) {
        if (abortedRef.current) return;
        if (loadedMeshesRef.current.has(m.url)) continue;
        // 只加载进 scene，不做 attach / emit，避免每加载一个 mesh 都触发 UI 更新和 attach 抢占
        await loadMeshIntoScene(m, { attach: false });
        // 若提供了该 mesh 的 transform，则立即应用（按 url 查 fitScale）
        const t = meshTransformsRef.current?.[m.url];
        const obj = loadedMeshesRef.current.get(m.url);
        if (obj && t) {
          applyTransformForMesh(m.url, obj, t);
        }
      }
    })();

    if (!selectedMesh) {
      removeCurrentMeshFromScene();
      return;
    }
    loadMeshIntoScene(selectedMesh, { attach: true });
  }, [meshes, selectedMesh, loadMeshIntoScene, removeCurrentMeshFromScene]);

  // transforms 更新时：只做 apply，不触发 load/attach（避免循环）
  useEffect(() => {
    const tmap = meshTransformsByUrl || null;
    if (!tmap) return;
    for (const [url, obj] of loadedMeshesRef.current.entries()) {
      const t = tmap[url];
      if (!t) continue;
      applyTransformForMesh(url, obj, t);
    }
  }, [meshTransformsByUrl, applyTransformForMesh]);

  // 当选中 mesh 变化或其 transform 有变化时，应用 transform（只对选中 mesh，保证行为稳定）
  useEffect(() => {
    if (!selectedMesh) return;
    const obj = attachedObjectRef.current;
    if (!obj) return;
    const t = meshTransformsByUrl?.[selectedMesh.url] || null;
    if (!t) return;
    applyTransformForMesh(selectedMesh.url, obj, t);
    updateSelectionRing();
    recomputeAndEmitSceneBounds();
  }, [selectedMesh?.url, meshTransformsByUrl, applyTransformForMesh, emitTransformValues, recomputeAndEmitSceneBounds, updateSelectionRing]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            color: '#e5e7eb',
            background: 'rgba(2,6,23,0.72)',
            textAlign: 'center',
            fontSize: '0.9rem',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default PointCloudPreview3D;

