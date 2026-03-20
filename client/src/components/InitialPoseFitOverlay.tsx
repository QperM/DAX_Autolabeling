import { useEffect, useMemo, useState } from 'react';
import { meshApi, pose9dApi } from '../services/api';

type Intrinsics = { fx: number; fy: number; cx: number; cy: number };

export type InitialPoseFitOverlayProps = {
  enabled: boolean;
  suppress?: boolean;
  projectId: number | string | null | undefined;
  image: { id: number | string; width?: number | null; height?: number | null } | null;
  selectedMeshId?: number | null;
  activeIntrinsics?: Intrinsics | null;
};

type OverlayState = {
  meshId: number;
  rectSvgPoints: string;
  label?: string | null;
  source?: 'db' | 'localStorage';
} | null;

function safeParse(raw: string | null): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function computeProjectedRectPoints(params: {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  meshBbox: any;
  positionMm: { x: number; y: number; z: number };
  imgW: number;
  imgH: number;
}): string | null {
  const { fx, fy, cx, cy, meshBbox, positionMm, imgW, imgH } = params;
  const min = meshBbox?.min;
  const max = meshBbox?.max;
  if (!min || !max) return null;
  const minX = Number(min.x),
    minY = Number(min.y),
    minZ = Number(min.z);
  const maxX = Number(max.x),
    maxY = Number(max.y),
    maxZ = Number(max.z);
  if (![minX, minY, minZ, maxX, maxY, maxZ].every((v) => Number.isFinite(v))) return null;

  const tx = Number(positionMm.x) * 0.001;
  const ty = Number(positionMm.y) * 0.001;
  const tz = Number(positionMm.z) * 0.001;
  if (![tx, ty, tz].every((v) => Number.isFinite(v)) || tz <= 1e-9) return null;

  const corners = [
    [minX, minY, minZ],
    [minX, minY, maxZ],
    [minX, maxY, minZ],
    [minX, maxY, maxZ],
    [maxX, minY, minZ],
    [maxX, minY, maxZ],
    [maxX, maxY, minZ],
    [maxX, maxY, maxZ],
  ] as Array<[number, number, number]>;

  let uMin = Infinity,
    vMin = Infinity,
    uMax = -Infinity,
    vMax = -Infinity;
  for (const [x0, y0, z0] of corners) {
    const X = x0 + tx;
    const Y = y0 + ty;
    const Z = z0 + tz;
    if (!(Number.isFinite(X) && Number.isFinite(Y) && Number.isFinite(Z)) || Z <= 1e-9) continue;
    const u = fx * (X / Z) + cx;
    // Keep consistent with `PoseInitialPoseButton`: flip Y during projection
    // so SVG's y-axis (downwards) matches the camera/object convention.
    const v = fy * ((-Y) / Z) + cy;
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (u < uMin) uMin = u;
    if (v < vMin) vMin = v;
    if (u > uMax) uMax = u;
    if (v > vMax) vMax = v;
  }
  if (![uMin, vMin, uMax, vMax].every((v) => Number.isFinite(v))) return null;

  const cuMin = Math.max(0, Math.min(imgW, uMin));
  const cvMin = Math.max(0, Math.min(imgH, vMin));
  const cuMax = Math.max(0, Math.min(imgW, uMax));
  const cvMax = Math.max(0, Math.min(imgH, vMax));
  return `${cuMin},${cvMin} ${cuMax},${cvMin} ${cuMax},${cvMax} ${cuMin},${cvMax}`;
}

