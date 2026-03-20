import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { usePointCloudMeshInteraction, type MeshInfo, type TransformValues } from "./PointCloudMeshInteraction";

function parseNpyToFloat32(
  buffer: ArrayBuffer
): { data: Float32Array; shape: number[]; dtype: "float32" | "uint16" } {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10 || bytes[0] !== 0x93) throw new Error("不是有效的 .npy 文件（magic 不匹配）");
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
  const headerText = new TextDecoder("latin1").decode(headerBytes);

  const descrMatch = headerText.match(/'descr'\s*:\s*'([^']+)'/);
  const fortranMatch = headerText.match(/'fortran_order'\s*:\s*(True|False)/);
  const shapeMatch = headerText.match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!descrMatch || !fortranMatch || !shapeMatch) throw new Error("解析 .npy header 失败");

  const descr = descrMatch[1];
  const fortranOrder = fortranMatch[1] === "True";
  if (fortranOrder) throw new Error("暂不支持 fortran_order=True 的 .npy");
  const supported = new Set(["<f4", "|f4", "<u2", "|u2"]);
  if (!supported.has(descr)) {
    throw new Error(`暂不支持的 dtype: ${descr}（目前仅支持 float32/uint16）`);
  }

  const shapeStr = shapeMatch[1].trim();
  const shape = shapeStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (shape.length < 2) throw new Error(`shape 解析失败: (${shapeStr})`);

  const dataOffset = headerStart + headerLen;

  const toAlignedOffset = (offset: number, align: number) => {
    if (align <= 1) return offset;
    const mod = offset % align;
    return mod === 0 ? offset : offset + (align - mod);
  };

  if (descr === "<f4" || descr === "|f4") {
    const off = toAlignedOffset(dataOffset, 4);
    const data = new Float32Array(buffer, off);
    return { data, shape, dtype: "float32" };
  }

  const off = toAlignedOffset(dataOffset, 2);
  const u16 = new Uint16Array(buffer, off);
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = u16[i];
  return { data: out, shape, dtype: "uint16" };
}

type MeshBoundsInfo = {
  originalSize: { x: number; y: number; z: number };
  sceneSize: { x: number; y: number; z: number };
  fitScale: number;
};

type Props = {
  npyUrl: string | null;
  depthScale?: number;
  stride?: number;
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
  /** 场景长度单位（仅影响点云坐标的缩放）。默认 mm，便于与深度原始数据一致 */
  unit?: "mm" | "m";
  meshes?: MeshInfo[] | null;
  selectedMesh?: MeshInfo | null;
  onSelectMeshUrl?: (meshUrl: string | null) => void;
  meshTransformsByUrl?: Record<string, TransformValues> | null;
  transformMode?: "translate" | "rotate";
  onTransformModeChange?: (mode: "translate" | "rotate") => void;
  onTransformValuesChange?: (meshUrl: string, values: TransformValues) => void;
  onMeshBoundsChange?: (info: MeshBoundsInfo | null) => void;
  onMeshBaseInfo?: (meshUrl: string, base: Pick<MeshBoundsInfo, "originalSize" | "fitScale">) => void;
  transformRequest?: (TransformValues & { id: number; meshUrl: string }) | null;
};

