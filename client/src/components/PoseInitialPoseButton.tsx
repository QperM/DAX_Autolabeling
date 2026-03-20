import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Image } from '../types';
import { depthApi, meshApi, pose9dApi, annotationApi } from '../services/api';
import { clearStoredCurrentProject } from '../tabStorage';
import { toAbsoluteUrl } from '../utils/urls';

type Props = {
  projectId: number | null | undefined;
  image: Image | null;
};

export default function PoseInitialPoseButton({ projectId, image }: Props) {
  const navigate = useNavigate();
  const [working, setWorking] = useState(false);

  const imageId = useMemo(() => (image?.id != null ? Number(image.id) : null), [image?.id]);

  const onClick = async () => {
    const pid = projectId != null ? Number(projectId) : NaN;
    const img = image;
    if (!img) {
      // eslint-disable-next-line no-console
      console.warn('[PoseInitialPoseButton] early return: image is null');
      return;
    }
    const imgIdNum = img?.id != null ? Number(img.id) : NaN;
    // (debug log removed)
    if (!imgIdNum || !Number.isFinite(pid) || !Number.isFinite(imgIdNum)) {
      // eslint-disable-next-line no-console
      console.warn('[PoseInitialPoseButton] early return: invalid inputs', { pid, imgIdNum });
      return;
    }
    if (working) {
      // eslint-disable-next-line no-console
      console.warn('[PoseInitialPoseButton] early return: already working');
      return;
    }

    setWorking(true);
    try {
      const imageIdNum = Number(img.id);
      const projectIdNum = Number(pid);
      const overallT0 = Date.now();
      // (debug log removed)

      // 目标：只调 Z（距离）+ 平移到 bbox 中心，得到一个“不超过 bbox、尽量贴边”的初始位姿，并入库
      const normalizeKey = (s: any) => String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[_\-]+/g, '');

      const imgW = Number(img.width || 0) || 1280;
      const imgH = Number(img.height || 0) || 720;

      type Pt2 = { x: number; y: number };

      const computeConvexHullSvgPoints = (pts: Pt2[], clamp: { minX: number; minY: number; maxX: number; maxY: number }) => {
        const uniqueKey = (p: Pt2) => `${Math.round(p.x * 1000)}/${Math.round(p.y * 1000)}`;
        const map = new Map<string, Pt2>();
        for (const p of pts) {
          const key = uniqueKey(p);
          if (!map.has(key)) map.set(key, p);
        }
        const points = Array.from(map.values());
        if (points.length < 3) return null;

        // Monotonic chain convex hull. Output is CCW (without closing point).
        const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
        const cross = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        const lower: Pt2[] = [];
        for (const p of sorted) {
          while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
          }
          lower.push(p);
        }

        const upper: Pt2[] = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
          const p = sorted[i];
          while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
          }
          upper.push(p);
        }

        upper.pop();
        lower.pop();
        const hull = lower.concat(upper);
        if (hull.length < 3) return null;

        // Strict inside bbox: clamp points (small numeric drift can happen).
        const clamped = hull.map((p) => ({
          x: Math.max(clamp.minX, Math.min(clamp.maxX, p.x)),
          y: Math.max(clamp.minY, Math.min(clamp.maxY, p.y)),
        }));

        return `${clamped.map((p) => `${p.x},${p.y}`).join(' ')}`;
      };

      const eulerDegToMat3_RzRyRx = (deg: { x: number; y: number; z: number }) => {
        const degToRad = (d: number) => (Number.isFinite(d) ? d * Math.PI : 0);
        const rx = degToRad(Number(deg?.x ?? 0));
        const ry = degToRad(Number(deg?.y ?? 0));
        const rz = degToRad(Number(deg?.z ?? 0));
        const cx = Math.cos(rx);
        const sx = Math.sin(rx);
        const cy = Math.cos(ry);
        const sy = Math.sin(ry);
        const cz = Math.cos(rz);
        const sz = Math.sin(rz);
        // Keep consistent with PointCloudMeshInteraction.tsx:
        // R = Rz * Ry * Rx (X right, Y up, Z forward in Unity axes)
        // Matrix rows: [r00 r01 r02; r10 r11 r12; r20 r21 r22]
        return {
          r00: cz * cy,
          r01: cz * sy * sx - sz * cx,
          r02: cz * sy * cx + sz * sx,
          r10: sz * cy,
          r11: sz * sy * sx + cz * cx,
          r12: sz * sy * cx - cz * sx,
          r20: -sy,
          r21: cy * sx,
          r22: cy * cx,
        };
      };

      const computeProjectedHullSvgPointsFromObjVertices = async (params: {
        meshUrl: string | undefined | null;
        fx: number;
        fy: number;
        cx: number;
        cy: number;
        positionMeters: { x: number; y: number; z: number };
        rotationDeg: { x: number; y: number; z: number };
        imgW: number;
        imgH: number;
        bboxPx: { minX: number; minY: number; maxX: number; maxY: number };
        fallbackRectSvgPoints: string | null;
      }): Promise<string | null> => {
        const { meshUrl, fx, fy, cx, cy, positionMeters, rotationDeg, imgW, imgH, bboxPx, fallbackRectSvgPoints } = params;
        if (!meshUrl) return fallbackRectSvgPoints;

        try {
          const abs = (toAbsoluteUrl(meshUrl) as string | undefined) || meshUrl;
          const resp = await fetch(abs, { credentials: 'include', cache: 'no-store' });
          if (!resp.ok) return fallbackRectSvgPoints;
          const text = await resp.text();

          const tx = Number(positionMeters.x);
          const ty = Number(positionMeters.y);
          const tz = Number(positionMeters.z);
          if (![tx, ty, tz].every((v) => Number.isFinite(v)) || tz <= 1e-9) return fallbackRectSvgPoints;

          const R = eulerDegToMat3_RzRyRx(rotationDeg);

          const verts: Array<[number, number, number]> = [];
          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            const t = line.trim();
            if (!t || t.length < 2) continue;
            // Only parse vertex positions. Ignore vn/vt.
            if (!(t.startsWith('v ') || t.startsWith('v\t'))) continue;
            const parts = t.split(/\s+/);
            if (parts.length < 4) continue;
            const x = Number(parts[1]);
            const y = Number(parts[2]);
            const z = Number(parts[3]);
            if (![x, y, z].every((v) => Number.isFinite(v))) continue;
            verts.push([x, y, z]);
          }

          if (verts.length < 3) return fallbackRectSvgPoints;

          // Downsample for performance.
          const targetMax = 5000;
          const stride = Math.max(1, Math.floor(verts.length / targetMax));

          const pts2: Pt2[] = [];
          for (let i = 0; i < verts.length; i += stride) {
            const [x0, y0, z0] = verts[i];
            // Apply mesh rotation in OBJ space, then apply translation.
            const xRot = R.r00 * x0 + R.r01 * y0 + R.r02 * z0;
            const yRot = R.r10 * x0 + R.r11 * y0 + R.r12 * z0;
            const zRot = R.r20 * x0 + R.r21 * y0 + R.r22 * z0;
            const X = xRot + tx;
            const Y = yRot + ty;
            const Z = zRot + tz;
            if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z) || Z <= 1e-9) continue;
            const u = fx * (X / Z) + cx;
            // Keep consistent with the Y flip used in computeProjectedRectPointsFromMeshBbox.
            const v = fy * ((-Y) / Z) + cy;
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;

            // Don't clamp to bbox px here.
            // Clamping per-vertex destroys rotation-induced silhouette differences,
            // because out-of-bounds vertices all collapse onto bbox edges.
            // We only clamp to image for numerical safety, then clamp hull vertices later.
            const iiU = Math.max(0, Math.min(imgW, u));
            const iiV = Math.max(0, Math.min(imgH, v));
            pts2.push({ x: iiU, y: iiV });
          }

          if (pts2.length < 3) return fallbackRectSvgPoints;
          return computeConvexHullSvgPoints(pts2, bboxPx);
        } catch (_) {
          return fallbackRectSvgPoints;
        }
      };

      try {
        // 1) intrinsics
        const depthList = await depthApi.getDepth(projectIdNum, imageIdNum);
        const intr = (depthList || []).find((d: any) => {
          const n = String(d.originalName || d.filename || '').toLowerCase();
          const isJson = n.endsWith('.json');
          const isIntr = d.modality === 'intrinsics' || n.startsWith('intrinsics_');
          return isJson && isIntr;
        }) as any;
        if (!intr?.url) {
          alert('缺少相机内参 intrinsics_*.json：请先在“深度数据”上传相机内参文件。');
          return;
        }
        const intrUrlAbs = toAbsoluteUrl(intr.url) || intr.url;
        const intrResp = await fetch(intrUrlAbs, { cache: 'no-store' });
        if (!intrResp.ok) throw new Error(`加载 intrinsics 失败: HTTP ${intrResp.status}`);
        const intrJs = await intrResp.json();
        const fx = Number(intrJs?.fx);
        const fy = Number(intrJs?.fy);
        const cx = Number(intrJs?.ppx ?? intrJs?.cx);
        const cy = Number(intrJs?.ppy ?? intrJs?.cy);
        if (![fx, fy, cx, cy].every((v) => Number.isFinite(v))) {
          alert(`intrinsics JSON 缺少/非法：fx=${fx}, fy=${fy}, cx=${cx}, cy=${cy}`);
          return;
        }

        // 2) masks / bbox：bbox_data 作为真值（来自 annotations.bbox_data）
        let annoResp: any;
        try {
          annoResp = await annotationApi.getAnnotation(imageIdNum);
        } catch (e: any) {
          const status = e?.response?.status;
          if (status === 403) {
            alert('当前会话权限已失效或无权访问该图片所属项目，请返回主页重新输入验证码。');
            clearStoredCurrentProject();
            navigate('/');
            return;
          }
          throw e;
        }

        const masks: any[] = Array.isArray(annoResp?.annotation?.masks) ? annoResp.annotation.masks : [];
        const boundingBoxes: any[] = Array.isArray(annoResp?.annotation?.boundingBoxes) ? annoResp.annotation.boundingBoxes : [];
        if (!boundingBoxes.length) {
          alert('该图片没有可用的 bbox_data（Bounding Boxes）：请先生成/保存 BoundingBox。');
          return;
        }

        // 3) meshes（用 skuLabel 匹配 bbox/target label）
        const meshes = await meshApi.getMeshes(projectIdNum);
        const findMeshForLabel = (label: any) => {
          const k = normalizeKey(label);
          if (!k) return null;
          return (
            meshes.find((m: any) => normalizeKey(m?.skuLabel) === k) ||
            meshes.find((m: any) => normalizeKey(m?.skuLabel).includes(k)) ||
            meshes.find((m: any) => normalizeKey(`${m?.originalName || ''}${m?.filename || ''}`).includes(k)) ||
            null
          );
        };

        const margin = 0.98; // 严格不超出 bbox：留 2% 余量
        const saved: Array<{ label: string; meshId: number }> = [];
        const skipped: string[] = [];

        for (const bbItem of boundingBoxes) {
          const label = String(bbItem?.label || '').trim() || '未命名';
          const bbX = Number(bbItem?.x);
          const bbY = Number(bbItem?.y);
          const bbW = Number(bbItem?.width);
          const bbH = Number(bbItem?.height);
          if (![bbX, bbY, bbW, bbH].every((v) => Number.isFinite(v) && v >= 0)) {
            skipped.push(`${label}: bbox_data 坐标/尺寸非法`);
            continue;
          }
          if (!(bbW > 0 && bbH > 0)) {
            skipped.push(`${label}: bbox_data 宽/高 非法或为 0`);
            continue;
          }

          const bb = {
            minX: bbX,
            minY: bbY,
            maxX: bbX + bbW,
            maxY: bbY + bbH,
            w: bbW,
            h: bbH,
            cx: bbX + bbW / 2,
            cy: bbY + bbH / 2,
          };

          const mesh = findMeshForLabel(label) as any;
          const meshId = Number(mesh?.id ?? 0);
          const meshBbox = mesh?.bbox ?? null;
          const sizeX = Number(meshBbox?.size?.x);
          const sizeY = Number(meshBbox?.size?.y);
          const sizeZ = Number(meshBbox?.size?.z);
          if (!meshId || Number.isNaN(meshId)) {
            skipped.push(`${label}: 未找到匹配 mesh（请先给 mesh 绑定 skuLabel=目标 label）`);
            continue;
          }
          if (!meshBbox?.min || !meshBbox?.max) {
            skipped.push(`${label}: mesh 缺少 bbox min/max（请重新上传/确保 OBJ 可解析顶点）`);
            continue;
          }
          if (![sizeX, sizeY, sizeZ].every((v) => Number.isFinite(v) && v > 0)) {
            skipped.push(`${label}: mesh 缺少 bbox 尺寸（请重新上传/确保 OBJ 可解析顶点）`);
            continue;
          }

          const objCenterX = (Number(meshBbox.min.x) + Number(meshBbox.max.x)) / 2;
          const objCenterY = (Number(meshBbox.min.y) + Number(meshBbox.max.y)) / 2;

          // 初始位姿：仅估计距离（tz）与平移到 bbox 中心（tx/ty），rotation 固定为 0。
          const tz = Math.max(
            (fx * sizeX) / Math.max(1e-6, bb.w),
            (fy * sizeY) / Math.max(1e-6, bb.h),
          ) / margin;
          if (!Number.isFinite(tz) || tz <= 0) {
            skipped.push(`${label}: 计算 tz 失败`);
            continue;
          }

          const tx = ((bb.cx - cx) * tz) / fx - objCenterX;
          // v = fy * (-Y/Z) + cy => 需要对齐 bbox 的 y：
          const ty = ((cy - bb.cy) * tz) / fy - objCenterY;
          if (![tx, ty, tz].every((v) => Number.isFinite(v))) {
            skipped.push(`${label}: 计算 tx/ty/tz 失败`);
            continue;
          }

          const rotationDeg = { x: 0, y: 0, z: 0 };
          const bestIoU = 0;
          const bestRotationDeg = rotationDeg;
          const bestTx = tx;
          const bestTy = ty;
          const bestTz = tz;

          const maskHit = masks.find((m: any) => normalizeKey(m?.label) === normalizeKey(label));

          // 计算 fallback rectangle：将未旋转 mesh bbox 投影到 2D，并严格夹在 bbox 内
          const corners = [
            [Number(meshBbox.min.x), Number(meshBbox.min.y), Number(meshBbox.min.z)],
            [Number(meshBbox.min.x), Number(meshBbox.min.y), Number(meshBbox.max.z)],
            [Number(meshBbox.min.x), Number(meshBbox.max.y), Number(meshBbox.min.z)],
            [Number(meshBbox.min.x), Number(meshBbox.max.y), Number(meshBbox.max.z)],
            [Number(meshBbox.max.x), Number(meshBbox.min.y), Number(meshBbox.min.z)],
            [Number(meshBbox.max.x), Number(meshBbox.min.y), Number(meshBbox.max.z)],
            [Number(meshBbox.max.x), Number(meshBbox.max.y), Number(meshBbox.min.z)],
            [Number(meshBbox.max.x), Number(meshBbox.max.y), Number(meshBbox.max.z)],
          ] as Array<[number, number, number]>;

          let uMin = Infinity;
          let vMin = Infinity;
          let uMax = -Infinity;
          let vMax = -Infinity;
          for (const [x0, y0, z0] of corners) {
            const X = x0 + tx;
            const Y = y0 + ty;
            const Z = z0 + tz;
            if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z) || Z <= 1e-9) continue;
            const u = fx * (X / Z) + cx;
            const v = fy * ((-Y) / Z) + cy;
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
            uMin = Math.min(uMin, u);
            vMin = Math.min(vMin, v);
            uMax = Math.max(uMax, u);
            vMax = Math.max(vMax, v);
          }
          if (![uMin, vMin, uMax, vMax].every((v) => Number.isFinite(v))) {
            skipped.push(`${label}: fallback rect 计算失败`);
            continue;
          }

          const bestRect = {
            minU: Math.max(bb.minX, Math.min(bb.maxX, uMin)),
            minV: Math.max(bb.minY, Math.min(bb.maxY, vMin)),
            maxU: Math.max(bb.minX, Math.min(bb.maxX, uMax)),
            maxV: Math.max(bb.minY, Math.min(bb.maxY, vMax)),
          };

          const initialPose = {
            format: 'pose9d',
            version: 1,
            projectId: projectIdNum,
            imageId: imageIdNum,
            mesh: {
              id: meshId,
              filename: mesh?.filename,
              originalName: mesh?.originalName,
              url: mesh?.url,
            },
            pose: {
              positionMm: { x: bestTx * 1000, y: bestTy * 1000, z: bestTz * 1000 },
              rotationDeg: bestRotationDeg,
              scale: 1,
            },
            intrinsics: { fx, fy, cx, cy, source: intr?.originalName || intr?.filename || null },
            targetBboxPx: { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY },
            meshBbox,
            savedAt: new Date().toISOString(),
          };

          // Also write a "拟合图层" cache (used by PoseManualAnnotation) so user can immediately click it.
          const fallbackRectSvgPoints = `${bestRect.minU},${bestRect.minV} ${bestRect.maxU},${bestRect.minV} ${bestRect.maxU},${bestRect.maxV} ${bestRect.minU},${bestRect.maxV}`;

          const hullSvgPoints = await computeProjectedHullSvgPointsFromObjVertices({
            meshUrl: mesh?.url,
            fx,
            fy,
            cx,
            cy,
            positionMeters: { x: bestTx, y: bestTy, z: bestTz },
            rotationDeg: bestRotationDeg,
            imgW,
            imgH,
            bboxPx: { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY },
            fallbackRectSvgPoints,
          });

          if (!hullSvgPoints) {
            skipped.push(`${label}: 计算 mesh 投影轮廓失败`);
            continue;
          }

          const posefitLocalKey = `posefit:${projectIdNum}:${imageIdNum}:${meshId}`;
          try {
            await pose9dApi.saveInitialPose(imageIdNum, { meshId, pose9d: initialPose });
            localStorage.setItem(`initialpose:${projectIdNum}:${imageIdNum}:${meshId}`, JSON.stringify(initialPose));
            localStorage.setItem(
              posefitLocalKey,
              JSON.stringify({
                meshId,
                maskId: maskHit?.id ?? null,
                maskIndex: 0,
                bestIoU,
                bestRotationDeg,
                hullSvgPoints,
                source: 'initial-pose',
                savedAt: new Date().toISOString(),
              }),
            );
            saved.push({ label, meshId });
          } catch (e: any) {
            console.warn('[PoseInitialPoseButton] 保存初始位姿/拟合图层缓存失败:', e);
            skipped.push(`${label}: 入库失败（${e?.message || 'unknown error'}）`);
          }
        }

        alert(
          [
            `初始位姿计算完成：成功 ${saved.length} 条。`,
            skipped.length ? `\n跳过/失败：\n- ${skipped.join('\n- ')}` : '',
            saved.length ? `\n接下来可进入“开始人工标注”，打开“拟合图层”肉眼验收。` : '',
          ].join(''),
        );

        if (saved.length) {
          // 保存成功后不自动跳转到手动标注页，避免打断当前操作流程。
        }
      } catch (e: any) {
        console.error('[PoseInitialPoseButton] 计算/保存初始位姿失败:', e);
        const status = e?.response?.status;
        if (status === 403) {
          alert('当前会话权限已失效或无权访问该项目，请返回主页重新输入验证码。');
          clearStoredCurrentProject();
          navigate('/');
          return;
        }
        alert(e?.message || '计算/保存初始位姿失败');
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <button
      type="button"
      className="ai-prompt-modal-btn secondary"
      disabled={!image || !projectId || working || imageId == null}
      title="确认初始位姿（保存后请手动进入人工标注验收）"
      onClick={onClick}
    >
      {working ? '计算中...' : '确定初始位姿'}
    </button>
  );
}

