import React, { useEffect, useMemo, useState } from 'react';
import type { Image } from '../../types';
import { pose9dApi } from '../../services/api';
import { toAbsoluteUrl } from '../../utils/urls';

type Props = {
  selectedPreviewImage: Image | null;
  images: Image[];
  imageCacheBust: number;
  estimating6d: boolean;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
  onEstimate6D: () => void;
  onStartManualAnnotation: () => void;
};

const PoseImagePreviewPanel: React.FC<Props> = ({
  selectedPreviewImage,
  images,
  imageCacheBust,
  estimating6d,
  onClose,
  onNavigate,
  onEstimate6D,
  onStartManualAnnotation,
}) => {
  const [previewDisplayMode, setPreviewDisplayMode] = useState<'image' | 'fit'>('image');
  const [previewFitOverlayUrl, setPreviewFitOverlayUrl] = useState<string | null>(null);
  const [previewFitLoading, setPreviewFitLoading] = useState(false);

  const currentIndex = useMemo(() => {
    if (!selectedPreviewImage?.id) return -1;
    return images.findIndex((img) => img.id === selectedPreviewImage.id);
  }, [images, selectedPreviewImage?.id]);

  const navPrevDisabled = currentIndex <= 0;
  const navNextDisabled = currentIndex === images.length - 1 || currentIndex < 0;

  useEffect(() => {
    if (!selectedPreviewImage?.id) {
      setPreviewDisplayMode('image');
      setPreviewFitOverlayUrl(null);
      setPreviewFitLoading(false);
      return;
    }

    let cancelled = false;
    setPreviewFitOverlayUrl(null);
    setPreviewFitLoading(true);

    (async () => {
      try {
        const resp = await pose9dApi.listPose9D(selectedPreviewImage.id);
        const rows = Array.isArray(resp?.poses) ? resp.poses : [];
        const withOverlay = rows.filter((p: any) => p?.fitOverlayPath || p?.fit_overlay_path);
        const pick = withOverlay
          .slice()
          .sort((a: any, b: any) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))[0];
        const fitPath = pick?.fitOverlayPath || pick?.fit_overlay_path || null;
        const u = fitPath ? (toAbsoluteUrl(fitPath) || fitPath) : null;
        if (!cancelled) setPreviewFitOverlayUrl(u);
      } catch (_) {
        if (!cancelled) setPreviewFitOverlayUrl(null);
      } finally {
        if (!cancelled) setPreviewFitLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedPreviewImage?.id, imageCacheBust]);

  if (!selectedPreviewImage) {
    return (
      <div className="no-preview-selected">
        <div className="preview-placeholder">
          <span className="preview-icon">🔍</span>
          <p>点击下方缩略图查看图片预览</p>
        </div>
      </div>
    );
  }

  const baseImgUrl = (toAbsoluteUrl(selectedPreviewImage.url) || selectedPreviewImage.url) + `?v=${imageCacheBust}`;

  const showFitOverlay = previewDisplayMode === 'fit' && previewFitOverlayUrl;
  const imgSrc = showFitOverlay ? `${previewFitOverlayUrl}?v=${imageCacheBust}` : baseImgUrl;

  return (
    <div className="image-preview-container">
      <div className="preview-header">
        <h3>{selectedPreviewImage.originalName || selectedPreviewImage.filename}</h3>
        <button className="close-preview-btn" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="image-preview-wrapper" style={{ position: 'relative' }}>
        <div className="preview-floating-panel">
          <button
            type="button"
            className={`preview-mode-btn ${previewDisplayMode === 'image' ? 'active' : ''}`}
            onClick={() => setPreviewDisplayMode('image')}
          >
            原图
          </button>
          <button
            type="button"
            className={`preview-mode-btn ${previewDisplayMode === 'fit' ? 'active' : ''}`}
            onClick={() => setPreviewDisplayMode('fit')}
            title={previewFitOverlayUrl ? '显示拟合图' : '当前图片暂无拟合图'}
          >
            拟合图
          </button>
          {previewFitLoading && <span className="preview-mode-loading">加载中...</span>}
        </div>

        <div className="preview-image-layer" style={{ position: 'relative' }}>
          <img
            src={imgSrc}
            alt={selectedPreviewImage.originalName || selectedPreviewImage.filename}
            className="preview-image"
            style={{
              opacity: previewDisplayMode === 'fit' && !previewFitOverlayUrl && !previewFitLoading ? 0.35 : 1,
            }}
          />

          {previewDisplayMode === 'fit' && !previewFitOverlayUrl && !previewFitLoading && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255,255,255,0.35)',
                color: '#111827',
                fontWeight: 700,
                fontSize: '1rem',
                pointerEvents: 'none',
              }}
            >
              暂无拟合图
            </div>
          )}
        </div>
      </div>

      <div className="preview-actions">
        <button className="nav-image-btn prev-image-btn" onClick={() => onNavigate('prev')} disabled={navPrevDisabled}>
          ← 上一张
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="ai-annotation-btn pose-ai-annotate-btn"
            disabled={estimating6d}
            onClick={onEstimate6D}
            title="调用 Diff-DOPE 进行 AI 6D 姿态标注"
          >
            {estimating6d ? 'AI计算中...' : 'AI 6D姿态标注'}
          </button>

          <button type="button" className="start-annotation-btn" onClick={onStartManualAnnotation}>
            开始人工标注
          </button>
        </div>

        <button className="nav-image-btn next-image-btn" onClick={() => onNavigate('next')} disabled={navNextDisabled}>
          下一张 →
        </button>
      </div>
    </div>
  );
};

export default PoseImagePreviewPanel;

