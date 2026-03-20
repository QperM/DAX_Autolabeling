import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { createAxisGizmo } from "./AxisGizmo";
import { toAbsoluteUrl } from "../utils/urls";

interface MeshPreview3DProps {
  meshUrl: string | null;
  assetDirUrl?: string;
  assets?: string[];
  /** 是否加载贴图（调试用，可以关闭看几何） */
  enableTexture?: boolean;
  /** 是否显示右上角坐标轴指示器 */
  showAxisGizmo?: boolean;
  /** mesh 原始 bounding box 尺寸（OBJ 坐标系单位） */
  onMeshBoundsChange?: (size: { x: number; y: number; z: number } | null) => void;
}

const MeshPreview3D: React.FC<MeshPreview3DProps> = ({
  meshUrl,
  assetDirUrl,
  assets,
  enableTexture = true,
  showAxisGizmo = true,
  onMeshBoundsChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onMeshBoundsChangeRef = useRef<MeshPreview3DProps["onMeshBoundsChange"]>(onMeshBoundsChange);

  useEffect(() => {
    onMeshBoundsChangeRef.current = onMeshBoundsChange;
  }, [onMeshBoundsChange]);

  useEffect(() => {
    if (!containerRef.current || !meshUrl) return;

    const container = containerRef.current;
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 220;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 1.5, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.autoClear = false; // 允许后面再渲染 gizmo
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const grid = new THREE.GridHelper(4, 8, 0x4b5563, 0x1f2937);
    grid.position.y = -0.5;
    scene.add(grid);

    // ---- 右上角轴向指示 gizmo（只做视觉语义：X 前 / Y 右 / Z 上） ----
    const { gizmoScene, gizmoCamera, gizmoRoot } = createAxisGizmo();

    let meshGroup: THREE.Group | null = null;

    const baseDir =
      assetDirUrl && assetDirUrl.startsWith("http")
        ? assetDirUrl
        : meshUrl.includes("/")
          ? meshUrl.slice(0, meshUrl.lastIndexOf("/") + 1)
          : meshUrl;

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url: string) => {
      if (!url) return url;
      if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
      const clean = String(url).replace(/\\/g, "/");

      const tryPickExisting = (raw: string) => {
        if (!assets || assets.length === 0) return raw;
        const base = raw.split("/").filter(Boolean).pop() || raw;
        const lower = base.toLowerCase();
        const hit = assets.find((a) => (a || "").toLowerCase() === lower);
        return hit || raw;
      };
      const normalized = tryPickExisting(clean);
      const encoded2 = normalized
        .split("/")
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return `${baseDir}${encoded2}`;
    });

    const loadText = async (url: string) => {
      // 防止拿到相对路径时被 Vite dev server 吞掉返回 index.html
      const abs = (toAbsoluteUrl(url) || url) as string;
      const resp = await fetch(abs, { credentials: "include" });
      if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
      return await resp.text();
    };

    const parseMtlName = (objText: string) => {
      const lines = objText.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (t.toLowerCase().startsWith("mtllib ")) return t.slice(7).trim();
      }
      return null;
    };

    const pickMtlCandidate = (mtl: string | null, assetList?: string[]) => {
      if (!mtl) return null;
      if (!assetList || assetList.length === 0) return null;
      const onlyMtl = assetList.filter((a) => a.toLowerCase().endsWith(".mtl"));
      if (!onlyMtl.length) return null;
      const exact = onlyMtl.find((a) => a.toLowerCase() === mtl.toLowerCase());
      if (exact) return exact;
      const stem = mtl.replace(/\.mtl$/i, "").toLowerCase();
      return onlyMtl.find((a) => a.toLowerCase().includes(stem)) || null;
    };

    const fitToView = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);

      onMeshBoundsChangeRef.current?.({ x: size.x, y: size.y, z: size.z });
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 1.5 / maxDim;
      obj.scale.setScalar(scale);

      const center = new THREE.Vector3();
      box.getCenter(center);
      obj.position.sub(center);
    };

    (async () => {
      try {
        const objText = await loadText(meshUrl);
        const mtlName = parseMtlName(objText);

        const objLoader = new OBJLoader(manager);
        const mtlToLoad = pickMtlCandidate(mtlName, assets);
        if (enableTexture && mtlToLoad) {
          const mtlLoader = new MTLLoader(manager);
          mtlLoader.setPath(baseDir);
          mtlLoader.setResourcePath(baseDir);
          const materials = await new Promise<any>((resolve, reject) => {
            mtlLoader.load(mtlToLoad, resolve, undefined, reject);
          });
          materials.preload();
          objLoader.setMaterials(materials);
        }

        const obj = objLoader.parse(objText);
        meshGroup = obj;

        obj.traverse((child: THREE.Object3D) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const origMat = mesh.material as any;
            const toBasic = (mat: any) => {
              if (!mat) return new THREE.MeshBasicMaterial({ color: 0xd1d5db });
              const map = mat.map as THREE.Texture | undefined;
              if (map) return new THREE.MeshBasicMaterial({ map });
              const color = (mat.color && (mat.color as THREE.Color).getHex()) || 0xd1d5db;
              return new THREE.MeshBasicMaterial({ color });
            };
            if (Array.isArray(origMat)) {
              mesh.material = origMat.map((m) => toBasic(m));
            } else {
              mesh.material = toBasic(origMat);
            }
          }
        });

        fitToView(obj);
        scene.add(obj);
      } catch (err) {
        console.error("[MeshPreview3D] OBJ/MTL 加载失败:", meshUrl, err);
        onMeshBoundsChangeRef.current?.(null);
      }
    })();

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();

      renderer.setScissorTest(false);
      renderer.clear();
      renderer.render(scene, camera);

      if (showAxisGizmo) {
        gizmoRoot.quaternion.copy(camera.quaternion).invert();

        const size = renderer.getSize(new THREE.Vector2());
        const pad = 22;
        const s = Math.max(88, Math.min(160, Math.floor(Math.min(size.x, size.y) * 0.22)));
        const x = Math.floor(size.x - s - pad);
        const y = Math.floor(size.y - s - pad);

        renderer.setScissorTest(true);
        renderer.setViewport(x, y, s, s);
        renderer.setScissor(x, y, s, s);
        renderer.clearDepth();
        renderer.render(gizmoScene, gizmoCamera);
        renderer.setViewport(0, 0, size.x, size.y);
        renderer.setScissorTest(false);
      }
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth || width;
      const h = containerRef.current.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(frameId);
      controls.dispose();
      renderer.dispose();
      onMeshBoundsChangeRef.current?.(null);
      if (meshGroup) {
        scene.remove(meshGroup);
      }
      gizmoRoot.traverse((obj: any) => {
        if (obj?.isMesh) {
          obj.geometry?.dispose?.();
          obj.material?.dispose?.();
        }
        if (obj?.isSprite) {
          const mat = obj.material as THREE.SpriteMaterial;
          const map = mat.map as THREE.Texture | null;
          map?.dispose?.();
          mat.dispose();
        }
      });
      container.innerHTML = "";
    };
  }, [meshUrl, assetDirUrl, assets, enableTexture, showAxisGizmo]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};

export default MeshPreview3D;

