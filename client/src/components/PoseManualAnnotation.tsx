import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image, Mask } from '../types';
import { setCurrentImage } from '../store/annotationSlice';
import { authApi, depthApi, annotationApi, pose9dApi } from '../services/api';
import { getStoredCurrentProject } from '../tabStorage';
import { toAbsoluteUrl } from '../utils/urls';
import './ManualAnnotation.css';
import PoseFitLayer from './PoseFitLayer';

type DepthInfo = {
  id: number;
  filename: string;
  originalName: string;
  url: string;
  modality?: string;
  role?: string;
};

const PoseManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images } = useSelector((state: any) => state.annotation);
  const projectId = getStoredCurrentProject<any>()?.id;

  const [showRgbLayer, setShowRgbLayer] = useState(true);
  const [showDepthLayer, setShowDepthLayer] = useState(false);
  const [showMaskLayer, setShowMaskLayer] = useState(false);
  const [showFitLayer, setShowFitLayer] = useState(false);

  const [maskOverlayData, setMaskOverlayData] = useState<Mask[] | null>(null);
  const maskFetchReqIdRef = useRef(0);

  const [depthList, setDepthList] = useState<DepthInfo[]>([]);
  const [selectedDepthId, setSelectedDepthId] = useState<number | null>(null);
  const depthFetchReqIdRef = useRef(0);
  const [depthOpacity, setDepthOpacity] = useState(0.45);
  const depthBlendMode: 'normal' = 'normal';
  const [fitOverlayUrl, setFitOverlayUrl] = useState<string | null>(null);
  const fitOverlayReqIdRef = useRef(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rgbImageElRef = useRef<HTMLImageElement | null>(null);
  const [imageDisplayRect, setImageDisplayRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [intrinsicImageSize, setIntrinsicImageSize] = useState<{ width: number; height: number } | null>(null);

  const selectedDepth =
    selectedDepthId != null ? depthList.find((d) => Number((d as any).id) === Number(selectedDepthId)) || null : null;

  useEffect(() => {
    const checkAuthAndImage = async () => {
      try {
        const authStatus = await authApi.checkAuth();
        if (!authStatus.authenticated) {
          navigate('/', { replace: true });
          return;
        }
        const savedProject = getStoredCurrentProject<any>();
        if (!savedProject) {
          navigate('/', { replace: true });
          return;
        }
      } catch {
        navigate('/', { replace: true });
        return;
      }
      if (!currentImage) navigate('/pose', { replace: true });
    };
    checkAuthAndImage();
  }, [currentImage, navigate]);

  useEffect(() => {
    if (!currentImage?.id) return;
    setSelectedDepthId(null);
    setDepthList([]);
    setMaskOverlayData(null);
    setFitOverlayUrl(null);
    setIntrinsicImageSize(null);
    setImageDisplayRect(null);
  }, [currentImage?.id]);

  useEffect(() => {
    if (!currentImage?.id || !showFitLayer) return;
    (async () => {
      const reqId = ++fitOverlayReqIdRef.current;
      try {
        const resp = await pose9dApi.listPose9D(currentImage.id);
        if (reqId !== fitOverlayReqIdRef.current) return;
        const poses = Array.isArray(resp?.poses) ? resp.poses : [];
        const withFitPath = poses.find((p: any) => typeof p?.fitOverlayPath === 'string' && p.fitOverlayPath.trim().length > 0);
        const fitPath = withFitPath?.fitOverlayPath;
        setFitOverlayUrl(fitPath ? (toAbsoluteUrl(fitPath) || fitPath) : null);
      } catch (e) {
        if (reqId !== fitOverlayReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 加载拟合图层失败:', e);
        setFitOverlayUrl(null);
      }
    })();
  }, [currentImage?.id, showFitLayer]);

  useEffect(() => {
    if (!currentImage?.id || !showMaskLayer) return;
    (async () => {
      const reqId = ++maskFetchReqIdRef.current;
      try {
        const resp = await annotationApi.getAnnotation(currentImage.id);
        if (reqId !== maskFetchReqIdRef.current) return;
        setMaskOverlayData(resp?.annotation?.masks || []);
      } catch (e) {
        if (reqId !== maskFetchReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 加载 2D Mask 标注失败:', e);
        setMaskOverlayData(null);
      }
    })();
  }, [currentImage?.id, showMaskLayer]);

  useEffect(() => {
    if (!currentImage?.id || !projectId || !showDepthLayer) return;
    (async () => {
      const reqId = ++depthFetchReqIdRef.current;
      try {
        const list = await depthApi.getDepth(projectId, currentImage.id);
        if (reqId !== depthFetchReqIdRef.current) return;
        setDepthList(list);
        const firstPng = list.find(
          (d) => d.modality === 'depth_png' || String(d.originalName || d.filename).toLowerCase().endsWith('.png'),
        );
        setSelectedDepthId(firstPng ? Number((firstPng as any).id) : list[0] ? Number((list[0] as any).id) : null);
      } catch (e) {
        if (reqId !== depthFetchReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 加载深度列表失败:', e);
        setDepthList([]);
        setSelectedDepthId(null);
      }
    })();
  }, [currentImage?.id, projectId, showDepthLayer]);

  useEffect(() => {
    if (!viewportRef.current) return;
    const el = viewportRef.current;
    let raf = 0;
    const updateRect = () => {
      const viewport = viewportRef.current;
      const imgEl = rgbImageElRef.current;
      if (!viewport || !imgEl) return;
      const v = viewport.getBoundingClientRect();
      const r = imgEl.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setImageDisplayRect({
        left: r.left - v.left,
        top: r.top - v.top,
        width: r.width,
        height: r.height,
      });
    };
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateRect);
    });
    ro.observe(el);
    raf = requestAnimationFrame(updateRect);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [showRgbLayer, showMaskLayer, showDepthLayer, showFitLayer, currentImage?.id]);

  const handleBack = () => {
    dispatch(setCurrentImage(null));
    navigate('/pose', { replace: true });
  };

  const handleNavigateImage = (direction: 'prev' | 'next') => {
    if (!currentImage || !images || images.length === 0) return;
    const currentIndex = images.findIndex((img: Image) => img.id === currentImage.id);
    if (currentIndex === -1) return;
    const next = direction === 'prev' ? images[currentIndex - 1] : images[currentIndex + 1];
    if (next) dispatch(setCurrentImage(next));
  };

  if (!currentImage) return null;

  const maskViewW =
    Number.isFinite(currentImage.width) && (currentImage.width as number) > 0
      ? (currentImage.width as number)
      : intrinsicImageSize?.width ?? 1280;
  const maskViewH =
    Number.isFinite(currentImage.height) && (currentImage.height as number) > 0
      ? (currentImage.height as number)
      : intrinsicImageSize?.height ?? 720;

  return (
    <div className="manual-annotation">
      <header className="annotation-header">
        <div className="header-left">
          <button className="back-button" onClick={handleBack}>
            ← 返回
          </button>
          <h1>9D Pose 人工标注</h1>
          <span className="current-image-name">{currentImage.originalName || currentImage.filename}</span>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="nav-arrow-button"
            onClick={() => handleNavigateImage('prev')}
            disabled={!images || images.length === 0 || images.findIndex((img: Image) => img.id === currentImage.id) <= 0}
            title="上一张"
          >
            ←
          </button>
          <span className="image-counter">
            {images.findIndex((img: Image) => img.id === currentImage.id) + 1} / {images.length}
          </span>
          <button
            type="button"
            className="nav-arrow-button"
            onClick={() => handleNavigateImage('next')}
            disabled={!images || images.length === 0 || images.findIndex((img: Image) => img.id === currentImage.id) === images.length - 1}
            title="下一张"
          >
            →
          </button>
        </div>
      </header>

      <div className="annotation-main">
        <div className="annotation-left-panel">
          <div className="tool-section" style={{ display: 'flex', alignItems: 'center' }} />
        </div>

        <div className="annotation-center-panel">
          <div className="canvas-area">
            <div className="image-container" style={{ width: '100%', height: '100%' }}>
              <div ref={viewportRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
                {(showRgbLayer || showMaskLayer) && (
                  <img
                    src={toAbsoluteUrl(currentImage.url) || currentImage.url}
                    alt={currentImage.originalName || currentImage.filename}
                    className="annotation-image"
                    ref={rgbImageElRef}
                    style={{ position: 'absolute', inset: 0, margin: 'auto', zIndex: 10, opacity: showRgbLayer ? 1 : 0 }}
                    onLoad={(e) => {
                      const w = e.currentTarget?.naturalWidth;
                      const h = e.currentTarget?.naturalHeight;
                      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                        setIntrinsicImageSize({ width: w as number, height: h as number });
                      }
                    }}
                  />
                )}

                {showMaskLayer && maskOverlayData && maskOverlayData.length > 0 && (
                  <svg
                    style={{
                      position: 'absolute',
                      left: imageDisplayRect?.left ?? 0,
                      top: imageDisplayRect?.top ?? 0,
                      width: imageDisplayRect?.width ?? '100%',
                      height: imageDisplayRect?.height ?? '100%',
                      pointerEvents: 'none',
                      zIndex: 40,
                    }}
                    viewBox={`0 0 ${maskViewW} ${maskViewH}`}
                    preserveAspectRatio="none"
                  >
                    {maskOverlayData.map((m) => {
                      if (!m.points || m.points.length < 6) return null;
                      const points = m.points
                        .reduce<string[]>((acc, _v, idx, arr) => {
                          if (idx % 2 !== 0) return acc;
                          const x = Number(arr[idx]);
                          const y = Number(arr[idx + 1]);
                          if (!Number.isFinite(x) || !Number.isFinite(y)) return acc;
                          acc.push(`${x},${y}`);
                          return acc;
                        }, [])
                        .join(' ');
                      const color = m.color || '#22c55e';
                      const opacity = typeof m.opacity === 'number' ? m.opacity : 0.35;
                      return <polygon key={m.id} points={points} fill={color} fillOpacity={opacity} stroke={color} strokeWidth={1} />;
                    })}
                  </svg>
                )}

                {showDepthLayer &&
                  selectedDepth &&
                  (selectedDepth.modality === 'depth_png' || (selectedDepth.url || '').toLowerCase().endsWith('.png')) && (
                    <img
                      src={toAbsoluteUrl(selectedDepth.url) || selectedDepth.url}
                      alt={selectedDepth.originalName || selectedDepth.filename}
                      style={{
                        position: 'absolute',
                        left: imageDisplayRect?.left ?? 0,
                        top: imageDisplayRect?.top ?? 0,
                        width: imageDisplayRect?.width ?? '100%',
                        height: imageDisplayRect?.height ?? '100%',
                        objectFit: 'fill',
                        opacity: Math.max(0, Math.min(1, depthOpacity)),
                        mixBlendMode: depthBlendMode,
                        pointerEvents: 'none',
                        zIndex: 20,
                      }}
                    />
                  )}

                <PoseFitLayer
                  enabled={showFitLayer}
                  overlayUrl={fitOverlayUrl}
                  imageDisplayRect={imageDisplayRect}
                  opacity={0.92}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="annotation-right-panel">
          <div className="properties-panel">
            <h3>属性面板</h3>

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div className={`layer-item ${showRgbLayer ? 'active' : ''}`} onClick={() => setShowRgbLayer((v) => !v)} title="RGB 图层">
                  <span>RGB 图层</span>
                  <span className="layer-visible">{showRgbLayer ? '👁️' : '🚫'}</span>
                </div>

                <div className={`layer-item ${showMaskLayer ? 'active' : ''}`} onClick={() => setShowMaskLayer((v) => !v)} title="Mask 图层">
                  <span>Mask 图层</span>
                  <span className="layer-visible">{showMaskLayer ? '👁️' : '🚫'}</span>
                </div>

                <div className={`layer-item ${showDepthLayer ? 'active' : ''}`} onClick={() => setShowDepthLayer((v) => !v)} title="深度图层">
                  <span>深度图层</span>
                  <span className="layer-visible">{showDepthLayer ? '👁️' : '🚫'}</span>
                </div>

                <div className={`layer-item ${showFitLayer ? 'active' : ''}`} onClick={() => setShowFitLayer((v) => !v)} title="拟合图层（Diff-DOPE）">
                  <span>拟合图层</span>
                  <span className="layer-visible">{showFitLayer ? '👁️' : '🚫'}</span>
                </div>
              </div>

              {showFitLayer && !fitOverlayUrl && (
                <div style={{ marginTop: '0.55rem', fontSize: '0.8rem', color: '#6c757d' }}>
                  当前图片暂无拟合效果图。请先在 Pose 页面点击“AI 6D姿态标注”。
                </div>
              )}

              {showDepthLayer && (
                <div style={{ marginTop: '0.75rem' }}>
                  {selectedDepth && (
                    <div style={{ marginBottom: '0.6rem', fontSize: '0.8rem', color: '#6c757d' }}>
                      当前深度：{(selectedDepth.role ? `[${selectedDepth.role}] ` : '') + (selectedDepth.originalName || selectedDepth.filename)}
                    </div>
                  )}
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '0.85rem', color: '#495057', fontWeight: 600 }}>叠加透明度</div>
                      <div style={{ fontSize: '0.8rem', color: '#6c757d' }}>{Math.round(depthOpacity * 100)}%</div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={depthOpacity}
                      onChange={(e) => setDepthOpacity(Number(e.target.value))}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PoseManualAnnotation;
