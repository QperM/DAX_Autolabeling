import React, { useEffect, useRef, useState } from 'react';
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

type Props = {
  npyUrl: string | null;
  /** 默认假设深度单位是米；若是毫米可传入 0.001 */
  depthScale?: number;
  /** 点云下采样步长，越大越省性能 */
  stride?: number;
  /** 简易内参：不传时用 fx=fy=500, cx=w/2, cy=h/2 */
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
  /** 要加载到场景中的 Mesh（当点云图层激活时可用） */
  selectedMesh?: MeshInfo | null;
  /** 变换模式：'translate' | 'rotate' | 'scale' */
  transformMode?: 'translate' | 'rotate' | 'scale';
  /** 变换模式变化回调 */
  onTransformModeChange?: (mode: 'translate' | 'rotate' | 'scale') => void;
  /** 场景内 mesh 变换变化时回传到 UI（例如拖拽 TransformControls） */
  onTransformValuesChange?: (values: TransformValues) => void;
  /** 从 UI 发起的变换应用请求（id 用于触发应用） */
  transformRequest?: (TransformValues & { id: number }) | null;
};

const PointCloudPreview3D: React.FC<Props> = ({ 
  npyUrl, 
  depthScale = 1.0, 
  stride = 2, 
  intrinsics,
  selectedMesh,
  transformMode = 'translate',
  onTransformModeChange,
  onTransformValuesChange,
  transformRequest,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const transformHelperRef = useRef<THREE.Object3D | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transformModeRef = useRef<'translate' | 'rotate' | 'scale'>(transformMode);
  const attachedObjectRef = useRef<THREE.Object3D | null>(null);
  const onTransformValuesChangeRef = useRef<Props['onTransformValuesChange']>(onTransformValuesChange);
  const lastAppliedRequestIdRef = useRef<number>(-1);
  
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

  // UI -> 场景：应用 transformRequest（不触发重建场景）
  useEffect(() => {
    if (!transformRequest) return;
    if (transformRequest.id === lastAppliedRequestIdRef.current) return;
    const obj = attachedObjectRef.current;
    if (!obj) return;

    lastAppliedRequestIdRef.current = transformRequest.id;

    const { position, rotationDeg, scale } = transformRequest;
    obj.position.set(position.x, position.y, position.z);
    obj.rotation.set(
      THREE.MathUtils.degToRad(rotationDeg.x),
      THREE.MathUtils.degToRad(rotationDeg.y),
      THREE.MathUtils.degToRad(rotationDeg.z),
    );
    obj.scale.set(scale.x, scale.y, scale.z);
    obj.updateMatrixWorld(true);

    // 同步 TransformControls 到新的 object 状态
    if (transformControlsRef.current) {
      // attach 的 object 不变，仅更新状态即可
      // three@0.183 typings: update(deltaTime) requires 1 arg
      transformControlsRef.current.update(0);
    }
  }, [transformRequest]);

  useEffect(() => {
    setError(null);
  }, [npyUrl]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!npyUrl) return;

    const el = containerRef.current;
    const width = Math.max(1, el.clientWidth);
    const height = Math.max(1, el.clientHeight);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.innerHTML = '';
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#020617');

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 1000);
    camera.position.set(0, 0, 2.2);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(2, 2, 2);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const grid = new THREE.GridHelper(2, 10, 0x334155, 0x1f2937);
    (grid.material as any).opacity = 0.35;
    (grid.material as any).transparent = true;
    scene.add(grid);

    // TransformControls 用于 Unity 风格的变换工具
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode(transformModeRef.current);
    transformControls.setSpace('local');
    // three@0.183: TransformControls 本身不是 Object3D，需将 helper 加入 scene
    const transformHelper = transformControls.getHelper();
    transformHelperRef.current = transformHelper;
    pruneGizmo(transformHelper);
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;

    // 当使用变换控制器时，禁用 OrbitControls
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
    });

    // Unity 风格“选中圆环”（贴地显示，跟随 Mesh）
    const selectionRingGeom = new THREE.RingGeometry(0.45, 0.5, 64);
    const selectionRingMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
    });
    const selectionRing = new THREE.Mesh(selectionRingGeom, selectionRingMat);
    selectionRing.rotation.x = Math.PI / 2; // 放在 XZ 平面
    selectionRing.visible = false;
    scene.add(selectionRing);

    let points: THREE.Points | null = null;
    let meshGroup: THREE.Group | null = null;
    let raf = 0;
    let aborted = false;

    const emitTransformValues = () => {
      const obj = attachedObjectRef.current;
      if (!obj) return;
      const cb = onTransformValuesChangeRef.current;
      if (!cb) return;
      cb({
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotationDeg: {
          x: THREE.MathUtils.radToDeg(obj.rotation.x),
          y: THREE.MathUtils.radToDeg(obj.rotation.y),
          z: THREE.MathUtils.radToDeg(obj.rotation.z),
        },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    };

    const updateSelectionRing = () => {
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

      // 圆环半径按物体水平尺寸估算
      const r = Math.max(size.x, size.z) * 0.6 || 0.3;
      selectionRing.position.set(center.x, box.min.y + 0.001, center.z);
      selectionRing.scale.setScalar(Math.max(0.25, r)); // ringGeom 基础半径约 0.5，靠 scale 放大缩小
      selectionRing.visible = true;
    };

    transformControls.addEventListener('objectChange', updateSelectionRing);
    transformControls.addEventListener('change', () => {
      // 旋转/缩放时也需要更新 ring
      updateSelectionRing();
      emitTransformValues();
    });

    // 加载 Mesh 到场景
    const loadMesh = async (meshInfo: MeshInfo) => {
      if (aborted) return;
      
      try {
        // 移除旧的 Mesh
        if (meshGroup) {
          scene.remove(meshGroup);
          meshGroup.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              if (mesh.geometry) mesh.geometry.dispose();
              if (mesh.material) {
                if (Array.isArray(mesh.material)) {
                  mesh.material.forEach((m) => m.dispose());
                } else {
                  mesh.material.dispose();
                }
              }
            }
          });
          meshGroup = null;
        }
        transformControls.detach();

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
        if (aborted) return;

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

        const obj = objLoader.parse(objText);
        meshGroup = obj;

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

        // 居中并缩放 Mesh
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 0.5 / maxDim; // 缩小到适合点云场景
        obj.scale.setScalar(scale);
        const center = new THREE.Vector3();
        box.getCenter(center);
        obj.position.sub(center);

        scene.add(obj);
        transformControls.attach(obj);
        attachedObjectRef.current = obj;
        updateSelectionRing();
        emitTransformValues();
      } catch (e: any) {
        console.error('[PointCloudPreview3D] Mesh 加载失败:', e);
      }
    };

    const build = async () => {
      try {
        const resp = await fetch(npyUrl, { credentials: 'include' });
        if (!resp.ok) throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
        const buf = await resp.arrayBuffer();
        if (aborted) return;

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

        // 以深度值着色（近=偏亮），并过滤掉 0 深度
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

            // pinhole: X = (u-cx)/fx * Z, Y = -(v-cy)/fy * Z
            // 仅修正前后方向：Z 取反，保持 X/Y 与原图一致
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

        points = new THREE.Points(geom, mat);
        scene.add(points);

        // 视角自动对齐
        const sphere = geom.boundingSphere;
        if (sphere) {
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

    // 键盘快捷键处理：W/E/R 切换变换模式
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return; // 忽略输入框中的按键
      }
      
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
          if (onTransformModeChange) {
            onTransformModeChange(newMode);
          }
        }
      }
    };

    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      // three@0.183 typings: update(deltaTime) requires 1 arg
      transformControls.update(0);
      renderer.render(scene, camera);
    };

    build();
    animate();
    
    // 监听键盘事件
    window.addEventListener('keydown', handleKeyDown);
    
    // 加载 Mesh（如果提供了）
    if (selectedMesh) {
      loadMesh(selectedMesh);
    }

    const onResize = () => {
      if (!containerRef.current) return;
      const w = Math.max(1, containerRef.current.clientWidth);
      const h = Math.max(1, containerRef.current.clientHeight);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(() => onResize());
    ro.observe(el);

    return () => {
      aborted = true;
      ro.disconnect();
      window.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(raf);
      controls.dispose();
      transformControls.dispose();
      transformControlsRef.current = null;
      transformHelperRef.current = null;
      scene.remove(transformHelper);
      scene.remove(selectionRing);
      selectionRingGeom.dispose();
      selectionRingMat.dispose();
      if (points) {
        (points.geometry as THREE.BufferGeometry).dispose();
        (points.material as THREE.Material).dispose();
      }
      if (meshGroup) {
        scene.remove(meshGroup);
        meshGroup.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
              if (Array.isArray(mesh.material)) {
                mesh.material.forEach((m) => m.dispose());
              } else {
                mesh.material.dispose();
              }
            }
          }
        });
      }
      renderer.dispose();
      el.innerHTML = '';
    };
  }, [npyUrl, depthScale, stride, intrinsics, selectedMesh]);

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

