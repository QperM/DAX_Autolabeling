import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { depthApi, meshApi, pose9dApi } from '../../services/api';
import { toAbsoluteUrl } from '../../utils/urls';

type Props = {
  visible: boolean;
  projectId: number | null;
  imageId: number | null;
  saveRequestId?: number;
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

type TransformHistoryEntry = {
  meshId: number;
  before: number[];
  after: number[];
};

const PosePointCloudLayer: React.FC<Props> = ({ visible, projectId, imageId, saveRequestId = 0 }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('准备中...');
  const [matrixValues, setMatrixValues] = useState<number[]>(identity16());
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const [renderTextured, setRenderTextured] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [activeMeshId, setActiveMeshId] = useState<number | null>(null);
  const [sceneRefreshId, setSceneRefreshId] = useState(0);
  const [matrixPos, setMatrixPos] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [showMeshPicker, setShowMeshPicker] = useState(false);
  const [meshList, setMeshList] = useState<any[]>([]);
  const [meshListLoading, setMeshListLoading] = useState(false);
  const [manualMeshIds, setManualMeshIds] = useState<number[]>([]);
  const transformRef = useRef<TransformControls | null>(null);
  const meshObjRef = useRef<THREE.Object3D | null>(null);
  const meshByIdRef = useRef<Map<number, THREE.Object3D>>(new Map());
  const undoStackRef = useRef<TransformHistoryEntry[]>([]);
  const redoStackRef = useRef<TransformHistoryEntry[]>([]);
  const dragStartMatrixRef = useRef<number[] | null>(null);
  const materialEntriesRef = useRef<Array<{ mesh: THREE.Mesh; textured: THREE.Material | THREE.Material[]; wire: THREE.Material }>>([]);
  const dragStateRef = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({ dragging: false, offsetX: 0, offsetY: 0 });

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
    const obj = meshByIdRef.current.get(last.meshId) || null;
    if (!obj) {
      setStatus(`回退失败：场景中找不到 Mesh #${last.meshId}`);
      return;
    }
    const m = new THREE.Matrix4();
    m.fromArray(last.before as any);
    obj.matrix.copy(m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
    meshObjRef.current = obj;
    setActiveMeshId(last.meshId);
    setMatrixValues(obj.matrix.toArray());
    if (transformRef.current) transformRef.current.attach(obj);
    redoStackRef.current.push(last);
    setStatus(`已回退 Mesh #${last.meshId} 上一步操作（可重做 ${redoStackRef.current.length} 步）`);
  }, []);

  const redoLastTransform = useCallback(() => {
    const hist = redoStackRef.current;
    if (!hist.length) {
      setStatus('没有可重做的操作');
      return;
    }
    const last = hist.pop()!;
    const obj = meshByIdRef.current.get(last.meshId) || null;
    if (!obj) {
      setStatus(`重做失败：场景中找不到 Mesh #${last.meshId}`);
      return;
    }
    const m = new THREE.Matrix4();
    m.fromArray(last.after as any);
    obj.matrix.copy(m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
    meshObjRef.current = obj;
    setActiveMeshId(last.meshId);
    setMatrixValues(obj.matrix.toArray());
    if (transformRef.current) transformRef.current.attach(obj);
    undoStackRef.current.push(last);
    setStatus(`已重做 Mesh #${last.meshId} 上一步操作（可回退 ${undoStackRef.current.length} 步）`);
  }, []);

  useEffect(() => {
    const entries = materialEntriesRef.current;
    if (!entries || entries.length === 0) return;
    for (const e of entries) {
      e.mesh.material = renderTextured ? e.textured : e.wire;
    }
  }, [renderTextured, visible]);

  useEffect(() => {
    if (!visible || !showMeshPicker || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        setMeshListLoading(true);
        const rows = await meshApi.getMeshes(projectId);
        if (!cancelled) setMeshList(rows || []);
      } catch {
        if (!cancelled) setMeshList([]);
      } finally {
        if (!cancelled) setMeshListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, showMeshPicker, projectId]);

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

  useEffect(() => {
    if (!visible || !hostRef.current || !projectId || !imageId) return;
    let cancelled = false;

    const host = hostRef.current;
    const width = Math.max(320, host.clientWidth || 640);
    const height = Math.max(240, host.clientHeight || 360);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);

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
          d?.modality === 'depth_raw' || String(d?.originalName || d?.filename || '').toLowerCase().endsWith('.npy'),
        );
        const intr = (depthRows || []).find((d: any) => d?.modality === 'intrinsics' || /intrinsics_/i.test(String(d?.originalName || d?.filename || '')));
        if (!npy?.url) throw new Error('未找到 depth_raw npy');
        if (!intr?.url) throw new Error('未找到 intrinsics json');

        const npyUrl = toAbsoluteUrl(npy.url) || npy.url;
        const intrUrl = toAbsoluteUrl(intr.url) || intr.url;

        const [npyBuf, intrJs] = await Promise.all([
          fetch(npyUrl).then((r) => r.arrayBuffer()),
          fetch(intrUrl).then((r) => r.json()),
        ]);

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
            const c = Math.min(1, Math.max(0, z / 250));
            colors.push(0.2 + 0.8 * c, 0.5 * (1 - c), 1 - c);
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
        const poseMeshIds = poses
          .map((p: any) => Number(p?.meshId ?? p?.mesh_id ?? p?.mesh?.id ?? 0))
          .filter((id: number) => Number.isFinite(id) && id > 0);
        const targetMeshIds = Array.from(
          new Set(
            [...poseMeshIds, ...(manualMeshIds || [])]
              .filter((id) => Number.isFinite(Number(id)) && Number(id) > 0)
              .map((id) => Number(id)),
          ),
        );
        if (targetMeshIds.length === 0) {
          setStatus('未找到 diffdope pose44，仅显示点云');
          renderLoop();
          return;
        }
        meshByIdRef.current.clear();
        undoStackRef.current = [];
        redoStackRef.current = [];
        const allMaterialEntries: Array<{ mesh: THREE.Mesh; textured: THREE.Material | THREE.Material[]; wire: THREE.Material }> = [];
        let lastObj: THREE.Object3D | null = null;
        let lastMeshSize = new THREE.Vector3(0, 0, 0);
        let lastActiveMeshId: number | null = null;

        for (const meshId of targetMeshIds) {
          const selectedPose =
            poses.find((p: any) => Number(p?.meshId ?? p?.mesh_id ?? p?.mesh?.id) === Number(meshId)) || null;
          const mesh = (meshes || []).find((m: any) => Number(m?.id) === Number(meshId));
          const meshUrlRaw = mesh?.url || (mesh as any)?.filePath || (mesh as any)?.file_path || null;
          if (!meshUrlRaw) continue;

          const loader = new OBJLoader();
          const meshUrl = toAbsoluteUrl(meshUrlRaw) || meshUrlRaw;
          let obj: THREE.Group;
          try {
            if (mesh?.assetDirUrl && Array.isArray(mesh.assets) && mesh.assets.some((a: string) => String(a).toLowerCase().endsWith('.mtl'))) {
              const mtlName = mesh.assets.find((a: string) => String(a).toLowerCase().endsWith('.mtl'))!;
              const mtlLoader = new MTLLoader();
              mtlLoader.setPath((toAbsoluteUrl(mesh.assetDirUrl) || mesh.assetDirUrl) + '/');
              const materials = await new Promise<any>((resolve, reject) => mtlLoader.load(mtlName, resolve, undefined, reject));
              materials.preload();
              loader.setMaterials(materials);
            }
          } catch (_) {}
          obj = await new Promise<THREE.Group>((resolve, reject) => loader.load(meshUrl, resolve, undefined, reject));
          (obj as any).userData = { ...(obj as any).userData, meshId: Number(meshId) };

          obj.traverse((c: any) => {
            if (c?.isMesh) {
              const wire = new THREE.MeshBasicMaterial({
                color: 0xff8a00,
                wireframe: true,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 1.0,
              });
              const textured = c.material;
              c.material = renderTextured ? textured : wire;
              c.renderOrder = 10;
              allMaterialEntries.push({ mesh: c as THREE.Mesh, textured, wire });
              pickTargets.push(c as THREE.Object3D);
              pickTargetToRoot.set((c as THREE.Object3D).uuid, obj);
            }
          });

          obj.scale.multiplyScalar(MESH_UNIT_TO_CM);
          obj.matrixAutoUpdate = true;
          if (Array.isArray(selectedPose?.diffdope?.pose44)) {
            const m = cvPoseToThree(selectedPose.diffdope.pose44);
            obj.matrix.copy(m);
            obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
            obj.scale.multiplyScalar(MESH_UNIT_TO_CM);
          }
          obj.updateMatrix();
          obj.updateMatrixWorld(true);
          scene.add(obj);
          meshByIdRef.current.set(Number(meshId), obj);
          selectableRoots.push(obj);

          const bb = new THREE.Box3().setFromObject(obj);
          const sz = new THREE.Vector3();
          bb.getSize(sz);
          lastObj = obj;
          lastMeshSize = sz;
          lastActiveMeshId = Number(meshId);
        }

        materialEntriesRef.current = allMaterialEntries;
        if (!lastObj) {
          setStatus('未找到可加载的 Mesh，仅显示点云');
          renderLoop();
          return;
        }
        setActiveMeshId(lastActiveMeshId);
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
            const before = dragStartMatrixRef.current;
            const after = objNow ? (objNow.matrix.toArray() as number[]) : null;
            if (Number.isFinite(mid) && mid > 0 && before && after && !matrixEquals(before, after)) {
              const stack = undoStackRef.current;
              stack.push({ meshId: mid, before: [...before], after: [...after] });
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
          transform.attach(root);
          meshObj = root;
          meshObjRef.current = root;
          const mid = Number((root as any)?.userData?.meshId ?? 0);
          if (Number.isFinite(mid) && mid > 0) setActiveMeshId(mid);
          setMatrixValues(root.matrix.toArray());
          setStatus(`已选中 Mesh #${Number.isFinite(mid) && mid > 0 ? mid : 'unknown'}（可拖拽编辑）`);
        };
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        setStatus(
          `点云场景就绪（单位: cm，W: 平移 / E或R: 旋转） | meshes=${targetMeshIds.length} | activeSize=(${lastMeshSize.x.toFixed(2)}, ${lastMeshSize.y.toFixed(2)}, ${lastMeshSize.z.toFixed(2)})`,
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
      if (!deleteBusy && (k === 'delete' || k === 'backspace') && !ev.repeat) {
        const target = ev.target as HTMLElement | null;
        const tag = String(target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (target as any)?.isContentEditable) return;

        const mid = Number((meshObjRef.current as any)?.userData?.meshId ?? 0);
        if (Number.isFinite(mid) && mid > 0 && imageId) {
          ev.preventDefault();
          ev.stopPropagation();
          (async () => {
            try {
              setDeleteBusy(true);
              const ok = window.confirm(`确定删除当前 Mesh 的 9D 标注（meshId=${mid}）并从场景移除？`);
              if (!ok) return;
              await pose9dApi.deletePose9D(imageId, mid);
              setManualMeshIds((prev) => (prev || []).filter((id) => Number(id) !== mid));
              setActiveMeshId(null);
              setMatrixValues(identity16());
              setStatus(`已删除 Mesh #${mid} 的 9D 标注`);
              setSceneRefreshId((v) => v + 1);
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
      meshByIdRef.current.clear();
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
  }, [visible, projectId, imageId, manualMeshIds, sceneRefreshId, deleteBusy, undoLastTransform, redoLastTransform]);

  const saveCurrentPose44 = async () => {
    if (!imageId || !activeMeshId || saveBusy) return;
    try {
      setSaveBusy(true);
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
      await pose9dApi.saveDiffdopePose44(imageId, activeMeshId, cv);
      setStatus('pose44 已保存到数据库');
    } catch (e: any) {
      setStatus(e?.response?.data?.message || e?.message || '保存失败');
    } finally {
      setSaveBusy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    if (!saveRequestId) return;
    saveCurrentPose44();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveRequestId, visible]);

  if (!visible) return null;
  return (
    <div className="pose-pointcloud-overlay">
      <div className="pose-pointcloud-toolbar">
        <button
          type="button"
          className="pose-pointcloud-title pose-pointcloud-title-btn"
          onClick={() => setShowMeshPicker(true)}
          title="选择 Mesh 加入场景"
        >
          添加 Mesh
        </button>
        <div className="pose-pointcloud-meta">
          模式：{mode === 'translate' ? '平移(W)' : '旋转(E/R)'} ｜ 输出：Matrix4
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
      {showMeshPicker && (
        <div className="pose-pointcloud-picker-backdrop" onClick={() => setShowMeshPicker(false)}>
          <div className="pose-pointcloud-picker" onClick={(e) => e.stopPropagation()}>
            <div className="pose-pointcloud-picker-title">选择要加入场景的 Mesh</div>
            <div className="pose-pointcloud-picker-list">
              {meshListLoading && <div className="pose-pointcloud-picker-item">加载中...</div>}
              {!meshListLoading && meshList.length === 0 && <div className="pose-pointcloud-picker-item">暂无可用 Mesh</div>}
              {!meshListLoading &&
                meshList.map((m: any) => (
                  <button
                    type="button"
                    key={String(m?.id ?? m?.url)}
                    className="pose-pointcloud-picker-item-btn"
                    onClick={() => {
                      const id = Number(m?.id);
                      if (!Number.isFinite(id)) return;
                      setManualMeshIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                      setShowMeshPicker(false);
                      setStatus('已选择 Mesh，正在载入场景...');
                    }}
                  >
                    {String(m?.skuLabel || m?.originalName || m?.filename || `mesh-${m?.id}`)}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
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

