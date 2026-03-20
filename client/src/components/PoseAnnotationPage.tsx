import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setCurrentImage, setError, setImages, setLoading } from '../store/annotationSlice';
import { authApi, imageApi, meshApi } from '../services/api';
import type { Image } from '../types';
import { clearStoredCurrentProject, getStoredCurrentProject } from '../tabStorage';
import { toAbsoluteUrl } from '../utils/urls';
import MeshUploader from './MeshUploader';
import DepthUploader from './DepthUploader';
// @ts-ignore: MeshPreview3D is a TSX React component resolved by bundler
import MeshPreview3D from './MeshPreview3D';
// @ts-ignore: MeshThumbnail is a TSX React component resolved by bundler
import MeshThumbnail from './MeshThumbnail';
import './AnnotationPage.css';
// Pose6D overlay cache is handled inside `Pose6dEstimateButton`
import PoseInitialPoseButton from './PoseInitialPoseButton';
import Pose6dEstimateButton from './Pose6dEstimateButton';

const PoseAnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { images, loading, error } = useSelector((state: any) => state.annotation);

  const [currentProject, setCurrentProject] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [hasProjectAccess, setHasProjectAccess] = useState(false);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<Image | null>(null);
  const [selectedPreviewMesh, setSelectedPreviewMesh] = useState<{
    id?: number;
    filename: string;
    originalName: string;
    url: string;
    assetDirUrl?: string;
    assets?: string[];
    skuLabel?: string | null;
  } | null>(null);
  const [imageCacheBust, setImageCacheBust] = useState(0);
  const [bottomViewMode, setBottomViewMode] = useState<'images' | 'meshes'>('images');
  const [projectMeshes, setProjectMeshes] = useState<
    Array<{
      id?: number;
      filename: string;
      originalName: string;
      url: string;
      assetDirUrl?: string;
      assets?: string[];
      skuLabel?: string | null;
    }>
  >([]);
  const [meshSkuDraft, setMeshSkuDraft] = useState<string>('');
  const [meshSkuSaving, setMeshSkuSaving] = useState(false);
  const [meshPreviewTextureEnabled, setMeshPreviewTextureEnabled] = useState(true);
  const [meshPreviewDims, setMeshPreviewDims] = useState<{ x: number; y: number; z: number } | null>(null);
  const [projectLabelOptions, setProjectLabelOptions] = useState<Array<{ label: string; color: string }>>([]);
  const [pose6dOverlay, setPose6dOverlay] = useState<{
    imageId: number;
    meshId: number;
    label?: string | null;
    overlayRgbPngB64?: string;
    overlayDepthPngB64?: string;
    lossPlotPngB64?: string;
    error?: string | null;
    timingSec?: number | null;
    savedAt: string;
  } | null>(null);
  const [showPoseFitParamModal, setShowPoseFitParamModal] = useState(false);
  const DEFAULT_DIFFDOPE_PARAMS = useMemo(
    () => ({
      iters: 60,
      batchSize: 8,
      lrLow: 0.01,
      lrHigh: 100,
      baseLr: 20,
      lrDecay: 0.1,
      useMaskLoss: true,
      useDepthLoss: true,
      useRgbLoss: false,
      weightMask: 1,
      weightDepth: 1,
      weightRgb: 0.7,
      returnDebugImages: true,
    }),
    [],
  );
  const [diffDopeParams, setDiffDopeParams] = useState<{
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
  }>(DEFAULT_DIFFDOPE_PARAMS);
  const [poseFitParams, setPoseFitParams] = useState<{
    zMin: number;
    zMax: number;
    zStep: number;
    xMin: number;
    xMax: number;
    xStep: number;
    yMin: number;
    yMax: number;
    yStep: number;
    rasterSize: number;
    minIou: number;
    projectionDetail: 'fast' | 'balanced' | 'high';
  }>({
    zMin: -60,
    zMax: 60,
    zStep: 5,
    xMin: -20,
    xMax: 20,
    xStep: 10,
    yMin: -20,
    yMax: 20,
    yStep: 10,
    rasterSize: 256,
    minIou: 0.85,
    projectionDetail: 'balanced',
  });

  // 加载当前项目的 pose-fit 参数
  useEffect(() => {
    if (!currentProject?.id) {
      setPoseFitParams({
        zMin: -60,
        zMax: 60,
        zStep: 5,
        xMin: -20,
        xMax: 20,
        xStep: 10,
        yMin: -20,
        yMax: 20,
        yStep: 10,
        rasterSize: 256,
        minIou: 0.85,
        projectionDetail: 'balanced',
      });
      return;
    }
    const key = `poseFitParams:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const js = JSON.parse(raw) as Partial<typeof poseFitParams>;
      setPoseFitParams((prev) => ({
        zMin: typeof js.zMin === 'number' ? js.zMin : prev.zMin,
        zMax: typeof js.zMax === 'number' ? js.zMax : prev.zMax,
        zStep: typeof js.zStep === 'number' ? js.zStep : prev.zStep,
        xMin: typeof js.xMin === 'number' ? js.xMin : prev.xMin,
        xMax: typeof js.xMax === 'number' ? js.xMax : prev.xMax,
        xStep: typeof js.xStep === 'number' ? js.xStep : prev.xStep,
        yMin: typeof js.yMin === 'number' ? js.yMin : prev.yMin,
        yMax: typeof js.yMax === 'number' ? js.yMax : prev.yMax,
        yStep: typeof js.yStep === 'number' ? js.yStep : prev.yStep,
        rasterSize: typeof js.rasterSize === 'number' ? js.rasterSize : prev.rasterSize,
        minIou:
          typeof js.minIou === 'number' && Number.isFinite(js.minIou) ? Math.max(0, Math.min(1, js.minIou)) : prev.minIou,
        projectionDetail:
          js.projectionDetail === 'fast' || js.projectionDetail === 'balanced' || js.projectionDetail === 'high'
            ? js.projectionDetail
            : prev.projectionDetail,
      }));
    } catch (e) {
      console.warn('[PoseAnnotationPage] 读取 poseFitParams 失败，将使用默认值:', e);
    }
  }, [currentProject?.id]);

  // 加载当前项目的 diffdope 参数（用于 6D 姿态推测）
  useEffect(() => {
    if (!currentProject?.id) return;
    const key = `diffDopeParams:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const js = JSON.parse(raw) as Partial<typeof diffDopeParams>;
      setDiffDopeParams((prev) => ({
        iters: typeof js.iters === 'number' && Number.isFinite(js.iters) ? Math.max(1, Math.min(500, Math.round(js.iters))) : prev.iters,
        batchSize:
          typeof js.batchSize === 'number' && Number.isFinite(js.batchSize) ? Math.max(1, Math.min(64, Math.round(js.batchSize))) : prev.batchSize,
        lrLow: typeof js.lrLow === 'number' && Number.isFinite(js.lrLow) ? Math.max(1e-6, js.lrLow) : prev.lrLow,
        lrHigh: typeof js.lrHigh === 'number' && Number.isFinite(js.lrHigh) ? Math.max(1e-6, js.lrHigh) : prev.lrHigh,
        baseLr: typeof js.baseLr === 'number' && Number.isFinite(js.baseLr) ? Math.max(1e-6, js.baseLr) : prev.baseLr,
        lrDecay: typeof js.lrDecay === 'number' && Number.isFinite(js.lrDecay) ? Math.max(1e-6, js.lrDecay) : prev.lrDecay,
        useMaskLoss: typeof js.useMaskLoss === 'boolean' ? js.useMaskLoss : prev.useMaskLoss,
        useDepthLoss: typeof js.useDepthLoss === 'boolean' ? js.useDepthLoss : prev.useDepthLoss,
        useRgbLoss: typeof js.useRgbLoss === 'boolean' ? js.useRgbLoss : prev.useRgbLoss,
        weightMask: typeof js.weightMask === 'number' && Number.isFinite(js.weightMask) ? Math.max(0, js.weightMask) : prev.weightMask,
        weightDepth: typeof js.weightDepth === 'number' && Number.isFinite(js.weightDepth) ? Math.max(0, js.weightDepth) : prev.weightDepth,
        weightRgb: typeof js.weightRgb === 'number' && Number.isFinite(js.weightRgb) ? Math.max(0, js.weightRgb) : prev.weightRgb,
        returnDebugImages: typeof js.returnDebugImages === 'boolean' ? js.returnDebugImages : prev.returnDebugImages,
      }));
    } catch (e) {
      console.warn('[PoseAnnotationPage] 读取 diffDopeParams 失败，将使用默认值:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // const savePoseFitParamsToStorage = () => {
  //   if (!currentProject?.id) return;
  //   const key = `poseFitParams:${currentProject.id}`;
  //   try {
  //     localStorage.setItem(key, JSON.stringify(poseFitParams));
  //   } catch (e) {
  //     console.warn('[PoseAnnotationPage] 保存 poseFitParams 失败:', e);
  //   }
  // };

  // 从 2D 的 “Mask Label 对照表” 复用项目级 label 列表（localStorage: labelColorMap:${projectId}）
  useEffect(() => {
    if (!currentProject?.id) return;
    const key = `labelColorMap:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        setProjectLabelOptions([]);
        return;
      }
      const obj = JSON.parse(raw) as Record<string, string>;
      const pairs = Object.entries(obj)
        .map(([label, color]) => ({ label: (label || '').trim(), color: (color || '').trim() }))
        .filter((p) => p.label && p.color);
      pairs.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
      setProjectLabelOptions(pairs);
    } catch (e) {
      console.warn('[PoseAnnotationPage] 读取 labelColorMap 失败:', e);
      setProjectLabelOptions([]);
    }
  }, [currentProject?.id]);

  const selectedSkuColor = useMemo(() => {
    const label = (meshSkuDraft || '').trim();
    if (!label) return null;
    const hit = projectLabelOptions.find((p) => p.label === label);
    return hit?.color || null;
  }, [meshSkuDraft, projectLabelOptions]);

  const handlePreviewMeshNavigate = (direction: 'prev' | 'next') => {
    if (!selectedPreviewMesh?.id) return;
    const idx = projectMeshes.findIndex((m) => m.id === selectedPreviewMesh.id);
    if (idx < 0) return;
    const nextIdx = direction === 'prev' ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= projectMeshes.length) return;
    setSelectedPreviewMesh(projectMeshes[nextIdx] as any);
  };

  useEffect(() => {
    // 切换预览 Mesh 时同步 sku draft
    setMeshSkuDraft(String(selectedPreviewMesh?.skuLabel || ''));
    setMeshPreviewDims(null);
  }, [selectedPreviewMesh?.id]);

  const fmtMeters = (v: number) => {
    if (!Number.isFinite(v)) return '-';
    const n = Math.round(v * 100) / 100;
    return String(n).replace(/\.0$/, '');
  };

  const handleMeshPreviewBoundsChange = useCallback((size: { x: number; y: number; z: number } | null) => {
    setMeshPreviewDims(size);
  }, []);

  // 缩略图虚拟滚动（与 AnnotationPage 一致的思路：只渲染视口范围内）
  const thumbnailsScrollRef = useRef<HTMLDivElement | null>(null);
  const thumbnailsMeasureRef = useRef<HTMLDivElement | null>(null);
  const thumbScrollElRef = useRef<HTMLDivElement | null>(null);
  const thumbMeasureElRef = useRef<HTMLDivElement | null>(null);
  const thumbScrollRafRef = useRef<number | null>(null);
  const thumbViewportRafRef = useRef<number | null>(null);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewport, setThumbViewport] = useState({ width: 0, height: 0 });

  // 从当前标签页的 sessionStorage 恢复当前项目
  useEffect(() => {
    const savedProject = getStoredCurrentProject<any>();
    if (savedProject) {
      setCurrentProject(savedProject);
      return;
    }
    console.warn('PoseAnnotationPage: 未在当前标签页存储中找到当前项目');
  }, []);

  // 权限检查：确保用户已通过验证码或登录
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const authStatus = await authApi.checkAuth();
        setIsAdmin(!!authStatus.isAdmin);

        if (!authStatus.authenticated) {
          navigate('/');
          return;
        }

        const savedProject = getStoredCurrentProject<any>();
        if (!savedProject) {
          navigate('/');
          return;
        }

        // 管理员跳过项目访问校验；普通用户校验是否可访问该项目
        if (authStatus.isAdmin) {
          setHasProjectAccess(true);
        } else {
          try {
            const accessibleProjects = await authApi.getAccessibleProjects();
            const ok = accessibleProjects.some((p: any) => p?.id === savedProject.id);
            if (!ok) {
              alert('您没有访问该项目的权限，请重新输入验证码');
              clearStoredCurrentProject();
              navigate('/');
              return;
            }
            setHasProjectAccess(true);
          } catch (e) {
            // 查询失败不阻塞，但也不要提前拉取图片，避免产生 403 噪音
            console.warn('[PoseAnnotationPage] 获取可访问项目失败，暂不拉取图片:', e);
            setHasProjectAccess(false);
          }
        }
      } catch (e) {
        console.warn('[PoseAnnotationPage] 权限检查失败（网络错误不强制跳转）:', e);
        setHasProjectAccess(false);
      } finally {
        setAuthReady(true);
      }
    };
    checkAuth();
  }, [navigate]);

  // 仍然沿用“图片跟着项目走”的逻辑：进来时把项目图片列表加载出来（后续用于 pose 的 2D/深度对齐等）
  useEffect(() => {
    if (!currentProject?.id) return;
    if (!authReady) return;
    if (!hasProjectAccess) return;
    const loadImages = async () => {
      try {
        dispatch(setLoading(true));
        const loadedImages = await imageApi.getImages(currentProject.id);
        dispatch(setImages(loadedImages));
      } catch (err: any) {
        // 若遇到 403（权限问题），不再重复报错污染控制台，直接引导回主页
        if (err?.response?.status === 403) {
          console.warn('[PoseAnnotationPage] 无权限访问该项目图片，返回主页');
          clearStoredCurrentProject();
          navigate('/');
          return;
        }
        dispatch(setError(err?.message || '加载图像失败'));
      } finally {
        dispatch(setLoading(false));
      }
    };
    loadImages();
  }, [dispatch, currentProject?.id, authReady, hasProjectAccess, navigate]);

  // 加载项目 Mesh 列表（用于下方 Mesh 预览）
  useEffect(() => {
    if (!currentProject?.id) return;
    if (!authReady || !hasProjectAccess) return;
    if (bottomViewMode !== 'meshes') return;

    (async () => {
      try {
        const meshes = await meshApi.getMeshes(currentProject.id);
        setProjectMeshes(meshes || []);
      } catch (e) {
        console.warn('[PoseAnnotationPage] 加载项目 Mesh 列表失败:', e);
      }
    })();
  }, [currentProject?.id, authReady, hasProjectAccess, bottomViewMode]);

  useEffect(() => {
    // project 或图片列表变动时更新一次即可，避免每次 render 都触发图片重新请求
    setImageCacheBust((v) => (v + 1) % 1_000_000);
  }, [currentProject?.id, images.length]);

  useEffect(() => {
    // 切换底部视图时，清理另一个模式的选中态，避免右上预览混乱
    if (bottomViewMode === 'images') {
      setSelectedPreviewMesh(null);
    } else {
      setSelectedPreviewImage(null);
    }
  }, [bottomViewMode]);

  useEffect(() => {
    // 缩略图容器是条件渲染的，所以这里在依赖变化时重试挂载
    const scrollEl = thumbScrollElRef.current || thumbnailsScrollRef.current;
    const measureEl = thumbMeasureElRef.current || thumbnailsMeasureRef.current;
    if (!scrollEl || !measureEl) return;

    const updateViewport = () => {
      if (thumbViewportRafRef.current) cancelAnimationFrame(thumbViewportRafRef.current);
      thumbViewportRafRef.current = requestAnimationFrame(() => {
        const cs = window.getComputedStyle(measureEl);
        const padLeft = parseFloat(cs.paddingLeft || '0') || 0;
        const padRight = parseFloat(cs.paddingRight || '0') || 0;
        const contentW = Math.max(0, Math.round(scrollEl.clientWidth - padLeft - padRight));
        const contentH = Math.max(0, Math.round(scrollEl.clientHeight));

        setThumbViewport((prev) => (prev.width === contentW && prev.height === contentH ? prev : { width: contentW, height: contentH }));
        setThumbScrollTop(scrollEl.scrollTop || 0);
      });
    };

    updateViewport();

    const ro = new ResizeObserver(() => updateViewport());
    ro.observe(scrollEl);
    ro.observe(measureEl);

    return () => {
      ro.disconnect();
      if (thumbScrollRafRef.current) {
        cancelAnimationFrame(thumbScrollRafRef.current);
        thumbScrollRafRef.current = null;
      }
      if (thumbViewportRafRef.current) {
        cancelAnimationFrame(thumbViewportRafRef.current);
        thumbViewportRafRef.current = null;
      }
    };
  }, [currentProject?.id, images.length]);

  const THUMB_SIZE = 125;
  const THUMB_GAP = 16; // 对应 AnnotationPage.css 的 gap 风格
  const thumbStride = THUMB_SIZE + THUMB_GAP;

  const thumbCols = useMemo(() => {
    const w = thumbViewport.width;
    if (!w) return 1;
    return Math.max(1, Math.floor((w + THUMB_GAP) / thumbStride));
  }, [thumbViewport.width, thumbStride, THUMB_GAP]);

  const thumbTotalRows = useMemo(() => Math.ceil(images.length / thumbCols), [images.length, thumbCols]);
  const thumbTotalHeight = useMemo(() => {
    if (images.length === 0) return 0;
    return Math.max(0, thumbTotalRows * THUMB_SIZE + Math.max(0, thumbTotalRows - 1) * THUMB_GAP);
  }, [thumbTotalRows, images.length]);

  // Mesh 区域沿用同样的列数 / 缩略图尺寸，保证“同样的像素宽度，放置同样数量的模型”
  const meshTotalRows = useMemo(() => Math.ceil(projectMeshes.length / thumbCols), [projectMeshes.length, thumbCols]);
  const meshTotalHeight = useMemo(() => {
    if (projectMeshes.length === 0) return 0;
    return Math.max(0, meshTotalRows * THUMB_SIZE + Math.max(0, meshTotalRows - 1) * THUMB_GAP);
  }, [meshTotalRows, projectMeshes.length]);

  const virtualThumbRange = useMemo(() => {
    const viewH = thumbViewport.height || 0;
    const overscanRows = 2;
    const rowHeight = thumbStride;
    const startRow = Math.max(0, Math.floor((thumbScrollTop - overscanRows * rowHeight) / rowHeight));
    const endRow = Math.min(Math.max(0, thumbTotalRows - 1), Math.ceil((thumbScrollTop + viewH + overscanRows * rowHeight) / rowHeight));
    const startIndex = startRow * thumbCols;
    const endIndex = Math.min(images.length, (endRow + 1) * thumbCols);
    return { startIndex, endIndex };
  }, [thumbCols, thumbScrollTop, thumbTotalRows, thumbViewport.height, images.length, thumbStride]);

  const visibleThumbImages = useMemo(
    () => images.slice(virtualThumbRange.startIndex, virtualThumbRange.endIndex),
    [images, virtualThumbRange.startIndex, virtualThumbRange.endIndex]
  );

  const handlePreviewNavigate = (direction: 'prev' | 'next') => {
    if (!selectedPreviewImage || images.length === 0) return;
    const currentIndex = images.findIndex((img: Image) => img.id === selectedPreviewImage.id);
    if (currentIndex === -1) return;

    if (direction === 'prev') {
      if (currentIndex === 0) return;
      setSelectedPreviewImage(images[currentIndex - 1]);
    } else {
      if (currentIndex === images.length - 1) return;
      setSelectedPreviewImage(images[currentIndex + 1]);
    }
  };

  return (
    <div className="annotation-page">
      <header className="page-header">
        <div className="header-left">
          <button className="back-button" onClick={() => navigate('/')}>
            ← 返回主页
          </button>
          <h1>9D Pose 标注工作区</h1>
        </div>
        <div className="header-right">
          <span className="status">{loading ? '加载中...' : `${images.length} 张图片`}</span>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          错误: {error}
          <button onClick={() => dispatch(setError(null))}>×</button>
        </div>
      )}

      <div className="page-content">
        <div className="welcome-section">
          <div className="welcome-layout">
            {/* 左上：布局模仿 AnnotationPage，但内部功能先留空（只先放 Mesh 上传区） */}
            <div className="welcome-left-top">
              <div className="welcome-content">
                <div
                  style={{
                    display: 'flex',
                    gap: '0.75rem',
                    alignItems: 'stretch',
                    justifyContent: 'space-between',
                    minHeight: 130,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <DepthUploader projectId={currentProject?.id} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MeshUploader
                      projectId={currentProject?.id}
                      onUploadComplete={(meshes) => {
                        if (!meshes || meshes.length === 0) return;
                        setProjectMeshes((prev) => [...meshes, ...prev]);
                        if (bottomViewMode !== 'meshes') {
                          setBottomViewMode('meshes');
                        }
                      }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: '1rem', color: '#666', fontSize: '0.95rem' }}>
                  {/* UI 占位：批量 AI 标注 / 导入 / 导出（功能留空） */}
                  <div className="ai-section">
                    <div className="ai-controls">
                      <button
                        type="button"
                        className="ai-annotation-btn"
                        onClick={() => {
                          if (!currentProject) {
                            alert('请先选择项目');
                            return;
                          }
                          console.log('[PoseAnnotationPage][poseFitParams] open modal', { poseFitParams: { ...poseFitParams } });
                          setShowPoseFitParamModal(true);
                        }}
                      >
                        调整拟合参数
                      </button>
                      <button
                        type="button"
                        className="ai-annotation-btn"
                        onClick={() => alert('TODO：批量AI标注（Pose 页面占位）')}
                        title="占位：后续接入批量 Pose AI 标注流程"
                      >
                        🤖 批量AI标注
                      </button>
                      <div className="import-export-buttons">
                        <button
                          type="button"
                          className="ai-annotation-btn import-btn"
                          onClick={() => alert('TODO：导入标注（Pose 页面占位）')}
                          title="占位：后续接入导入 Pose 标注数据"
                        >
                          📤 导入标注 (JSON)
                        </button>
                        <button
                          type="button"
                          className="ai-annotation-btn export-btn"
                          onClick={() => alert('TODO：导出标注数据（Pose 页面占位）')}
                          title="占位：后续接入导出 Pose 标注数据"
                        >
                          📥 导出标注数据
                        </button>
                      </div>
                    </div>
                  </div>

                  {!isAdmin && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#888' }}>
                      当前为普通用户：可调整拟合参数，仅影响本项目的 pose 辅助效果。
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 右上：预览区占位（后续可用于显示 RGB/Depth/渲染叠加） */}
            <div className="welcome-right-top">
              {bottomViewMode === 'meshes' ? (
                selectedPreviewMesh ? (
                  <div className="image-preview-container">
                    <div className="preview-header">
                      <h3>{selectedPreviewMesh.originalName || selectedPreviewMesh.filename}</h3>
                      <button className="close-preview-btn" onClick={() => setSelectedPreviewMesh(null)}>
                        ×
                      </button>
                    </div>
                    <div className="image-preview-wrapper" style={{ position: 'relative' }}>
                      <div className="preview-image-layer" style={{ width: '100%', height: '100%' }}>
                        <MeshPreview3D
                          meshUrl={selectedPreviewMesh.url || null}
                          assetDirUrl={selectedPreviewMesh.assetDirUrl || undefined}
                          assets={selectedPreviewMesh.assets}
                          enableTexture={meshPreviewTextureEnabled}
                          onMeshBoundsChange={handleMeshPreviewBoundsChange}
                        />
                      </div>
                      {/* 左上角悬浮：贴图开关 */}
                      <button
                        type="button"
                        onClick={() => setMeshPreviewTextureEnabled((v) => !v)}
                        title={meshPreviewTextureEnabled ? '已加载贴图（点击关闭）' : '未加载贴图（点击开启）'}
                        style={{
                          position: 'absolute',
                          top: 10,
                          left: 10,
                          zIndex: 10,
                          padding: '0.35rem 0.55rem',
                          borderRadius: 10,
                          border: '1px solid rgba(255,255,255,0.18)',
                          background: meshPreviewTextureEnabled ? 'rgba(34,197,94,0.22)' : 'rgba(148,163,184,0.22)',
                          color: '#e5e7eb',
                          fontSize: '0.85rem',
                          cursor: 'pointer',
                          backdropFilter: 'blur(6px)',
                        }}
                      >
                        {meshPreviewTextureEnabled ? 'Texture: ON' : 'Texture: OFF'}
                      </button>
                      {/* 按钮下方：mesh 尺寸（xyz） */}
                      {meshPreviewDims && (
                        <div className="mesh-dims-panel" style={{ position: 'absolute', top: 48, left: 10, zIndex: 10 }}>
                          <div>长（x）：{fmtMeters(meshPreviewDims.x)} 米</div>
                          <div>高（y）：{fmtMeters(meshPreviewDims.y)} 米</div>
                          <div>宽（z）：{fmtMeters(meshPreviewDims.z)} 米</div>
                        </div>
                      )}
                    </div>
                    {/* 底部工具栏（Mesh 预览）- 样式对齐图片预览的 preview-actions */}
                    <div className="preview-actions">
                      <button
                        className="nav-image-btn prev-image-btn"
                        onClick={() => handlePreviewMeshNavigate('prev')}
                        disabled={
                          !selectedPreviewMesh?.id || projectMeshes.findIndex((m) => m.id === selectedPreviewMesh.id) <= 0
                        }
                      >
                        ← 上一个
                      </button>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                          <div style={{ color: '#666', fontSize: '0.9rem' }}>Label</div>
                          <span
                            title={selectedSkuColor ? `颜色：${selectedSkuColor}` : '未选择'}
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              background: selectedSkuColor || '#e5e7eb',
                              border: '1px solid rgba(0,0,0,0.12)',
                              display: 'inline-block',
                            }}
                          />
                          <select
                            value={meshSkuDraft}
                            onChange={(e) => setMeshSkuDraft(e.target.value)}
                            style={{
                              padding: '0.4rem 0.55rem',
                              borderRadius: 10,
                              border: '1px solid #d0d7e2',
                              minWidth: 220,
                              background: '#fff',
                              color: '#111',
                            }}
                            title="从 2D Mask Label 对照表中选择（不允许手动输入）"
                          >
                            <option value="" disabled>
                              请选择…
                            </option>
                            {projectLabelOptions.map((p) => (
                              <option key={p.label} value={p.label}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ background: '#16a34a', borderColor: '#15803d', color: '#fff' }}
                          disabled={!selectedPreviewMesh?.id || meshSkuSaving}
                          onClick={async () => {
                            if (!selectedPreviewMesh?.id) return;
                            try {
                              setMeshSkuSaving(true);
                              await meshApi.updateMesh(selectedPreviewMesh.id, { skuLabel: meshSkuDraft.trim() || null });
                              setProjectMeshes((prev) =>
                                prev.map((m) =>
                                  m.id === selectedPreviewMesh.id ? { ...m, skuLabel: meshSkuDraft.trim() || null } : m,
                                ),
                              );
                              setSelectedPreviewMesh((prev) =>
                                prev ? ({ ...prev, skuLabel: meshSkuDraft.trim() || null } as any) : prev,
                              );
                            } catch (e: any) {
                              console.error('[PoseAnnotationPage] 更新 Mesh SKU/Label 失败:', e);
                              alert(e?.message || '更新 SKU/Label 失败');
                            } finally {
                              setMeshSkuSaving(false);
                            }
                          }}
                          title="保存该 Mesh 的 SKU/Label 绑定（入库）"
                        >
                          {meshSkuSaving ? '保存中...' : '保存绑定'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ background: '#dc2626', borderColor: '#b91c1c', color: '#fff' }}
                          onClick={async () => {
                            if (!selectedPreviewMesh?.id) return;
                            const ok = window.confirm(`确定删除 Mesh：${selectedPreviewMesh.originalName || selectedPreviewMesh.filename} ？`);
                            if (!ok) return;
                            try {
                              await meshApi.deleteMesh(selectedPreviewMesh.id);
                              setProjectMeshes((prev) => prev.filter((m) => m.id !== selectedPreviewMesh.id));
                              setSelectedPreviewMesh(null);
                            } catch (e: any) {
                              console.error('[PoseAnnotationPage] 删除 Mesh 失败:', e);
                              alert(e?.message || '删除 Mesh 失败');
                            }
                          }}
                          title="删除该 Mesh（会同时删除其 9D Pose 记录）"
                        >
                          删除 Mesh
                        </button>
                      </div>

                      <button
                        className="nav-image-btn next-image-btn"
                        onClick={() => handlePreviewMeshNavigate('next')}
                        disabled={
                          !selectedPreviewMesh?.id ||
                          projectMeshes.findIndex((m) => m.id === selectedPreviewMesh.id) === projectMeshes.length - 1
                        }
                      >
                        下一个 →
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="no-preview-selected">
                    <div className="preview-placeholder">
                      <span className="preview-icon">🧊</span>
                      <p>点击下方 Mesh 缩略图进行预览</p>
                    </div>
                  </div>
                )
              ) : selectedPreviewImage ? (
                <div className="image-preview-container">
                  <div className="preview-header">
                    <h3>{selectedPreviewImage.originalName || selectedPreviewImage.filename}</h3>
                    <button className="close-preview-btn" onClick={() => setSelectedPreviewImage(null)}>
                      ×
                    </button>
                  </div>
                  <div className="image-preview-wrapper" style={{ position: 'relative' }}>
                    <div className="preview-image-layer" style={{ position: 'relative' }}>
                      <img
                        src={`${(toAbsoluteUrl(selectedPreviewImage.url) || selectedPreviewImage.url)}?v=${imageCacheBust}`}
                        alt={selectedPreviewImage.originalName || selectedPreviewImage.filename}
                        className="preview-image"
                      />
                    </div>

                    {/* Diff-DOPE overlay：直接叠在预览图上，立即验收对齐效果 */}
                    {pose6dOverlay &&
                      pose6dOverlay.imageId === Number(selectedPreviewImage.id) &&
                      pose6dOverlay.overlayRgbPngB64 && (
                        <img
                          src={`data:image/png;base64,${pose6dOverlay.overlayRgbPngB64}`}
                          alt="diffdope overlay"
                          className="preview-image"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            margin: 'auto',
                            zIndex: 26,
                            pointerEvents: 'none',
                            opacity: 0.98,
                          }}
                        />
                      )}

                    {/* 若没有 RGB overlay，但有 loss plot，也直接叠加显示（用于确认“确实跑完并产出了 debug”） */}
                    {pose6dOverlay &&
                      pose6dOverlay.imageId === Number(selectedPreviewImage.id) &&
                      !pose6dOverlay.overlayRgbPngB64 &&
                      pose6dOverlay.lossPlotPngB64 && (
                        <img
                          src={`data:image/png;base64,${pose6dOverlay.lossPlotPngB64}`}
                          alt="diffdope loss plot"
                          style={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            zIndex: 26,
                            width: 320,
                            height: 'auto',
                            borderRadius: 10,
                            border: '1px solid rgba(148,163,184,0.25)',
                            background: 'rgba(15,23,42,0.35)',
                            pointerEvents: 'none',
                          }}
                        />
                      )}

                    {/* Diff-DOPE overlay info + clear */}
                    {pose6dOverlay &&
                      pose6dOverlay.imageId === Number(selectedPreviewImage.id) &&
                      (pose6dOverlay.overlayRgbPngB64 || pose6dOverlay.lossPlotPngB64 || pose6dOverlay.error) && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 10,
                            left: 10,
                            zIndex: 27,
                            display: 'flex',
                            gap: '0.5rem',
                            alignItems: 'center',
                          }}
                        >
                          <div
                            style={{
                              padding: '0.35rem 0.55rem',
                              borderRadius: 10,
                              background: 'rgba(15,23,42,0.55)',
                              border: '1px solid rgba(148,163,184,0.25)',
                              color: '#e2e8f0',
                              fontSize: '0.82rem',
                              backdropFilter: 'blur(6px)',
                              maxWidth: 520,
                              lineHeight: 1.25,
                            }}
                          >
                            {`Diff-DOPE: ${
                              pose6dOverlay.meshId ? `meshId=${pose6dOverlay.meshId}` : '（无 meshId）'
                            }${pose6dOverlay.label ? ` label=${pose6dOverlay.label}` : ''}${
                              typeof pose6dOverlay.timingSec === 'number' ? ` time=${pose6dOverlay.timingSec.toFixed(2)}s` : ''
                            }${
                              pose6dOverlay.overlayRgbPngB64
                                ? '  overlay=RGB'
                                : pose6dOverlay.lossPlotPngB64
                                ? '  overlay=lossPlot(仅)'
                                : pose6dOverlay.error
                                ? `  overlay=无（${pose6dOverlay.error}）`
                                : ''
                            }`}
                          </div>
                          <button
                            type="button"
                            onClick={() => setPose6dOverlay(null)}
                            style={{
                              padding: '0.35rem 0.55rem',
                              borderRadius: 10,
                              border: '1px solid rgba(148,163,184,0.35)',
                              background: 'rgba(30,41,59,0.55)',
                              color: '#e2e8f0',
                              cursor: 'pointer',
                              backdropFilter: 'blur(6px)',
                              fontSize: '0.82rem',
                            }}
                            title="清除 overlay"
                          >
                            清除
                          </button>
                        </div>
                      )}

                  </div>
                  <div className="preview-actions">
                    <button
                      className="nav-image-btn prev-image-btn"
                      onClick={() => handlePreviewNavigate('prev')}
                      disabled={images.findIndex((img: Image) => img.id === selectedPreviewImage.id) <= 0}
                    >
                      ← 上一张
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ color: '#666', fontSize: '0.9rem' }}>
                        Pose 预览（后续将支持：mesh 渲染、深度叠加、姿态结果）
                      </div>
                      <PoseInitialPoseButton
                        projectId={currentProject?.id ?? null}
                        image={selectedPreviewImage}
                      />
                      <Pose6dEstimateButton
                        projectId={currentProject?.id ?? null}
                        image={selectedPreviewImage}
                        diffDopeParams={diffDopeParams}
                        setPose6dOverlay={setPose6dOverlay}
                      />
                      {selectedPreviewImage && (
                        <button
                          type="button"
                          className="start-annotation-btn"
                          onClick={() => {
                            dispatch(setCurrentImage(selectedPreviewImage));
                            navigate('/pose/manual-annotation');
                          }}
                        >
                          开始人工标注
                        </button>
                      )}
                    </div>
                    <button
                      className="nav-image-btn next-image-btn"
                      onClick={() => handlePreviewNavigate('next')}
                      disabled={images.findIndex((img: Image) => img.id === selectedPreviewImage.id) === images.length - 1}
                    >
                      下一张 →
                    </button>
                  </div>
                </div>
              ) : (
                <div className="no-preview-selected">
                  <div className="preview-placeholder">
                    <span className="preview-icon">🔍</span>
                    <p>点击下方缩略图查看图片预览</p>
                  </div>
                </div>
              )}
            </div>

            {/* 下方：沿用图片列表区域占位（后续可用于选择对应的 RGB/Depth） */}
            {currentProject && images.length > 0 && (
              <div className="welcome-bottom">
                <div className="uploaded-images-preview">
                  <div className="preview-header uploaded-preview-header">
                    <h3>
                      {bottomViewMode === 'images'
                        ? `项目图片（用于 Pose 对齐）(${images.length})`
                        : `项目 Mesh 资产（${projectMeshes.length})`}
                    </h3>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className={`nav-image-btn ${bottomViewMode === 'images' ? 'prev-image-btn' : ''}`}
                        style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }}
                        onClick={() => setBottomViewMode('images')}
                      >
                        图片
                      </button>
                      <button
                        type="button"
                        className={`nav-image-btn ${bottomViewMode === 'meshes' ? 'next-image-btn' : ''}`}
                        style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }}
                        onClick={() => setBottomViewMode('meshes')}
                      >
                        Mesh
                      </button>
                    </div>
                    <div className="project-info">
                      <span className="project-name">项目: {currentProject.name}</span>
                      <span className="project-id">ID: {currentProject.id}</span>
                    </div>
                  </div>

                  <div
                    className="thumbnails-grid thumbnails-virtual-scroll"
                    ref={(el) => {
                      thumbnailsScrollRef.current = el;
                      thumbScrollElRef.current = el;
                    }}
                    onScroll={(e) => {
                      const top = (e.currentTarget as HTMLDivElement).scrollTop;
                      if (thumbScrollRafRef.current) cancelAnimationFrame(thumbScrollRafRef.current);
                      thumbScrollRafRef.current = requestAnimationFrame(() => setThumbScrollTop(top));
                    }}
                  >
                    <div
                      className="thumbnails-virtual-measure"
                      ref={(el) => {
                        thumbnailsMeasureRef.current = el;
                        thumbMeasureElRef.current = el;
                      }}
                    >
                      {bottomViewMode === 'images' ? (
                        <div className="thumbnails-virtual-inner" style={{ height: thumbTotalHeight }}>
                          {visibleThumbImages.map((image: Image, i: number) => {
                            const absoluteIndex = virtualThumbRange.startIndex + i;
                            const row = Math.floor(absoluteIndex / thumbCols);
                            const col = absoluteIndex % thumbCols;
                            const top = row * (THUMB_SIZE + THUMB_GAP);
                            const left = col * (THUMB_SIZE + THUMB_GAP);

                            return (
                              <div
                                key={image.id}
                                className={`thumbnail-item-small ${selectedPreviewImage?.id === image.id ? 'selected' : ''}`}
                                style={{
                                  position: 'absolute',
                                  width: THUMB_SIZE,
                                  height: THUMB_SIZE,
                                  top,
                                  left,
                                }}
                                onClick={() => setSelectedPreviewImage(image)}
                                title={image.originalName || image.filename}
                              >
                                <div className="thumbnail-image-layer">
                                  <img
                                    src={`${(toAbsoluteUrl(image.url) || image.url)}?v=${imageCacheBust}`}
                                    alt={image.originalName || image.filename}
                                    onError={() => console.error('❌ 图片加载失败:', image.url)}
                                  />
                                </div>
                                <div className="thumbnail-overlay">
                                  <span className="thumbnail-name">{image.originalName || image.filename}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : projectMeshes.length === 0 ? (
                        <div style={{ padding: '1.5rem', fontSize: '0.9rem', color: '#777' }}>当前项目暂无已上传的 Mesh</div>
                      ) : (
                        <div className="thumbnails-virtual-inner" style={{ height: meshTotalHeight }}>
                          {projectMeshes.map((m, index) => {
                            const row = Math.floor(index / thumbCols);
                            const col = index % thumbCols;
                            const top = row * (THUMB_SIZE + THUMB_GAP);
                            const left = col * (THUMB_SIZE + THUMB_GAP);

                            return (
                              <div
                                key={m.id ?? m.filename}
                                className={`thumbnail-item-small ${selectedPreviewMesh?.id === m.id ? 'selected' : ''}`}
                                style={{
                                  position: 'absolute',
                                  width: THUMB_SIZE,
                                  height: THUMB_SIZE,
                                  top,
                                  left,
                                }}
                                title={m.originalName || m.filename}
                                onClick={() => setSelectedPreviewMesh(m)}
                              >
                                <div className="thumbnail-image-layer">
                                  <MeshThumbnail
                                    meshUrl={m.url || null}
                                    label={m.originalName || m.filename}
                                    assetDirUrl={m.assetDirUrl || undefined}
                                    assets={m.assets}
                                  />
                                </div>
                                <div className="thumbnail-overlay">
                                  <span className="thumbnail-name">{m.originalName || m.filename}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!currentProject && (
              <div style={{ padding: '1.25rem', color: '#a33' }}>
                未选择项目：请返回主页选择项目。{' '}
                <button
                  type="button"
                  className="ai-prompt-modal-btn secondary"
                  onClick={() => {
                    clearStoredCurrentProject();
                    navigate('/');
                  }}
                >
                  返回主页
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 拟合参数弹窗（已废弃，目前仅作为占位说明） */}
      {showPoseFitParamModal && (
        <div
          className="ai-prompt-modal-backdrop"
          onClick={() => setShowPoseFitParamModal(false)}
        >
          <div
            className="ai-prompt-modal"
            style={{ width: 'min(720px, 94vw)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ai-prompt-modal-title">Diff-DOPE 参数（6D 姿态推测）</h3>
            <p className="ai-prompt-modal-desc">这些参数会直接影响梯度下降优化（lr、迭代次数、loss 权重等）。保存后仅对当前项目生效。</p>

            <div className="ai-prompt-modal-body">
              <div className="model-param-group" style={{ maxHeight: 460 }}>
                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>nb_iterations</span>
                    <span className="model-param-value">{diffDopeParams.iters}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={200}
                    step={1}
                    value={diffDopeParams.iters}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, iters: Math.max(1, Math.min(500, Number(e.target.value) || 60)) }))}
                  />
                  <div className="model-param-hint">迭代次数越高越慢，但可能更稳定。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>batchsize</span>
                    <span className="model-param-value">{diffDopeParams.batchSize}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={32}
                    step={1}
                    value={diffDopeParams.batchSize}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, batchSize: Math.max(1, Math.min(64, Number(e.target.value) || 8)) }))}
                  />
                  <div className="model-param-hint">batch 越大越吃显存/更平滑；无 GPU 时建议小一点。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>learning_rates_bound.low (lrLow)</span>
                    <span className="model-param-value">{diffDopeParams.lrLow}</span>
                  </div>
                  <input
                    type="range"
                    min={0.000001}
                    max={5}
                    step={0.000001}
                    value={diffDopeParams.lrLow}
                    onChange={(e) =>
                      setDiffDopeParams((p) => {
                        const v = Math.max(1e-6, Number(e.target.value) || 0.01);
                        const hi = Math.max(v * 1.0001, p.lrHigh);
                        return { ...p, lrLow: v, lrHigh: hi };
                      })
                    }
                  />
                  <div className="model-param-hint">学习率下界（避免过小/过大导致不稳定）。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>learning_rates_bound.high (lrHigh)</span>
                    <span className="model-param-value">{diffDopeParams.lrHigh}</span>
                  </div>
                  <input
                    type="range"
                    min={0.001}
                    max={200}
                    step={0.001}
                    value={diffDopeParams.lrHigh}
                    onChange={(e) =>
                      setDiffDopeParams((p) => {
                        const v = Math.max(1e-6, Number(e.target.value) || 100);
                        const lo = Math.min(p.lrLow, v / 1.0001);
                        return { ...p, lrHigh: v, lrLow: Math.max(1e-6, lo) };
                      })
                    }
                  />
                  <div className="model-param-hint">学习率上界（过大可能震荡/发散）。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>base_lr</span>
                    <span className="model-param-value">{diffDopeParams.baseLr}</span>
                  </div>
                  <input
                    type="range"
                    min={0.001}
                    max={80}
                    step={0.001}
                    value={diffDopeParams.baseLr}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, baseLr: Math.max(1e-6, Number(e.target.value) || 20) }))}
                  />
                  <div className="model-param-hint">基础学习率（配合 bound 与 decay）。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>lr_decay</span>
                    <span className="model-param-value">{diffDopeParams.lrDecay}</span>
                  </div>
                  <input
                    type="range"
                    min={0.000001}
                    max={1}
                    step={0.000001}
                    value={diffDopeParams.lrDecay}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, lrDecay: Math.max(1e-6, Number(e.target.value) || 0.1) }))}
                  />
                  <div className="model-param-hint">学习率衰减系数（越小衰减越快）。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>loss toggles</span>
                    <span className="model-param-value">
                      {diffDopeParams.useMaskLoss ? 'mask' : ''}{diffDopeParams.useDepthLoss ? '+depth' : ''}{diffDopeParams.useRgbLoss ? '+rgb' : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: '#1e293b' }}>
                      <input
                        type="checkbox"
                        checked={diffDopeParams.useMaskLoss}
                        onChange={(e) => setDiffDopeParams((p) => ({ ...p, useMaskLoss: e.target.checked }))}
                      />
                      mask
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: '#1e293b' }}>
                      <input
                        type="checkbox"
                        checked={diffDopeParams.useDepthLoss}
                        onChange={(e) => setDiffDopeParams((p) => ({ ...p, useDepthLoss: e.target.checked }))}
                      />
                      depth
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: '#1e293b' }}>
                      <input
                        type="checkbox"
                        checked={diffDopeParams.useRgbLoss}
                        onChange={(e) => setDiffDopeParams((p) => ({ ...p, useRgbLoss: e.target.checked }))}
                      />
                      rgb
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: '#1e293b' }}>
                      <input
                        type="checkbox"
                        checked={diffDopeParams.returnDebugImages}
                        onChange={(e) => setDiffDopeParams((p) => ({ ...p, returnDebugImages: e.target.checked }))}
                      />
                      debug images
                    </label>
                  </div>
                  <div className="model-param-hint">一般建议至少开 mask；depth 需要真实单通道深度才有意义。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>weight_mask</span>
                    <span className="model-param-value">{diffDopeParams.weightMask}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.01}
                    value={diffDopeParams.weightMask}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, weightMask: Math.max(0, Number(e.target.value) || 1) }))}
                  />
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>weight_depth</span>
                    <span className="model-param-value">{diffDopeParams.weightDepth}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.01}
                    value={diffDopeParams.weightDepth}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, weightDepth: Math.max(0, Number(e.target.value) || 1) }))}
                  />
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>weight_rgb</span>
                    <span className="model-param-value">{diffDopeParams.weightRgb}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.01}
                    value={diffDopeParams.weightRgb}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, weightRgb: Math.max(0, Number(e.target.value) || 0.7) }))}
                  />
                </div>
              </div>
            </div>
            <div className="ai-prompt-modal-actions">
              <button
                type="button"
                className="ai-prompt-modal-btn secondary"
                onClick={() => setDiffDopeParams(DEFAULT_DIFFDOPE_PARAMS)}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => {
                  if (!currentProject?.id) {
                    setShowPoseFitParamModal(false);
                    return;
                  }
                  const key = `diffDopeParams:${currentProject.id}`;
                  try {
                    localStorage.setItem(key, JSON.stringify(diffDopeParams));
                  } catch (e) {
                    console.warn('[PoseAnnotationPage] 保存 diffDopeParams 失败:', e);
                  }
                  setShowPoseFitParamModal(false);
                }}
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PoseAnnotationPage;

