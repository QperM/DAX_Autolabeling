import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setCurrentImage, setError, setImages, setLoading } from '../store/annotationSlice';
import { authApi, imageApi, meshApi } from '../services/api';
import type { Image } from '../types';
import { clearStoredCurrentProject, getStoredCurrentProject } from '../tabStorage';
import MeshUploader from './MeshUploader';
import MeshPreview3D from './MeshPreview3D';
import MeshThumbnail from './MeshThumbnail';
import './AnnotationPage.css';

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
    }>
  >([]);

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
                <MeshUploader projectId={currentProject?.id} />

                <div style={{ marginTop: '1rem', color: '#666', fontSize: '0.95rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>功能占位</div>
                  <div>这里后续将放置：相机参数/深度图导入、pose 标注工具、结果导出等。</div>
                  {!isAdmin && <div style={{ marginTop: '0.25rem' }}>当前为普通用户：仍可进行标注相关操作（具体权限后续细化）。</div>}
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
                    <div className="image-preview-wrapper">
                      <div className="preview-image-layer" style={{ width: '100%', height: '100%' }}>
                        <MeshPreview3D
                          meshUrl={selectedPreviewMesh.url || null}
                          assetDirUrl={selectedPreviewMesh.assetDirUrl || undefined}
                          assets={selectedPreviewMesh.assets}
                        />
                      </div>
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
                  <div className="image-preview-wrapper">
                    <div className="preview-image-layer">
                      <img
                        src={`http://localhost:3001${selectedPreviewImage.url}?v=${imageCacheBust}`}
                        alt={selectedPreviewImage.originalName || selectedPreviewImage.filename}
                        className="preview-image"
                      />
                    </div>
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
                                    src={`http://localhost:3001${image.url}?v=${imageCacheBust}`}
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
    </div>
  );
};

export default PoseAnnotationPage;

