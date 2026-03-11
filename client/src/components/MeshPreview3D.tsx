import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

interface MeshPreview3DProps {
  meshUrl: string | null;
  assetDirUrl?: string;
  assets?: string[];
}

const MeshPreview3D: React.FC<MeshPreview3DProps> = ({ meshUrl, assetDirUrl, assets }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(2, 4, 5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-3, 2, -4);
    scene.add(fillLight);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);

    const grid = new THREE.GridHelper(4, 8, 0x4b5563, 0x1f2937);
    grid.position.y = -0.5;
    scene.add(grid);

    let meshGroup: THREE.Group | null = null;

    const baseDir =
      assetDirUrl && assetDirUrl.startsWith('http')
        ? assetDirUrl
        : meshUrl.includes('/')
          ? meshUrl.slice(0, meshUrl.lastIndexOf('/') + 1)
          : meshUrl;

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url: string) => {
      // 将 OBJ/MTL 内的相对贴图路径重写到同目录（uploads/project_x/meshes/）下
      if (!url) return url;
      if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
      const clean = String(url).replace(/\\/g, '/');

      // 尝试用服务器返回的 assets 做一次大小写不敏感的纠正（Docker/Linux 上文件名大小写敏感）
      // 例如：MTL 里写 map_Kd BODY.PNG，但实际落盘是 body.png
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

    const loadText = async (url: string) => {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
      return await resp.text();
    };

    const parseMtlName = (objText: string) => {
      const lines = objText.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (t.toLowerCase().startsWith('mtllib ')) {
          return t.slice(7).trim();
        }
      }
      return null;
    };

    const pickMtlCandidate = (mtl: string | null, assetList?: string[]) => {
      if (!mtl) return null;
      // 如果服务器没返回任何资源文件，或者目录里根本没有 .mtl，就直接放弃加载 MTL，避免 404 噪音
      if (!assetList || assetList.length === 0) return null;
      const onlyMtl = assetList.filter((a) => a.toLowerCase().endsWith('.mtl'));
      if (onlyMtl.length === 0) return null;
      const exact = assetList.find((a) => a.toLowerCase() === mtl.toLowerCase());
      if (exact) return exact;
      const stem = mtl.replace(/\.mtl$/i, '').toLowerCase();
      const fuzzy = onlyMtl.find((a) => a.toLowerCase().includes(stem));
      return fuzzy || mtl;
    };

    const fitToView = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 1.5 / maxDim;
      obj.scale.setScalar(scale);

      const center = new THREE.Vector3();
      box.getCenter(center);
      obj.position.sub(center);
    };

    // 优先走 “OBJ(text) + MTL + 贴图” 链路；没有 mtllib 则退化为纯 OBJ
    (async () => {
      try {
        const objText = await loadText(meshUrl);
        const mtlName = parseMtlName(objText);

        const objLoader = new OBJLoader(manager);
        const mtlToLoad = pickMtlCandidate(mtlName, assets);
        if (mtlToLoad) {
          const mtlLoader = new MTLLoader(manager);
          mtlLoader.setPath(baseDir);
          // 让 MTL 内引用的贴图从同目录加载
          mtlLoader.setResourcePath(baseDir);
          const materials = await new Promise<any>((resolve, reject) => {
            mtlLoader.load(mtlToLoad, resolve, undefined, reject);
          });
          materials.preload();
          objLoader.setMaterials(materials);
        }

        const obj = objLoader.parse(objText);
        meshGroup = obj;

        // 如果 OBJ/MTL 没给材质，也别强行覆盖（覆盖会导致贴图丢失）
        // 仅补一个轻量的光照增强：让没有贴图的模型也更易看
        obj.traverse((child: THREE.Object3D) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (!mesh.material) {
              mesh.material = new THREE.MeshStandardMaterial({
                color: 0x4ade80,
                metalness: 0.2,
                roughness: 0.7,
              });
            }
          }
        });

        fitToView(obj);
        scene.add(obj);
      } catch (err) {
        console.error('[MeshPreview3D] OBJ/MTL 加载失败:', meshUrl, err);
      }
    })();

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
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

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
      controls.dispose();
      renderer.dispose();
      if (meshGroup) {
        scene.remove(meshGroup);
      }
      container.innerHTML = '';
    };
  }, [meshUrl, assetDirUrl, assets]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

export default MeshPreview3D;