export default function InitialPoseFitOverlay(props: InitialPoseFitOverlayProps) {
  const { enabled, suppress, projectId, image, selectedMeshId, activeIntrinsics } = props;

  const pid = projectId != null ? Number(projectId) : NaN;
  const imgId = image?.id != null ? Number(image.id) : NaN;
  const mid = selectedMeshId != null ? Number(selectedMeshId) : null;

  const imgW = useMemo(() => Number(image?.width || 0) || 1280, [image?.width]);
  const imgH = useMemo(() => Number(image?.height || 0) || 720, [image?.height]);

  const [overlay, setOverlay] = useState<OverlayState>(null);

  useEffect(() => {
    if (!enabled || suppress) {
      setOverlay(null);
      return;
    }
    if (!Number.isFinite(pid) || !pid) return;
    if (!Number.isFinite(imgId) || !imgId) return;

    (async () => {
      try {
        const intr =
          activeIntrinsics && [activeIntrinsics.fx, activeIntrinsics.fy, activeIntrinsics.cx, activeIntrinsics.cy].every((v) => Number.isFinite(v) && v > 0)
            ? activeIntrinsics
            : null;

        const meshes = await meshApi.getMeshes(pid);
        const meshById = new Map<number, any>();
        for (const m of meshes || []) {
          const id = Number((m as any)?.id ?? 0);
          if (id) meshById.set(id, m);
        }

        const rowsResp = await pose9dApi.listPose9D(imgId);
        const rows: any[] = Array.isArray(rowsResp?.poses) ? rowsResp.poses : [];
        const row =
          mid != null ? rows.find((r) => Number(r?.mesh_id) === Number(mid)) || null : (rows[0] || null);

        const fromDb = (() => {
          const initialPose = row?.initialPose ?? null;
          const pose = row?.pose ?? null;
          const payload = initialPose || pose || null;
          const poseContainer = payload?.pose && payload?.mesh ? payload.pose : payload;
          const posMm = poseContainer?.positionMm ?? null;
          const meshId = Number(row?.mesh_id ?? 0);
          if (!meshId || !posMm) return null;
          return { meshId, positionMm: posMm, payload };
        })();

        const fromLs = (() => {
          try {
            const prefix = `initialpose:${pid}:${imgId}:`;
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (!k || !k.startsWith(prefix)) continue;
              const one = safeParse(localStorage.getItem(k));
              if (!one) continue;
              const meshId = Number(one?.mesh?.id ?? one?.meshId ?? k.slice(prefix.length));
              const posMm = one?.pose?.positionMm ?? null;
              if (!meshId || !posMm) continue;
              if (mid != null && Number(mid) !== Number(meshId)) continue;
              return { meshId, positionMm: posMm, payload: one };
            }
            return null;
          } catch {
            return null;
          }
        })();

        const chosen = fromDb || fromLs;
        if (!chosen) {
          setOverlay(null);
          return;
        }

        const meshRow = meshById.get(Number(chosen.meshId)) || null;
        const meshBbox = (meshRow as any)?.bbox ?? chosen?.payload?.meshBbox ?? null;
        if (!meshBbox) {
          setOverlay(null);
          return;
        }

        const intr2 =
          intr ||
          (() => {
            const p = chosen.payload?.intrinsics || null;
            const fx = Number(p?.fx),
              fy = Number(p?.fy),
              cx = Number(p?.cx),
              cy = Number(p?.cy);
            if (![fx, fy, cx, cy].every((v) => Number.isFinite(v) && v > 0)) return null;
            return { fx, fy, cx, cy } as Intrinsics;
          })();
        if (!intr2) {
          setOverlay(null);
          return;
        }

        const rect = computeProjectedRectPoints({
          fx: intr2.fx,
          fy: intr2.fy,
          cx: intr2.cx,
          cy: intr2.cy,
          meshBbox,
          positionMm: chosen.positionMm,
          imgW,
          imgH,
        });
        if (!rect) {
          setOverlay(null);
          return;
        }

        const label =
          String(
            (meshRow as any)?.skuLabel ||
              chosen.payload?.label ||
              (meshRow as any)?.originalName ||
              (meshRow as any)?.filename ||
              '',
          ).trim() || null;

        setOverlay({
          meshId: Number(chosen.meshId),
          rectSvgPoints: rect,
          label,
          source: fromDb ? 'db' : 'localStorage',
        });
      } catch (e) {
        console.warn('[InitialPoseFitOverlay] compute overlay failed:', e);
        setOverlay(null);
      }
    })();
  }, [
    enabled,
    suppress,
    pid,
    imgId,
    mid,
    imgW,
    imgH,
    activeIntrinsics?.fx,
    activeIntrinsics?.fy,
    activeIntrinsics?.cx,
    activeIntrinsics?.cy,
  ]);

  if (!enabled || suppress) return null;
  if (!overlay?.rectSvgPoints) return null;
  if (!image) return null;

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        margin: 'auto',
        pointerEvents: 'none',
        zIndex: 29,
      }}
      width={image.width || 1280}
      height={image.height || 720}
      viewBox={`0 0 ${image.width || 1280} ${image.height || 720}`}
    >
      <polygon
        points={overlay.rectSvgPoints}
        fill="#f59e0b"
        fillOpacity={0.12}
        stroke="#f59e0b"
        strokeWidth={2}
        strokeDasharray="6 4"
      />
      <text x="12" y="44" fill="#f59e0b" fontSize="14" fontFamily="system-ui, -apple-system, Segoe UI, Roboto, Arial">
        {`initial pose (bbox proj): meshId=${overlay.meshId}${overlay.label ? ` label=${overlay.label}` : ''}${overlay.source ? ` src=${overlay.source}` : ''}`}
      </text>
    </svg>
  );
}

