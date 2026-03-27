import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image, Mask } from '../../types';
import { setCurrentImage } from '../../store/annotationSlice';
import { authApi, depthApi, annotationApi, pose9dApi } from '../../services/api';
import { getStoredCurrentProject } from '../../utils/tabStorage';
import { toAbsoluteUrl } from '../../utils/urls';
import { useAppAlert } from '../common/AppAlert';
import { useProjectSessionGuard } from '../../utils/projectSessionGuard';
import '../2d/2DManualAnnotation.css';
import PoseFitLayer from './PoseFitLayer';
import PosePointCloudLayer from './PosePointCloudLayer';

type DepthInfo = {
  id: number;
  filename: string;
  url: string;
  depthRawFixUrl?: string | null;
  depthPngFixUrl?: string | null;
  modality?: string;
  role?: string;
};

const PoseManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { alert } = useAppAlert();
  const { currentImage, images } = useSelector((state: any) => state.annotation);
  const projectId = getStoredCurrentProject<any>()?.id;
  useProjectSessionGuard(projectId ? Number(projectId) : null, !!projectId);

  const [showRgbLayer, setShowRgbLayer] = useState(true);
  const [showDepthRawLayer, setShowDepthRawLayer] = useState(false);
  const [showDepthFixLayer, setShowDepthFixLayer] = useState(false);
  const [showMaskLayer, setShowMaskLayer] = useState(false);
  const [showFitLayer, setShowFitLayer] = useState(false);
  const [showPointCloudRawLayer, setShowPointCloudRawLayer] = useState(false);
  const [showPointCloudFixLayer, setShowPointCloudFixLayer] = useState(false);
  const [pointCloudSaveRequestId, setPointCloudSaveRequestId] = useState(0);
  const [pointCloudSaveDoneRequestId, setPointCloudSaveDoneRequestId] = useState(0);
  const [pointCloudInitSaveRequestId, setPointCloudInitSaveRequestId] = useState(0);
  const [pointCloudCancelInitRequestId, setPointCloudCancelInitRequestId] = useState(0);
  const [pointCloudClear6dRequestId, setPointCloudClear6dRequestId] = useState(0);

  const [maskOverlayData, setMaskOverlayData] = useState<Mask[] | null>(null);
  const [maskOverlayLoading, setMaskOverlayLoading] = useState(false);
  const [fitOverlayLoading, setFitOverlayLoading] = useState(false);
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

  const depthMode: 'raw' | 'fix' = showDepthFixLayer ? 'fix' : 'raw';
  const pointCloudMode: 'raw' | 'fix' = showPointCloudFixLayer ? 'fix' : 'raw';

  const hasAnyDepthFix = depthList.some((d: any) => !!(d?.depthPngFixUrl || d?.depthRawFixUrl));

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
    if (!currentImage?.id || !showFitLayer) {
      setFitOverlayLoading(false);
      return;
    }
    setFitOverlayLoading(true);
    (async () => {
      const reqId = ++fitOverlayReqIdRef.current;
      try {
        const resp = await pose9dApi.listPose9D(currentImage.id);
        if (reqId !== fitOverlayReqIdRef.current) return;
        const poses = Array.isArray(resp?.poses) ? resp.poses : [];
        const withFitPath = poses.find(
          (p: any) =>
            (typeof p?.fitOverlayPath === 'string' && p.fitOverlayPath.trim().length > 0) ||
            (typeof p?.fit_overlay_path === 'string' && p.fit_overlay_path.trim().length > 0),
        );
        const fitPath = withFitPath?.fitOverlayPath || withFitPath?.fit_overlay_path || null;
        const abs = fitPath ? (toAbsoluteUrl(fitPath) || fitPath) : null;
        // 避免浏览器对同名 png 的缓存，确保每次保存后能看到最新合成结果。
        setFitOverlayUrl(abs ? `${abs}?_fit=${reqId}` : null);
      } catch (e) {
        if (reqId !== fitOverlayReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 加载拟合图层失败:', e);
        setFitOverlayUrl(null);
      } finally {
        if (reqId === fitOverlayReqIdRef.current) setFitOverlayLoading(false);
      }
    })();
  }, [currentImage?.id, showFitLayer, pointCloudClear6dRequestId, pointCloudSaveDoneRequestId]);

  useEffect(() => {
    if (!currentImage?.id || !showMaskLayer) {
      setMaskOverlayLoading(false);
      return;
    }
    setMaskOverlayLoading(true);
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
      } finally {
        if (reqId === maskFetchReqIdRef.current) setMaskOverlayLoading(false);
      }
    })();
  }, [currentImage?.id, showMaskLayer]);

  useEffect(() => {
    // Always preload depth list for current image so "修" availability is accurate
    // even before user opens depth/point-cloud layers.
    if (!currentImage?.id || !projectId) return;
    (async () => {
      const reqId = ++depthFetchReqIdRef.current;
      try {
        const list = await depthApi.getDepth(projectId, currentImage.id);
        if (reqId !== depthFetchReqIdRef.current) return;
        setDepthList(list);
        const firstPng = list.find(
          (d) => d.modality === 'depth_png' || String(d.filename).toLowerCase().endsWith('.png'),
        );
        setSelectedDepthId(firstPng ? Number((firstPng as any).id) : list[0] ? Number((list[0] as any).id) : null);
      } catch (e) {
        if (reqId !== depthFetchReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 加载深度列表失败:', e);
        setDepthList([]);
        setSelectedDepthId(null);
      }
    })();
  }, [currentImage?.id, projectId]);

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
  }, [showRgbLayer, showMaskLayer, showDepthRawLayer, showDepthFixLayer, showFitLayer, currentImage?.id]);

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

  const pointCloudOn = showPointCloudRawLayer || showPointCloudFixLayer;
  const depthCanOverlayPng =
    !!selectedDepth &&
    (selectedDepth.modality === 'depth_png' || String(selectedDepth.url || '').toLowerCase().endsWith('.png'));

  const resourceHintLines: string[] = [];
  if (!pointCloudOn) {
    if (showMaskLayer && !maskOverlayLoading) {
      const hasMask = Array.isArray(maskOverlayData) && maskOverlayData.length > 0;
      if (!hasMask) {
        resourceHintLines.push('缺少 Mask：当前图暂无 2D Mask，请先在 2D 模块完成分割标注。');
      }
    }
    if (showFitLayer && !fitOverlayLoading && !fitOverlayUrl) {
      resourceHintLines.push('缺少拟合图：请先在 Pose 页执行「AI 6D姿态标注」生成效果图。');
    }
    if (showDepthRawLayer || showDepthFixLayer) {
      if (depthList.length === 0) {
        resourceHintLines.push('缺少深度：请上传与本图对应的 depth 与相机内参。');
      } else if (!depthCanOverlayPng) {
        resourceHintLines.push(
          '无法叠加深度图：当前选中条目没有可用的 PNG 深度，请上传 depth_png 或改用点云图层。',
        );
      }
    }
  }

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

                {(showDepthRawLayer || showDepthFixLayer) &&
                  selectedDepth &&
                  (selectedDepth.modality === 'depth_png' || (selectedDepth.url || '').toLowerCase().endsWith('.png')) && (
                    <img
                      src={(() => {
                        const rawUrl = selectedDepth.url;
                        const fixUrl = (selectedDepth as any).depthPngFixUrl || null;
                        const chosen = depthMode === 'fix' ? (fixUrl || rawUrl) : rawUrl;
                        return toAbsoluteUrl(chosen) || chosen;
                      })()}
                      alt={selectedDepth.filename}
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
                        zIndex: 30,
                      }}
                    />
                  )}

                <PoseFitLayer
                  enabled={showFitLayer}
                  overlayUrl={fitOverlayUrl}
                  imageDisplayRect={imageDisplayRect}
                  opacity={0.92}
                />

                {resourceHintLines.length > 0 && (
                  <div className="pose-manual-resource-hint" aria-live="polite">
                    <div className="pose-manual-resource-hint-inner">
                      {resourceHintLines.length === 1 ? (
                        <p className="pose-manual-resource-hint-text">{resourceHintLines[0]}</p>
                      ) : (
                        <ul className="pose-manual-resource-hint-list">
                          {resourceHintLines.map((t, i) => (
                            <li key={i}>{t}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <PosePointCloudLayer
            visible={showPointCloudRawLayer || showPointCloudFixLayer}
            projectId={projectId ? Number(projectId) : null}
            imageId={currentImage?.id ? Number(currentImage.id) : null}
            depthMode={pointCloudMode}
            saveRequestId={pointCloudSaveRequestId}
            saveInitialRequestId={pointCloudInitSaveRequestId}
            cancelInitialRequestId={pointCloudCancelInitRequestId}
            clear6dRequestId={pointCloudClear6dRequestId}
            onSaveFinalPoseComplete={(ok) => {
              void alert(ok ? '保存位置完成：已保存当前图内所有实例的最终位姿。' : '保存位置失败：请检查点云状态后重试。');
              // 不管 ok 与否，都触发一次重新拉取：如果服务端合成耗时，这能最大概率拉到新结果。
              setPointCloudSaveDoneRequestId((v) => v + 1);
            }}
          />

          {pointCloudOn && depthList.length === 0 && (
            <div className="pose-manual-resource-hint pose-manual-resource-hint--pointcloud" aria-live="polite">
              <div className="pose-manual-resource-hint-inner">
                <p className="pose-manual-resource-hint-text">
                  缺少深度数据，无法加载点云。请在 Pose 页为本图上传 depth_raw / depth_png 及 intrinsics。
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="annotation-right-panel">
          <div className="properties-panel">
            <h3>属性面板</h3>

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div
                  className={`layer-item ${showRgbLayer ? 'active' : ''}`}
                  onClick={() => {
                    setShowPointCloudRawLayer(false);
                    setShowPointCloudFixLayer(false);
                    setShowRgbLayer((v) => !v);
                  }}
                  title="RGB 图层"
                >
                  <span>RGB 图层</span>
                  <span className="layer-visible">{showRgbLayer ? '👁️' : '🚫'}</span>
                </div>

                <div
                  className={`layer-item ${showMaskLayer ? 'active' : ''}`}
                  onClick={() => {
                    setShowPointCloudRawLayer(false);
                    setShowPointCloudFixLayer(false);
                    setShowMaskLayer((v) => !v);
                  }}
                  title="Mask 图层"
                >
                  <span>Mask 图层</span>
                  <span className="layer-visible">{showMaskLayer ? '👁️' : '🚫'}</span>
                </div>

                <div
                  className={`layer-item ${showFitLayer ? 'active' : ''}`}
                  onClick={() => {
                    setShowPointCloudRawLayer(false);
                    setShowPointCloudFixLayer(false);
                    setShowFitLayer((v) => !v);
                  }}
                  title="拟合图层（Diff-DOPE）"
                >
                  <span>拟合图层</span>
                  <span className="layer-visible">{showFitLayer ? '👁️' : '🚫'}</span>
                </div>

                <div
                  className={`layer-item layer-item-split ${(showDepthRawLayer || showDepthFixLayer) ? 'active' : ''} ${
                    showDepthFixLayer ? 'split-state-fix' : showDepthRawLayer ? 'split-state-raw' : 'split-state-off'
                  }`}
                  onClick={() => {
                    setShowPointCloudRawLayer(false);
                    setShowPointCloudFixLayer(false);
                    if (!showDepthRawLayer && !showDepthFixLayer) {
                      setShowDepthRawLayer(true);
                      return;
                    }
                    if (showDepthRawLayer) {
                      if (hasAnyDepthFix) {
                        setShowDepthRawLayer(false);
                        setShowDepthFixLayer(true);
                        return;
                      }
                      setShowDepthRawLayer(false);
                      return;
                    }
                    if (showDepthFixLayer) {
                      setShowDepthFixLayer(false);
                    }
                  }}
                  title="深度图层"
                >
                  <span>深度图层</span>
                  <span className="layer-split-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`layer-split-btn ${showDepthRawLayer ? 'active' : ''}`}
                      onClick={() => {
                        setShowPointCloudRawLayer(false);
                        setShowPointCloudFixLayer(false);
                        setShowDepthFixLayer(false);
                        setShowDepthRawLayer((v) => !v);
                      }}
                      title="原深度信息"
                    >
                      原 {showDepthRawLayer ? '👁️' : '🚫'}
                    </button>
                    <button
                      type="button"
                      className={`layer-split-btn ${showDepthFixLayer ? 'active' : ''}`}
                      onClick={() => {
                        if (!hasAnyDepthFix) return;
                        setShowPointCloudRawLayer(false);
                        setShowPointCloudFixLayer(false);
                        setShowDepthRawLayer(false);
                        setShowDepthFixLayer((v) => !v);
                      }}
                      disabled={!hasAnyDepthFix}
                      title={hasAnyDepthFix ? '修复深度信息' : '暂无修复深度信息（未生成 *_fix）'}
                    >
                      修 {showDepthFixLayer ? '👁️' : '🚫'}
                    </button>
                  </span>
                </div>

                <div
                  className={`layer-item layer-item-split ${(showPointCloudRawLayer || showPointCloudFixLayer) ? 'active' : ''} ${
                    showPointCloudFixLayer ? 'split-state-fix' : showPointCloudRawLayer ? 'split-state-raw' : 'split-state-off'
                  }`}
                  onClick={() => {
                    const toggleTo = (mode: 'off' | 'raw' | 'fix') => {
                      if (mode === 'off') {
                        setShowPointCloudRawLayer(false);
                        setShowPointCloudFixLayer(false);
                        return;
                      }
                      if (mode === 'raw') {
                        setShowPointCloudFixLayer(false);
                        setShowPointCloudRawLayer(true);
                        return;
                      }
                      if (mode === 'fix') {
                        setShowPointCloudRawLayer(false);
                        setShowPointCloudFixLayer(true);
                      }
                    };

                    // cycle: off -> raw -> fix (if available) -> off
                    if (!showPointCloudRawLayer && !showPointCloudFixLayer) {
                      toggleTo('raw');
                    } else if (showPointCloudRawLayer) {
                      if (hasAnyDepthFix) toggleTo('fix');
                      else toggleTo('off');
                    } else if (showPointCloudFixLayer) {
                      toggleTo('off');
                    }

                    // point cloud on: auto hide other layers
                    const nextOn = (!showPointCloudRawLayer && !showPointCloudFixLayer) || showPointCloudRawLayer || showPointCloudFixLayer;
                    if (nextOn) {
                      setShowRgbLayer(false);
                      setShowMaskLayer(false);
                      setShowDepthRawLayer(false);
                      setShowDepthFixLayer(false);
                      setShowFitLayer(false);
                    }
                  }}
                  title="点云图层（深度点云 + Mesh）"
                >
                  <span>点云图层</span>
                  <span className="layer-split-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`layer-split-btn ${showPointCloudRawLayer ? 'active' : ''}`}
                      onClick={() => {
                        setShowPointCloudFixLayer(false);
                        setShowPointCloudRawLayer((prev) => {
                          const next = !prev;
                          if (next) {
                            setShowRgbLayer(false);
                            setShowMaskLayer(false);
                            setShowDepthRawLayer(false);
                            setShowDepthFixLayer(false);
                            setShowFitLayer(false);
                          }
                          return next;
                        });
                      }}
                      title="原深度点云"
                    >
                      原 {showPointCloudRawLayer ? '👁️' : '🚫'}
                    </button>
                    <button
                      type="button"
                      className={`layer-split-btn ${showPointCloudFixLayer ? 'active' : ''}`}
                      onClick={() => {
                        if (!hasAnyDepthFix) return;
                        setShowPointCloudRawLayer(false);
                        setShowPointCloudFixLayer((prev) => {
                          const next = !prev;
                          if (next) {
                            setShowRgbLayer(false);
                            setShowMaskLayer(false);
                            setShowDepthRawLayer(false);
                            setShowDepthFixLayer(false);
                            setShowFitLayer(false);
                          }
                          return next;
                        });
                      }}
                      disabled={!hasAnyDepthFix}
                      title={hasAnyDepthFix ? '修复深度点云' : '暂无修复深度信息（未生成 *_fix）'}
                    >
                      修 {showPointCloudFixLayer ? '👁️' : '🚫'}
                    </button>
                  </span>
                </div>
              </div>

              {showFitLayer && !fitOverlayUrl && (
                <div style={{ marginTop: '0.55rem', fontSize: '0.8rem', color: '#6c757d' }}>
                  当前图片暂无拟合效果图。请先在 Pose 页面点击“AI 6D姿态标注”。
                </div>
              )}

              {(showDepthRawLayer || showDepthFixLayer) && (
                <div style={{ marginTop: '0.75rem' }}>
                  {selectedDepth && (
                    <div style={{ marginBottom: '0.6rem', fontSize: '0.8rem', color: '#6c757d' }}>
                      当前深度（{depthMode === 'fix' ? '修复' : '原始'}）：
                      {(selectedDepth.role ? `[${selectedDepth.role}] ` : '') + selectedDepth.filename}
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

            {(showPointCloudRawLayer || showPointCloudFixLayer) && (
              <div className="property-section">
                <h4>点云操作</h4>
                <div
                  className="save-row"
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}
                >
                  {/* 第 1 行：人工初始位姿相关 */}
                  <div style={{ display: 'flex', gap: '0.55rem', width: '100%' }}>
                    <button
                      type="button"
                      className="primary-button"
                      style={{
                        background: '#ef4444',
                        borderColor: '#dc2626',
                        flex: 1,
                        height: '47px',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => setPointCloudCancelInitRequestId((v) => v + 1)}
                      title="删除当前点云窗口中选中 Mesh 的人工初始位姿"
                    >
                      取消初始位姿
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      style={{
                        background: '#16a34a',
                        borderColor: '#15803d',
                        flex: 1,
                        height: '47px',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => setPointCloudInitSaveRequestId((v) => v + 1)}
                      title="保存当前点云窗口中选中 Mesh 的人工初始位姿"
                    >
                      保存初始位姿
                    </button>
                  </div>

                  {/* 第 2 行：最终位姿保存 / 清除 */}
                  <div style={{ display: 'flex', gap: '0.55rem', width: '100%' }}>
                    <button
                      type="button"
                      className="primary-button"
                      style={{
                        background: '#f59e0b',
                        borderColor: '#d97706',
                        flex: 1,
                        height: '47px',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => setPointCloudSaveRequestId((v) => v + 1)}
                      title="保存当前点云窗口中的 Mesh 位姿矩阵到数据库（保存图内所有最终位姿）"
                    >
                      保存位置
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      style={{
                        background: '#ef4444',
                        borderColor: '#dc2626',
                        flex: 1,
                        height: '47px',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => setPointCloudClear6dRequestId((v) => v + 1)}
                      title="清除本图内所有 6D 姿态标注（删除 diffdope_json 与 initial_pose_json）"
                    >
                      清除本图 6D 标注
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PoseManualAnnotation;
