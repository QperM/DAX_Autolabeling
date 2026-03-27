import React from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { toAbsoluteUrl } from "../../utils/urls";

type Props = {
  meshUrl: string | null;
  label?: string;
  assetDirUrl?: string;
  assets?: string[];
  /** 为 false 时不显示缩略图下方的文字条（如对照表弹窗内仅保留图片格） */
  showBottomLabel?: boolean;
};

const MeshThumbnail: React.FC<Props> = ({ meshUrl, label, assetDirUrl, assets, showBottomLabel = true }) => {
  const [snapshotUrl, setSnapshotUrl] = React.useState<string | null>(null);
  const lastSnapshotUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!meshUrl) return;
    setSnapshotUrl(null);

    // 每次生成新的 snapshot 前，释放上一次的 data url 引用（避免堆内存）
    if (lastSnapshotUrlRef.current) {
      lastSnapshotUrlRef.current = null;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#020617");

    const size = 160; // 缩略图固定分辨率，性能可控
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 0, 2);

    const group = new THREE.Group();
    scene.add(group);

    const absMeshUrl = toAbsoluteUrl(meshUrl) || meshUrl;
    const baseDir =
      assetDirUrl && assetDirUrl.startsWith("http")
        ? assetDirUrl
        : absMeshUrl.includes("/")
          ? absMeshUrl.slice(0, absMeshUrl.lastIndexOf("/") + 1)
          : absMeshUrl;
    const absBaseDir = toAbsoluteUrl(baseDir) || baseDir;

    const manager = new THREE.LoadingManager();
    // 等贴图/材质加载完成后再截图（否则容易截到纯黑）
    let resolveAll: (() => void) | null = null;
    const allLoaded = new Promise<void>((resolve, reject) => {
      resolveAll = resolve;
      void reject;
    });
    manager.onLoad = () => resolveAll?.();
    manager.onError = (url) => {
      // 单个资源失败不一定致命：让流程继续，后面会回退到无贴图材质
      console.warn("[MeshThumbnail] resource load error:", url);
    };
    manager.setURLModifier((url: string) => {
      if (!url) return url;
      if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
      const clean = String(url).replace(/\\/g, "/");
      if (!assets || assets.length === 0) return `${absBaseDir}${clean}`;
      const base = clean.split("/").filter(Boolean).pop() || clean;
      const lower = base.toLowerCase();
      const hit = assets.find((a) => (a || "").toLowerCase() === lower);
      const finalName = hit || clean;
      const encoded = finalName
        .split("/")
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return `${absBaseDir}${encoded}`;
    });

    const loadText = async (url: string) => {
      const abs = toAbsoluteUrl(url) || url;
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
      if (!assetList || assetList.length === 0) return mtl;
      const onlyMtl = assetList.filter((a) => a.toLowerCase().endsWith(".mtl"));
      if (!onlyMtl.length) return mtl;
      const exact = onlyMtl.find((a) => a.toLowerCase() === mtl.toLowerCase());
      if (exact) return exact;
      const stem = mtl.replace(/\.mtl$/i, "").toLowerCase();
      return onlyMtl.find((a) => a.toLowerCase().includes(stem)) || mtl;
    };

    const frameObject = (obj: THREE.Object3D) => {
      // 先把 bounding box 中心移到原点（避免“模型腰部当原点”导致下半身被裁切）
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const center = new THREE.Vector3();
      box.getCenter(center);
      obj.position.sub(center);
      obj.updateMatrixWorld(true);

      // 重新计算 bounds，并用 bounding sphere 来设置相机距离（保证完整入镜）
      const box2 = new THREE.Box3().setFromObject(obj);
      const sphere = new THREE.Sphere();
      box2.getBoundingSphere(sphere);
      const radius = Math.max(1e-6, sphere.radius || 1);

      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = (radius * 1.35) / Math.sin(fov / 2);
      camera.near = Math.max(0.01, dist / 100);
      camera.far = Math.max(50, dist * 10);
      // 稍微抬高一点视角，避免底部被边缘裁掉
      camera.position.set(0, radius * 0.15, dist);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    // 让带贴图的颜色更接近预期（避免发灰/发暗）
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    let stopped = false;
    (async () => {
      try {
        const objText = await loadText(absMeshUrl);
        if (stopped) return;

        const objLoader = new OBJLoader(manager);
        // 尽量加载 mtl + 贴图（如果存在）
        const mtlName = parseMtlName(objText);
        const mtlToLoad = pickMtlCandidate(mtlName, assets);
        if (mtlToLoad) {
          try {
            const mtlLoader = new MTLLoader(manager);
            mtlLoader.setPath(absBaseDir);
            mtlLoader.setResourcePath(absBaseDir);
            const materials = await new Promise<any>((resolve, reject) => {
              mtlLoader.load(mtlToLoad, resolve, undefined, reject);
            });
            materials.preload();
            objLoader.setMaterials(materials);
          } catch (e) {
            // mtl/贴图加载失败不阻塞：回退到纯几何渲染
            console.warn("[MeshThumbnail] MTL 加载失败，将回退为纯几何:", mtlToLoad, e);
          }
        }
        const obj = objLoader.parse(objText);

        // no-light 模式：统一使用 MeshBasicMaterial（有贴图就直接展示贴图，不依赖灯光）
        obj.traverse((child: THREE.Object3D) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mesh = child as THREE.Mesh;
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as any[];
          const firstMap = mats.find((m) => !!m?.map)?.map as THREE.Texture | undefined;
          if (firstMap) {
            firstMap.colorSpace = THREE.SRGBColorSpace;
            mesh.material = new THREE.MeshBasicMaterial({ map: firstMap });
          } else {
            const color = (mats[0] as any)?.color?.getHex?.() ?? 0xd1d5db;
            mesh.material = new THREE.MeshBasicMaterial({ color });
          }
        });

        frameObject(obj);
        group.add(obj);

        // 等待贴图/材质加载完成（或最多等 3 秒兜底），再截图
        await Promise.race([
          allLoaded,
          new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
        ]);
        if (stopped) return;

        // 多渲染几帧，确保贴图完成上传到 GPU
        for (let i = 0; i < 3; i++) {
          renderer.render(scene, camera);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (stopped) return;
        }
        const dataUrl = renderer.domElement.toDataURL("image/png");
        if (!stopped) {
          lastSnapshotUrlRef.current = dataUrl;
          setSnapshotUrl(dataUrl);
        }
      } catch (e) {
        console.warn("[MeshThumbnail] 加载缩略 Mesh 失败:", meshUrl, e);
      }
    })();

    return () => {
      stopped = true;
      // 释放 three 资源，缩略图用静态 snapshot
      try {
        group.traverse((child: any) => {
          if (child?.isMesh) {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) child.material.forEach((m: any) => m?.dispose?.());
            else child.material?.dispose?.();
          }
        });
      } catch {
        // ignore
      }
      try {
        (renderer as any).forceContextLoss?.();
      } catch (_) {}
      renderer.dispose();
    };
  }, [meshUrl, assetDirUrl, assets]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: "stretch",
      }}
    >
      {snapshotUrl ? (
        <img
          src={snapshotUrl}
          alt={label || "mesh thumbnail"}
          style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
            fontSize: "0.8rem",
            background: "#020617",
            borderRadius: 8,
          }}
        >
          加载中…
        </div>
      )}
      {showBottomLabel && label && (
        <div
          style={{
            marginTop: 4,
            fontSize: "0.7rem",
            color: "#e5e7eb",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={label}
        >
          {label}
        </div>
      )}
    </div>
  );
};

export default MeshThumbnail;