const PointCloudPreview3D: React.FC<Props> = ({
  npyUrl,
  depthScale = 1.0,
  stride = 2,
  intrinsics,
  unit = "mm",
  meshes: _meshes,
  selectedMesh: _selectedMesh,
  onSelectMeshUrl,
  meshTransformsByUrl: _meshTransformsByUrl,
  transformMode = "translate",
  onTransformModeChange,
  onTransformValuesChange,
  onMeshBoundsChange,
  onMeshBaseInfo,
  transformRequest: _transformRequest,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setThreeReadyTick] = useState(0);

  const intrKey = useMemo(() => {
    const fx = intrinsics?.fx ?? 0;
    const fy = intrinsics?.fy ?? 0;
    const cx = intrinsics?.cx ?? 0;
    const cy = intrinsics?.cy ?? 0;
    return `${fx}|${fy}|${cx}|${cy}`;
  }, [intrinsics?.fx, intrinsics?.fy, intrinsics?.cx, intrinsics?.cy]);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const rafRef = useRef<number>(0);

  const pointsRef = useRef<THREE.Points | null>(null);
  const lastNpyUrlRef = useRef<string | null>(null);
  const meshRootRef = useRef<THREE.Group | null>(null);

  const onMeshBoundsChangeRef = useRef<Props["onMeshBoundsChange"]>(onMeshBoundsChange);
  const onMeshBaseInfoRef = useRef<Props["onMeshBaseInfo"]>(onMeshBaseInfo);
  const onTransformValuesChangeRef = useRef<Props["onTransformValuesChange"]>(onTransformValuesChange);
  const onTransformModeChangeRef = useRef<Props["onTransformModeChange"]>(onTransformModeChange);
  const onSelectMeshUrlRef = useRef<Props["onSelectMeshUrl"]>(onSelectMeshUrl);

  useEffect(() => {
    onMeshBoundsChangeRef.current = onMeshBoundsChange;
  }, [onMeshBoundsChange]);
  useEffect(() => {
    onMeshBaseInfoRef.current = onMeshBaseInfo;
  }, [onMeshBaseInfo]);
  useEffect(() => {
    onTransformValuesChangeRef.current = onTransformValuesChange;
  }, [onTransformValuesChange]);
  useEffect(() => {
    onTransformModeChangeRef.current = onTransformModeChange;
  }, [onTransformModeChange]);
  useEffect(() => {
    onSelectMeshUrlRef.current = onSelectMeshUrl;
  }, [onSelectMeshUrl]);

  // 1) init three scene
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.innerHTML = "";
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#020617");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
    camera.position.set(0, 0, 2.2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.5;
    controls.panSpeed = 0.5;
    controlsRef.current = controls;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode(transformMode);
    transformControls.setSpace("local");
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    // Disable orbit controls while dragging transforms
    transformControls.addEventListener("dragging-changed", (e: any) => {
      try {
        controls.enabled = !e.value;
      } catch {}
    });

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(2, 2, 2);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const grid = new THREE.GridHelper(2, 10, 0x334155, 0x1f2937);
    (grid.material as any).opacity = 0.35;
    (grid.material as any).transparent = true;
    scene.add(grid);

    const meshRoot = new THREE.Group();
    meshRoot.name = "meshesRoot";
    scene.add(meshRoot);
    meshRootRef.current = meshRoot;
    // Make sure mesh interaction hook receives non-null refs (it depends on render-time values).
    setThreeReadyTick((v) => v + 1);

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      transformControls.update(0);
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const r = rendererRef.current;
      const c = cameraRef.current;
      if (!el || !r || !c) return;
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      r.setSize(w, h);
      c.aspect = w / h;
      c.updateProjectionMatrix();
    };
    onResize();
    const ro = new ResizeObserver(() => onResize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      controls.dispose();
      transformControls.dispose();
      const pts = pointsRef.current;
      if (pts) {
        (pts.geometry as THREE.BufferGeometry).dispose();
        (pts.material as THREE.Material).dispose();
      }
      pointsRef.current = null;
      scene.clear();
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      transformControlsRef.current = null;
      el.innerHTML = "";
      setThreeReadyTick((v) => v + 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) rebuild point cloud
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    setError(null);

    const prevPoints = pointsRef.current;
    // NOTE: 预留：未来可在同一 npyUrl 下复用相机视角

    if (prevPoints) {
      scene.remove(prevPoints);
      (prevPoints.geometry as THREE.BufferGeometry).dispose();
      (prevPoints.material as THREE.Material).dispose();
      pointsRef.current = null;
    }

    if (!npyUrl) return;

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(npyUrl, { credentials: "include", cache: "no-store" });
        if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
        const buf = await resp.arrayBuffer();
        if (cancelled) return;

        const { data, shape, dtype } = parseNpyToFloat32(buf);
        const h = shape[0];
        const w = shape[1];

        const safePos = (v: any) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : NaN;
        };
        const fx0 = safePos(intrinsics?.fx);
        const fy0 = safePos(intrinsics?.fy);
        const cx0 = safePos(intrinsics?.cx);
        const cy0 = safePos(intrinsics?.cy);

        const fx = Number.isFinite(fx0) && fx0 > 1e-9 ? fx0 : 500;
        const fy = Number.isFinite(fy0) && fy0 > 1e-9 ? fy0 : 500;
        const cx = Number.isFinite(cx0) ? cx0 : w / 2;
        const cy = Number.isFinite(cy0) ? cy0 : h / 2;

        const step = Math.max(1, Math.floor(stride));
        const estCount = Math.ceil(h / step) * Math.ceil(w / step);
        const positions = new Float32Array(estCount * 3);
        const colors = new Float32Array(estCount * 3);
        let k = 0;

        const dsRaw = dtype === "uint16" ? Number(depthScale) : 1.0;
        const ds = Number.isFinite(dsRaw) && dsRaw > 0 ? Math.min(1e3, Math.max(1e-9, dsRaw)) : 1.0;
        // 点云统一输出到指定单位：
        // - depthScale 通常是“每个 depth unit 对应的米数”（例如 0.001：mm->m）
        // - unit=mm 时：把 z(m) 转成 z(mm) => 乘 1000
        // - unit=m 时：保持米
        const unitScale = unit === "mm" ? 1000.0 : 1.0;

        let zMin = Number.POSITIVE_INFINITY;
        let zMax = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const z = data[y * w + x] * ds * unitScale;
            if (!Number.isFinite(z) || z <= 0) continue;
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
          }
        }
        if (!Number.isFinite(zMin) || zMax <= 0) throw new Error("深度数据为空或全为 0，无法生成点云");

        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const z = data[y * w + x] * ds * unitScale;
            if (!Number.isFinite(z) || z <= 0) continue;
            const X = ((x - cx) / fx) * z;
            const Y = -((y - cy) / fy) * z;
            const Z = -z;
            if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) continue;
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
        geom.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, k * 3), 3));
        geom.setAttribute("color", new THREE.BufferAttribute(colors.subarray(0, k * 3), 3));
        geom.computeBoundingSphere();

        const sphere = geom.boundingSphere;
        const radius = sphere?.radius ?? 1;
        const size = Math.max(0.0015, Math.min(0.02, radius / 300));

        const mat = new THREE.PointsMaterial({
          size,
          vertexColors: true,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          sizeAttenuation: true,
        });

        const pts = new THREE.Points(geom, mat);
        pts.renderOrder = 0;
        pointsRef.current = pts;
        scene.add(pts);

        if (sphere) {
          controls.target.copy(sphere.center);
          // 自动对焦距离：mm 场景下 radius 数值会大很多（例如 1500mm），用同样倍率会显得“离得太远”
          const distMul = unit === "mm" ? 1.05 : 2.2;
          const minDist = unit === "mm" ? 450 : 1.2;
          const dist = Math.max(minDist, radius * distMul);
          camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
          camera.near = 0.01;
          camera.far = Math.max(unit === "mm" ? 50000 : 50, radius * (unit === "mm" ? 40 : 30));
          camera.updateProjectionMatrix();
          controls.update();
        }

        lastNpyUrlRef.current = npyUrl;
      } catch (e: any) {
        console.error("[PointCloudPreview3D][rebuild] 点云构建失败:", e);
        setError(e?.message || "点云构建失败");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [npyUrl, depthScale, stride, intrKey, unit]);

  // === Mesh loading + rendering + interaction (delegated) ===
  const meshes = Array.isArray(_meshes) ? _meshes : [];
  const selectedMeshUrl = _selectedMesh?.url || null;
  const meshTransformsByUrl = (_meshTransformsByUrl || {}) as Record<string, TransformValues>;

  usePointCloudMeshInteraction({
    rendererDom: (rendererRef.current?.domElement as any) || null,
    camera: cameraRef.current,
    scene: sceneRef.current,
    meshRoot: meshRootRef.current,
    transformControls: transformControlsRef.current,
    unit,
    meshes,
    selectedMeshUrl,
    meshTransformsByUrl,
    transformMode,
    onSelectMeshUrl: onSelectMeshUrlRef.current || undefined,
    onTransformModeChange: onTransformModeChangeRef.current || undefined,
    onTransformValuesChange: onTransformValuesChangeRef.current || undefined,
    onMeshBaseInfo: (url, base) => onMeshBaseInfoRef.current?.(url, base),
    onMeshBoundsChange: (info) => {
      // Keep existing MeshBoundsInfo shape for callers
      if (!info) {
        onMeshBoundsChangeRef.current?.(null);
        return;
      }
      const s = info.originalSize;
      onMeshBoundsChangeRef.current?.({ originalSize: s, sceneSize: s, fitScale: 1 });
    },
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            color: "#e5e7eb",
            background: "rgba(2,6,23,0.72)",
            textAlign: "center",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default PointCloudPreview3D;

