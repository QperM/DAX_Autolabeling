import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export type MeshInfo = {
  url: string;
  assetDirUrl?: string;
  assets?: string[];
};

export type TransformValues = {
  position: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
};

type Refs = {
  rendererDom: HTMLCanvasElement | null;
  camera: THREE.PerspectiveCamera | null;
  scene: THREE.Scene | null;
  meshRoot: THREE.Object3D | null;
  transformControls: TransformControls | null;
  /** 场景长度单位：mm 会对 mesh 做 1000x 基准缩放以匹配点云 */
  unit?: "mm" | "m";
  meshes: MeshInfo[];
  selectedMeshUrl: string | null;
  meshTransformsByUrl: Record<string, TransformValues>;
  transformMode: "translate" | "rotate";
  onSelectMeshUrl?: (meshUrl: string | null) => void;
  onTransformModeChange?: (mode: "translate" | "rotate") => void;
  onTransformValuesChange?: (meshUrl: string, values: TransformValues) => void;
  onMeshBoundsChange?: (info: { originalSize: { x: number; y: number; z: number } } | null) => void;
  onMeshBaseInfo?: (meshUrl: string, base: { originalSize: { x: number; y: number; z: number }; fitScale: number }) => void;
};

function findMeshUrlFromObject(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  for (let i = 0; i < 12 && cur; i++) {
    const u = (cur as any).userData?.meshUrl;
    if (typeof u === "string" && u) return u;
    cur = cur.parent;
  }
  return null;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child: any) => {
    if (!child) return;
    if (child.isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m?.dispose?.());
        else (mesh.material as any)?.dispose?.();
      }
    }
  });
}

