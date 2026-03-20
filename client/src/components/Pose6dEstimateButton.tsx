import React, { useMemo, useState } from 'react';
import type { Image } from '../types';
import { pose6dApi } from '../services/api';
import { makeDiffDopeOverlayKey, setDiffDopeOverlay } from '../diffdopeOverlayCache';
import { setPoseAutoOpen3D } from '../poseAutoOpen3D';

type DiffDopeParams = {
  iters: number;
  batchSize: number;
  lrLow: number;
  lrHigh: number;
  baseLr: number;
  lrDecay: number;
  useMaskLoss: boolean;
  useDepthLoss: boolean;
  useRgbLoss: boolean;
  weightMask: number;
  weightDepth: number;
  weightRgb: number;
  returnDebugImages: boolean;
};

export type Pose6dOverlay = {
  imageId: number;
  meshId: number;
  label?: string | null;
  overlayRgbPngB64?: string;
  overlayDepthPngB64?: string;
  lossPlotPngB64?: string;
  error?: string | null;
  timingSec?: number | null;
  savedAt: string;
};

type Props = {
  projectId: number | null | undefined;
  image: Image | null;
  diffDopeParams: DiffDopeParams;
  setPose6dOverlay: React.Dispatch<React.SetStateAction<Pose6dOverlay | null>>;
};

export default function Pose6dEstimateButton({ projectId, image, diffDopeParams, setPose6dOverlay }: Props) {
  const [working, setWorking] = useState(false);
  const imgId = useMemo(() => (image?.id != null ? Number(image.id) : null), [image?.id]);

  const onClick = async () => {
    const pid = projectId != null ? Number(projectId) : NaN;
    if (!image?.id || !Number.isFinite(pid) || imgId == null) return;
    if (working) return;

    setWorking(true);
    try {
      const payload = {
        projectId: pid,
        // 默认允许同 label 多 mask：否则很容易因为“同类多个实例”导致全部被跳过，results 为空
        onlyUniqueMasks: false,
        iters: diffDopeParams.iters,
        batchSize: diffDopeParams.batchSize,
        lrLow: diffDopeParams.lrLow,
        lrHigh: diffDopeParams.lrHigh,
        baseLr: diffDopeParams.baseLr,
        lrDecay: diffDopeParams.lrDecay,
        useMaskLoss: diffDopeParams.useMaskLoss,
        useDepthLoss: diffDopeParams.useDepthLoss,
        useRgbLoss: diffDopeParams.useRgbLoss,
        weightMask: diffDopeParams.weightMask,
        weightDepth: diffDopeParams.weightDepth,
        weightRgb: diffDopeParams.weightRgb,
        returnDebugImages: diffDopeParams.returnDebugImages,
        debug: true,
      };

      const resp = await pose6dApi.diffdopeEstimate(image.id, payload);
      const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
      const failures: string[] = Array.isArray(resp?.failures) ? resp.failures : [];

      // 直接把 overlay 渲染到当前预览画布上（右上预览区），方便立即验收
      try {
        const first = results[0] || null;
        const dbg = first?.pose?.debugImages || null;
        const meshId = Number(first?.meshId ?? 0);
        const overlayRgb = typeof dbg?.overlayRgbPngB64 === 'string' ? dbg.overlayRgbPngB64 : '';
        const overlayDepth = typeof dbg?.overlayDepthPngB64 === 'string' ? dbg.overlayDepthPngB64 : '';
        const lossPlot = typeof dbg?.lossPlotPngB64 === 'string' ? dbg.lossPlotPngB64 : '';
        const dbgErr = typeof dbg?.error === 'string' ? dbg.error : null;

        if (meshId && Number.isFinite(meshId)) {
          setPose6dOverlay({
            imageId: imgId,
            meshId,
            label: first?.label ?? null,
            overlayRgbPngB64: overlayRgb || undefined,
            overlayDepthPngB64: overlayDepth || undefined,
            lossPlotPngB64: lossPlot || undefined,
            error: dbgErr,
            timingSec: first?.pose?.timingSec ?? null,
            savedAt: new Date().toISOString(),
          });

          // auto-open 3D scene after diffdope so user can see the mesh in 3D space
          try {
            setPoseAutoOpen3D({
              projectId: pid,
              imageId: imgId,
              meshId,
              source: 'diffdope',
              createdAt: new Date().toISOString(),
            });
          } catch (_) {}
        } else {
          setPose6dOverlay({
            imageId: imgId,
            meshId: 0,
            label: first?.label ?? null,
            error: failures.length
              ? `未找到可展示的结果（results 为空或缺少 meshId）。失败原因：\n- ${failures.join('\n- ')}`
              : '未找到可展示的结果（results 为空或缺少 meshId）',
            timingSec: null,
            savedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn('[Pose6dEstimateButton] set overlay failed:', e);
      }

      // 把 Diff-DOPE 的可视化结果写入 localStorage，供 PoseManualAnnotation 的“拟合图层”直接显示
      try {
        for (const r of results) {
          const meshId = Number(r?.meshId ?? 0);
          if (!meshId || Number.isNaN(meshId)) continue;
          const pose = r?.pose || null;
          const dbg = pose?.debugImages || null;
          const overlayRgb = typeof dbg?.overlayRgbPngB64 === 'string' ? dbg.overlayRgbPngB64 : '';
          const overlayDepth = typeof dbg?.overlayDepthPngB64 === 'string' ? dbg.overlayDepthPngB64 : '';
          const lossPlot = typeof dbg?.lossPlotPngB64 === 'string' ? dbg.lossPlotPngB64 : '';
          if (!overlayRgb && !overlayDepth && !lossPlot) continue;

          const key = makeDiffDopeOverlayKey(pid, imgId, meshId);
          // Use in-memory cache to avoid localStorage quota issues (base64 PNG can be > 5MB).
          setDiffDopeOverlay(key, {
            meshId,
            imageId: imgId,
            label: r?.label ?? null,
            maskId: r?.maskId ?? null,
            maskIndex: r?.maskIndex ?? 0,
            argmin: pose?.argmin ?? null,
            pose44: pose?.pose44 ?? null,
            timingSec: pose?.timingSec ?? null,
            debugImages: {
              overlayRgbPngB64: overlayRgb,
              overlayDepthPngB64: overlayDepth,
              lossPlotPngB64: lossPlot,
            },
            savedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn('[Pose6dEstimateButton] write overlay cache failed:', e);
      }

      alert(
        [
          `6D 姿态推测完成：${results.length} 个结果。`,
          failures.length ? `\n失败/跳过：\n- ${failures.join('\n- ')}` : '',
          `\n右上预览：已写入 Diff-DOPE 状态条（若有 overlay 会自动叠加）。`,
          results.length ? `\n提示：完整结果仍已打印到控制台。` : '',
        ].join(''),
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <button
      type="button"
      className="ai-prompt-modal-btn secondary"
      disabled={!image || !projectId || working || imgId == null}
      title="基于 RGB + Depth + Mask + Mesh + 初始姿态，调用 Diff-DOPE 通过梯度下降推测 6D 姿态（开发中）"
      onClick={onClick}
    >
      {working ? '推测中...' : '6D姿态推测'}
    </button>
  );
}

