import type { Mask } from '../../types';
import { annotationApi, depthApi, meshApi, pose9dApi } from '../../services/api';
import { toAbsoluteUrl } from '../../utils/urls';

const DEFAULT_MASK_ID = '__mesh_default__';

const normalizeKey = (s: any) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_\-]+/g, '');

const normalizeMaskId = (v: any): string => {
  if (v == null) return DEFAULT_MASK_ID;
  const s = String(v).trim();
  return s.length ? s : DEFAULT_MASK_ID;
};

const isValidPose44 = (pose44: any): pose44 is number[][] => {
  if (!Array.isArray(pose44) || pose44.length !== 4) return false;
  for (const r of pose44) {
    if (!Array.isArray(r) || r.length < 4) return false;
    if (!r.slice(0, 4).every((v: any) => Number.isFinite(Number(v)))) return false;
  }
  return true;
};

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

const computeMaskBBoxCenter = (mask: Mask): { u: number; v: number } | null => {
  const pts = Array.isArray(mask.points) ? mask.points : [];
  if (pts.length < 6) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = Number(pts[i]);
    const y = Number(pts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY].every((n) => Number.isFinite(n))) return null;
  return { u: (minX + maxX) / 2, v: (minY + maxY) / 2 };
};

const buildPose44FromCvRt = (x_cm: number, y_cm: number, z_cm: number): number[][] => {
  // OpenCV pose44: R=I, t=(x,y,z)，单位 cm
  return [
    [1, 0, 0, x_cm],
    [0, 1, 0, y_cm],
    [0, 0, 1, z_cm],
    [0, 0, 0, 1],
  ];
};

type FillInitialPosesResult = {
  created: number;
  updated: number;
  skippedAlreadyHave: number;
  skippedNoMesh: number;
  skippedNoIntrinsics: number;
  totalMasks: number;
  missingLabels: string[];
};

/**
 * 根据 2D mask 补全/写入初始位姿（pose9d_annotations.initial_pose_json）。
 *
 * 说明：
 * - 选择 mesh：严格按 `mesh.skuLabel` 与 `mask.label` 做规范化全等匹配（兼容大小写、空白、_/-）。
 * - 以 mask 的 bbox 中心像素 (u,v) 做粗定位，并使用 intrinsics 将 (u,v,z) 反投影到 OpenCV 坐标系。
 * - z_cm 尝试从 depth_raw 的 npy 在 (v,u) 处取值；若失败则回退为 80cm（对应 diffdope 服务的无有效深度兜底）。
 */
