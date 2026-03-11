import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

type Props = {
  npyUrl: string | null;
  /** 默认假设深度单位是米；若是毫米可传入 0.001 */
  depthScale?: number;
  /** 点云下采样步长，越大越省性能 */
  stride?: number;
  /** 简易内参：不传时用 fx=fy=500, cx=w/2, cy=h/2 */
  intrinsics?: { fx: number; fy: number; cx: number; cy: number };
};

const PointCloudPreview3D: React.FC<Props> = ({ npyUrl, depthScale = 1.0, stride = 2, intrinsics }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    let points: THREE.Points | null = null;
    let raf = 0;
    let aborted = false;

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
            const X = ((x - cx) / fx) * z;
            const Y = -((y - cy) / fy) * z;
            const Z = z;

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

    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    build();
    animate();

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
      cancelAnimationFrame(raf);
      controls.dispose();
      if (points) {
        (points.geometry as THREE.BufferGeometry).dispose();
        (points.material as THREE.Material).dispose();
      }
      renderer.dispose();
      el.innerHTML = '';
    };
  }, [npyUrl, depthScale, stride, intrinsics]);

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