export function usePointCloudMeshInteraction(refs: Refs) {
  const {
    rendererDom,
    camera,
    scene,
    meshRoot,
    transformControls,
    unit = "m",
    meshes,
    selectedMeshUrl,
    meshTransformsByUrl,
    transformMode,
    onSelectMeshUrl,
    onTransformModeChange,
    onTransformValuesChange,
    onMeshBoundsChange,
    onMeshBaseInfo,
  } = refs;

  const loadedMeshesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const UNIT_SCALE = useMemo(() => (unit === "mm" ? 1000 : 1), [unit]);

  const eulerDegToMat3_RzRyRx = (deg: { x: number; y: number; z: number }) => {
    const rx = THREE.MathUtils.degToRad(Number(deg?.x ?? 0));
    const ry = THREE.MathUtils.degToRad(Number(deg?.y ?? 0));
    const rz = THREE.MathUtils.degToRad(Number(deg?.z ?? 0));
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rz * Ry * Rx
    const r00 = cz * cy;
    const r01 = cz * sy * sx - sz * cx;
    const r02 = cz * sy * cx + sz * sx;
    const r10 = sz * cy;
    const r11 = sz * sy * sx + cz * cx;
    const r12 = sz * sy * cx - cz * sx;
    const r20 = -sy;
    const r21 = cy * sx;
    const r22 = cy * cx;
    return new THREE.Matrix3().set(r00, r01, r02, r10, r11, r12, r20, r21, r22);
  };

  const mat3ToEulerDeg_RzRyRx = (m: THREE.Matrix3) => {
    const e = m.elements; // column-major in three.js Matrix3
    const r00 = e[0], r01 = e[3];
    const r10 = e[1], r11 = e[4];
    const r20 = e[2], r21 = e[5], r22 = e[8];
    const sy = -r20;
    const cy = Math.sqrt(Math.max(0, 1 - sy * sy));
    let x = 0, y = 0, z = 0;
    if (cy > 1e-6) {
      x = Math.atan2(r21, r22);
      y = Math.asin(sy);
      z = Math.atan2(r10, r00);
    } else {
      x = Math.atan2(-r01, r11);
      y = Math.asin(sy);
      z = 0;
    }
    const wrap = (deg: number) => {
      let d = deg;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    };
    return { x: wrap(THREE.MathUtils.radToDeg(x)), y: wrap(THREE.MathUtils.radToDeg(y)), z: wrap(THREE.MathUtils.radToDeg(z)) };
  };

  const applyPoseToObject = (obj: THREE.Object3D, vals: TransformValues | null) => {
    if (!vals) return;
    const px = Number(vals.position?.x ?? 0);
    const py = Number(vals.position?.y ?? 0);
    const pz = Number(vals.position?.z ?? 0);
    if ([px, py, pz].every((v) => Number.isFinite(v))) {
      // Directly use current scene coordinate system.
      obj.position.set(px, py, pz);
    }

    const rot = vals.rotationDeg || { x: 0, y: 0, z: 0 };
    const R = eulerDegToMat3_RzRyRx(rot);
    const m4 = new THREE.Matrix4();
    m4.set(
      R.elements[0], R.elements[3], R.elements[6], 0,
      R.elements[1], R.elements[4], R.elements[7], 0,
      R.elements[2], R.elements[5], R.elements[8], 0,
      0, 0, 0, 1,
    );
    obj.setRotationFromMatrix(m4);

    const sx = Number(vals.scale?.x ?? 1);
    const sy = Number(vals.scale?.y ?? 1);
    const sz = Number(vals.scale?.z ?? 1);
    if ([sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)) {
      // Mesh 基准单位通常是“米级”；当点云切到 mm 时，需要把 mesh 基准放大 1000x 才能在同一场景里可见
      obj.scale.set(sx * UNIT_SCALE, sy * UNIT_SCALE, sz * UNIT_SCALE);
    }
  };

  const readPoseFromObject = (obj: THREE.Object3D): TransformValues => {
    const p = obj.position;
    const position = { x: p.x, y: p.y, z: p.z };
    const m4 = new THREE.Matrix4().extractRotation(obj.matrixWorld);
    const m3 = new THREE.Matrix3().setFromMatrix4(m4);
    const rotationDeg = mat3ToEulerDeg_RzRyRx(m3);
    const s = obj.scale;
    const scale = { x: s.x / UNIT_SCALE, y: s.y / UNIT_SCALE, z: s.z / UNIT_SCALE };
    return { position, rotationDeg, scale };
  };

  // Mesh load/unload
  useEffect(() => {
    if (!scene || !meshRoot) return;
    const wanted = new Set((meshes || []).map((m) => m.url).filter(Boolean));
    for (const [url, obj] of loadedMeshesRef.current.entries()) {
      if (!wanted.has(url)) {
        meshRoot.remove(obj);
        disposeObject(obj);
        loadedMeshesRef.current.delete(url);
      }
    }

    let cancelled = false;
    const loadOne = async (m: MeshInfo) => {
      const url = m?.url;
      if (!url || loadedMeshesRef.current.has(url)) return;
      const assetDir = m.assetDirUrl || "";
      const assets = Array.isArray(m.assets) ? m.assets : [];
      const mtlName = assets.find((a) => /\.mtl$/i.test(a)) || null;

      const objLoader = new OBJLoader();
      const maybeAttach = (obj: THREE.Object3D) => {
        if (cancelled) {
          disposeObject(obj);
          return;
        }
        obj.name = `mesh:${url}`;
        (obj as any).userData = { ...(obj as any).userData, meshUrl: url };
        loadedMeshesRef.current.set(url, obj);
        meshRoot.add(obj);
        applyPoseToObject(obj, meshTransformsByUrl?.[url] || null);

        // Report base size (useful for UI/debug)
        try {
          const box = new THREE.Box3().setFromObject(obj);
          const size = new THREE.Vector3();
          box.getSize(size);
          const base = { originalSize: { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) }, fitScale: 1 };
          onMeshBaseInfo?.(url, base);
        } catch {}
      };

      try {
        if (assetDir && mtlName) {
          const mtlUrl = `${assetDir.replace(/\/$/, "")}/${encodeURIComponent(mtlName)}`;
          const mtlLoader = new MTLLoader();
          mtlLoader.setResourcePath(assetDir.replace(/\/$/, "") + "/");
          mtlLoader.load(
            mtlUrl,
            (materials) => {
              try {
                materials.preload();
                objLoader.setMaterials(materials);
              } catch {}
              objLoader.load(url, (obj) => maybeAttach(obj), undefined, () => {});
            },
            undefined,
            () => {
              objLoader.load(url, (obj) => maybeAttach(obj), undefined, () => {});
            },
          );
        } else {
          objLoader.load(url, (obj) => maybeAttach(obj), undefined, () => {});
        }
      } catch {
        // ignore
      }
    };

    (async () => {
      for (const m of meshes || []) {
        if (cancelled) break;
        await loadOne(m);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scene, meshRoot, JSON.stringify((meshes || []).map((m) => [m.url, m.assetDirUrl, ...(m.assets || [])]))]);

  // Apply transforms when state changes
  useEffect(() => {
    for (const m of meshes || []) {
      const url = m?.url;
      if (!url) continue;
      const obj = loadedMeshesRef.current.get(url);
      if (!obj) continue;
      applyPoseToObject(obj, meshTransformsByUrl?.[url] || null);
    }
  }, [JSON.stringify(meshTransformsByUrl), JSON.stringify((meshes || []).map((m) => m.url))]);

  // Attach transform controls to selected mesh
  useEffect(() => {
    if (!transformControls) return;
    transformControls.setMode(transformMode);
    const obj = selectedMeshUrl ? loadedMeshesRef.current.get(selectedMeshUrl) : null;
    if (!obj) {
      transformControls.detach();
      return;
    }
    transformControls.attach(obj);
    return () => {
      try {
        transformControls.detach();
      } catch {}
    };
  }, [transformControls, transformMode, selectedMeshUrl]);

  // Propagate transform changes back to parent
  useEffect(() => {
    if (!transformControls) return;
    const onChange = () => {
      const obj = transformControls.object;
      if (!obj) return;
      const url = selectedMeshUrl;
      if (!url) return;
      const vals = readPoseFromObject(obj);
      onTransformValuesChange?.(url, vals);
      try {
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3();
        box.getSize(size);
        onMeshBoundsChange?.({ originalSize: { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) } });
      } catch {}
    };
    transformControls.addEventListener("change", onChange);
    return () => {
      transformControls.removeEventListener("change", onChange);
    };
  }, [transformControls, selectedMeshUrl, onTransformValuesChange, onMeshBoundsChange]);

  // Click to select mesh
  useEffect(() => {
    if (!rendererDom || !camera || !meshRoot) return;

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const onPointerDown = (ev: PointerEvent) => {
      // Left click only
      if (ev.button !== 0) return;

      // If we're dragging a transform gizmo, skip selection
      try {
        if ((transformControls as any)?.dragging) return;
      } catch {}

      const rect = rendererDom.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      ndc.set(x * 2 - 1, -(y * 2 - 1));

      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(meshRoot, true);
      if (!hits.length) {
        // 点击空白处：取消选中（并由外层触发 TransformControls.detach）
        onSelectMeshUrl?.(null);
        return;
      }

      const url = findMeshUrlFromObject(hits[0].object);
      if (!url) {
        onSelectMeshUrl?.(null);
        return;
      }
      onSelectMeshUrl?.(url);
    };

    rendererDom.addEventListener("pointerdown", onPointerDown);
    return () => {
      rendererDom.removeEventListener("pointerdown", onPointerDown);
    };
  }, [rendererDom, camera, meshRoot, transformControls, onSelectMeshUrl]);

  // Keyboard shortcuts:
  // - W: translate (location)
  // - E: rotate
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const t = ev.target as any;
      const tag = String(t?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;

      const k = String(ev.key || "").toLowerCase();
      if (k === "w") {
        ev.preventDefault();
        onTransformModeChange?.("translate");
        return;
      }
      if (k === "e") {
        ev.preventDefault();
        onTransformModeChange?.("rotate");
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown as any);
  }, [onTransformModeChange]);
}