export async function fillInitialPosesByMasks(args: {
  projectId: number;
  imageId: number;
  depthMode: 'raw' | 'fix';
}): Promise<FillInitialPosesResult> {
  const { projectId, imageId, depthMode } = args;

  const [annoResp, depthRows, meshesResp, poseList] = await Promise.all([
    annotationApi.getAnnotation(imageId).catch(() => null),
    depthApi.getDepth(projectId, imageId).catch(() => [] as any[]),
    meshApi.getMeshes(projectId).catch(() => [] as any[]),
    pose9dApi.listPose9D(imageId).catch(() => ({ poses: [] }) as any),
  ]);

  const masks: Mask[] = Array.isArray(annoResp?.annotation?.masks) ? annoResp!.annotation.masks : [];
  const totalMasks = masks.length;

  const meshes = Array.isArray(meshesResp) ? meshesResp : [];

  const meshByLabelKey = new Map<string, { id: number }>();
  for (const m of meshes) {
    const sku = m?.skuLabel ?? null;
    if (sku == null) continue;
    const key = normalizeKey(sku);
    if (!key) continue;
    if (!meshByLabelKey.has(key)) {
      meshByLabelKey.set(key, { id: Number(m.id) });
    }
  }

  const poses = Array.isArray(poseList?.poses) ? poseList.poses : [];
  // maskId -> poses[]（同一 mask 可能对应多个 mesh 记录；优先选择 label-mapped meshId）
  const posesByMaskId = new Map<string, any[]>();
  for (const p of poses) {
    const mid = normalizeMaskId(p?.maskId ?? p?.mask_id ?? null);
    const arr = posesByMaskId.get(mid) || [];
    arr.push(p);
    posesByMaskId.set(mid, arr);
  }

  // 取 intrinsics
  const intrRow =
    (Array.isArray(depthRows)
      ? depthRows.find((d: any) => d?.modality === 'intrinsics' || /^intrinsics_/i.test(String(d?.filename || ''))) || null
      : null) || null;

  let intr: any = null;
  if (intrRow?.url) {
    try {
      const url = toAbsoluteUrl(intrRow.url) || intrRow.url;
      const r = await fetch(url);
      intr = await r.json();
    } catch (_) {
      intr = null;
    }
  }

  const result: FillInitialPosesResult = {
    created: 0,
    updated: 0,
    skippedAlreadyHave: 0,
    skippedNoMesh: 0,
    skippedNoIntrinsics: 0,
    totalMasks,
    missingLabels: [],
  };

  if (!masks.length) return result;

  // 没有内参就无法计算 x/y（至少无法保证反投影一致），直接跳过
  if (!intr) {
    result.skippedNoIntrinsics = masks.length;
    return result;
  }

  const fx = Number(intr?.fx);
  const fy = Number(intr?.fy);
  const cx = Number(intr?.cx ?? intr?.ppx);
  const cy = Number(intr?.cy ?? intr?.ppy);

  if (![fx, fy, cx, cy].every((v) => Number.isFinite(v) && v > 0)) {
    result.skippedNoIntrinsics = masks.length;
    return result;
  }

  // 取 depth npy（用于估计 z_cm；只用 centroid 位置）
  let depthParsed:
    | { shape: number[]; dtype: string; data: Float32Array | Uint16Array | Uint32Array }
    | null = null;

  try {
    const depthRow = (Array.isArray(depthRows) ? depthRows : []).find(
      (d: any) => d?.modality === 'depth_raw' || String(d?.filename || '').toLowerCase().endsWith('.npy'),
    );
    if (depthRow) {
      const npyUrlCandidate =
        depthMode === 'fix'
          ? depthRow?.depthRawFixUrl || depthRow?.depthRawFixPath || null
          : depthRow?.url || null;
      if (npyUrlCandidate) {
        const url = toAbsoluteUrl(npyUrlCandidate) || npyUrlCandidate;
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        depthParsed = parseNpy(buf);
      }
    }
  } catch (_) {
    depthParsed = null;
  }

  const depthScale = Number(intr?.depth_scale ?? intr?.depthScale ?? intr?.depthscale ?? 0.001);

  let depthW = 0;
  let depthH = 0;
  let depthDtype = '';
  let depthData: any = null;
  if (depthParsed) {
    depthH = Number(depthParsed.shape?.[0] ?? 0);
    depthW = Number(depthParsed.shape?.[1] ?? 0);
    depthDtype = String(depthParsed.dtype || '');
    depthData = depthParsed.data;
  }

  const getZcmAtCentroid = (u: number, v: number): number => {
    // 默认兜底：与 pose-service 无有效深度回退一致
    const fallbackZ = 80.0;
    if (!depthData || !depthW || !depthH) return fallbackZ;
    const uu = Math.max(0, Math.min(depthW - 1, Math.round(u)));
    const vv = Math.max(0, Math.min(depthH - 1, Math.round(v)));
    const idx = vv * depthW + uu;
    const raw = Number(depthData?.[idx]);
    if (!Number.isFinite(raw) || raw <= 0) return fallbackZ;
    // PosePointCloudLayer：f4 常为米；其它用 depthScale 换算
    const z_cm = depthDtype.endsWith('f4') ? raw * 100.0 : raw * depthScale * 100.0;
    if (!Number.isFinite(z_cm) || z_cm <= 0) return fallbackZ;
    return z_cm;
  };

  // 并发控制：同一张图可能有很多 mask；这里简单串行，避免对服务端/DB 产生突刺
  let created = 0;
  let updated = 0;
  let skippedAlreadyHave = 0;
  let skippedNoMesh = 0;
  const missingLabelSet = new Set<string>();

  for (let i = 0; i < masks.length; i++) {
    const mask = masks[i];
    const maskId = normalizeMaskId(mask.id);
    const center = computeMaskBBoxCenter(mask);
    if (!center) continue;
    const { u, v } = center;

    const existingCandidates = posesByMaskId.get(maskId) || [];

    // mask label -> mesh（用于创建时，或在候选多 mesh 时优先）
    const labelKey = normalizeKey(mask.label);
    const mappedMesh = labelKey ? meshByLabelKey.get(labelKey) : undefined;

    let targetPoseRec: any | null = null;
    if (existingCandidates.length) {
      if (mappedMesh) {
        targetPoseRec = existingCandidates.find((r) => Number(r?.meshId ?? r?.mesh_id ?? null) === Number(mappedMesh.id)) || existingCandidates[0] || null;
      } else {
        targetPoseRec = existingCandidates[0] || null;
      }
    }

    const pose44 = (() => {
      const z_cm = getZcmAtCentroid(u, v);
      const x_cm = ((u - cx) * z_cm) / fx;
      const y_cm = ((v - cy) * z_cm) / fy;
      return buildPose44FromCvRt(x_cm, y_cm, z_cm);
    })();

    if (targetPoseRec) {
      const targetMeshId = Number(targetPoseRec?.meshId ?? targetPoseRec?.mesh_id ?? 0);
      // 新需求：如果该实例已经有最终位姿（diffdope_json / diffdope.pose44），则不再写入初始位姿
      const prevFinal = targetPoseRec?.diffdope?.pose44;
      if (isValidPose44(prevFinal)) {
        skippedAlreadyHave += 1;
        continue;
      }
      const prev = targetPoseRec?.initialPose?.pose44;
      if (isValidPose44(prev)) {
        skippedAlreadyHave += 1;
        continue;
      }
      await pose9dApi.saveInitialPose(imageId, {
        meshId: targetMeshId,
        maskId: maskId === DEFAULT_MASK_ID ? null : mask.id,
        maskIndex: i,
        pose44,
      });
      updated += 1;
      continue;
    }

    if (!mappedMesh || !mappedMesh.id || !Number.isFinite(mappedMesh.id)) {
      skippedNoMesh += 1;
      const label = (mask.label || '').trim() || '(空 label)';
      missingLabelSet.add(label);
      continue;
    }

    await pose9dApi.saveInitialPose(imageId, {
      meshId: mappedMesh.id,
      maskId: mask.id,
      maskIndex: i,
      pose44,
    });
    created += 1;
  }

  result.created = created;
  result.updated = updated;
  result.skippedAlreadyHave = skippedAlreadyHave;
  result.skippedNoMesh = skippedNoMesh;
  result.missingLabels = Array.from(missingLabelSet.values());
  return result;
}

