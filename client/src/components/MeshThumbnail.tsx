import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

type MeshThumbnailProps = {
  meshUrl: string | null;
  label: string;
  assetDirUrl?: string;
  assets?: string[];
  width?: number;
  height?: number;
  /**
   * 取景偏移（以模型高度为单位）。负值会让相机“看向更低的位置”，
   * 从而让模型在缩略图里整体上移（更容易看到下半身）。
   */
  viewTargetYOffset?: number;
  /**
   * 取景距离倍率：值越大，相机越远，模型在缩略图里显示得越完整。
   * 一般 1.2~1.6 之间调节。
   */
  viewDistanceMultiplier?: number;
  onClick?: () => void;
};

// 简单的内存级缓存：避免列表滚动/切换时反复生成
const thumbnailCache = new Map<string, string>(); // meshUrl -> dataUrl

async function renderObjToDataUrl(
  meshUrl: string,
  width: number,
  height: number,
  assetDirUrl?: string,
  assets?: string[],
  viewTargetYOffset: number = -0.15,
  viewDistanceMultiplier: number = 1.35,
): Promise<string> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020617);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  // camera 位置会在加载模型后根据 bounding box 自适配
  camera.position.set(0, 1.2, 2.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);

  // 预览使用“无光”风格：材质统一转为 MeshBasicMaterial，保证贴图明亮清晰

  const baseDir =
    assetDirUrl && assetDirUrl.startsWith('http')
      ? assetDirUrl
      : meshUrl.includes('/')
        ? meshUrl.slice(0, meshUrl.lastIndexOf('/') + 1)
        : meshUrl;
  const manager = new THREE.LoadingManager();
  // 等待所有由 OBJ/MTL 触发的贴图资源加载完成，再渲染缩略图
  const waitForResources = new Promise<void>((resolve) => {
    manager.onLoad = () => resolve();
    manager.onError = () => resolve();
  });
  manager.setURLModifier((url: string) => {
    if (!url) return url;
    if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
    const clean = String(url).replace(/\\/g, '/');

    // 尝试用服务器返回的 assets 做一次大小写不敏感的纠正（Docker/Linux 上文件名大小写敏感）
    const tryPickExisting = (raw: string) => {
      if (!assets || assets.length === 0) return raw;
      const base = raw.split('/').filter(Boolean).pop() || raw;
      const lower = base.toLowerCase();
      const hit = assets.find((a) => (a || '').toLowerCase() === lower);
      return hit || raw;
    };
    const normalized = tryPickExisting(clean);
    const encoded = clean
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const encoded2 = normalized
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${baseDir}${encoded2 || encoded}`;
  });

  const resp = await fetch(meshUrl, { credentials: 'include' });
  if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
  const objText = await resp.text();

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
    // 目录里没有任何 .mtl 时直接跳过 MTL 加载，避免反复 404
    if (!assetList || assetList.length === 0) return null;
    const onlyMtl = assetList.filter((a) => a.toLowerCase().endsWith('.mtl'));
    if (onlyMtl.length === 0) return null;
    const exact = onlyMtl.find((a) => a.toLowerCase() === mtl.toLowerCase());
    if (exact) return exact;
    const stem = mtl.replace(/\.mtl$/i, '').toLowerCase();
    const fuzzy = onlyMtl.find((a) => a.toLowerCase().includes(stem));
    return fuzzy || null;
  };
  const mtlToLoad = pickMtlCandidate(mtlName, assets);
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

  const obj = objLoader.parse(objText);

  // 等待贴图等资源通过 LoadingManager 加载完成，再统一做“无光材质 + 取景”
  await waitForResources;

  // center + scale
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.6 / maxDim;
  obj.scale.setScalar(scale);
  const center = new THREE.Vector3();
  box.getCenter(center);
  obj.position.sub(center);

  // 将所有 Mesh 材质转为 MeshBasicMaterial：
  // - 若原材质有贴图，则沿用 map；
  // - 否则使用中性灰色，避免全黑/全白。
  obj.traverse((child: THREE.Object3D) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const origMat = mesh.material as any;
      const toBasic = (mat: any) => {
        if (!mat) return new THREE.MeshBasicMaterial({ color: 0xd1d5db });
        const map = mat.map as THREE.Texture | undefined;
        if (map) {
          return new THREE.MeshBasicMaterial({ map });
        }
        const rawColor = (mat.color && (mat.color as THREE.Color).getHex()) || 0xd1d5db;
        // 避免全黑/极暗材质导致缩略图“一片黑”，做一个下限保护
        const safeColor = rawColor === 0x000000 || rawColor <= 0x222222 ? 0xd1d5db : rawColor;
        return new THREE.MeshBasicMaterial({ color: safeColor });
      };
      if (Array.isArray(origMat)) {
        mesh.material = origMat.map((m) => toBasic(m));
      } else {
        mesh.material = toBasic(origMat);
      }
    }
  });

  scene.add(obj);

  // 基于缩放/居中后的 bounding box 做自适配取景，保证缩略图稳定居中
  const fitBox = new THREE.Box3().setFromObject(obj);
  const fitSize = new THREE.Vector3();
  fitBox.getSize(fitSize);

  // 以模型高度为基准做一点 target 偏移：负值 => 视线更低 => 模型在画面中更靠上
  const target = new THREE.Vector3(0, fitSize.y * viewTargetYOffset, 0);

  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = (fitSize.y / 2) / Math.tan(fov / 2);
  const fitWidthDistance = (fitSize.x / 2) / (Math.tan(fov / 2) * camera.aspect);
  const baseDistance = Math.max(fitHeightDistance, fitWidthDistance) + fitSize.z * 0.25;
  const distance = Math.max(0.01, viewDistanceMultiplier) * baseDistance;

  camera.position.set(0, fitSize.y * 0.15, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');

  // dispose
  renderer.dispose();
  scene.clear();
  return dataUrl;
}

const MeshThumbnail: React.FC<MeshThumbnailProps> = ({
  meshUrl,
  label,
  assetDirUrl,
  assets,
  width = 156,
  height = 125,
  viewTargetYOffset = -0.15,
  viewDistanceMultiplier = 1.35,
  onClick,
}) => {
  const [thumb, setThumb] = useState<string | null>(null);
  const key = useMemo(
    () =>
      meshUrl
        ? `${meshUrl}::${width}x${height}::ty=${viewTargetYOffset}::d=${viewDistanceMultiplier}`
        : '',
    [meshUrl, width, height, viewTargetYOffset, viewDistanceMultiplier],
  );

  useEffect(() => {
    let cancelled = false;
    if (!meshUrl) {
      setThumb(null);
      return;
    }

    const cached = thumbnailCache.get(key);
    if (cached) {
      setThumb(cached);
      return;
    }

    // 生成缩略图（静态 1 帧），避免列表中每项都跑一个动画 loop
    (async () => {
      try {
        const dataUrl = await renderObjToDataUrl(
          meshUrl,
          width,
          height,
          assetDirUrl,
          assets,
          viewTargetYOffset,
          viewDistanceMultiplier,
        );
        if (cancelled) return;
        thumbnailCache.set(key, dataUrl);
        setThumb(dataUrl);
      } catch (e) {
        console.warn('[MeshThumbnail] 生成缩略图失败:', meshUrl, e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meshUrl, key, width, height, viewTargetYOffset, assetDirUrl, assets]);

  return (
    <div
      style={{ position: 'absolute', inset: 0, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
      title={label}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={label}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
          draggable={false}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#e5e7eb',
            background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.12), transparent), #020617',
            fontSize: '0.9rem',
          }}
        >
          🧊
        </div>
      )}
    </div>
  );
};

export default MeshThumbnail;

