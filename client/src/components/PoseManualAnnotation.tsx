import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image } from '../types';
import { setCurrentImage } from '../store/annotationSlice';
import { authApi, depthApi, meshApi } from '../services/api';
import { getStoredCurrentProject } from '../tabStorage';
import './ManualAnnotation.css';
import MeshPreview3D from './MeshPreview3D';
import PointCloudPreview3D from './PointCloudPreview3D';

type MeshInfo = {
  id?: number;
  filename: string;
  originalName: string;
  size?: number;
  url: string;
  uploadTime?: string;
};

type DepthInfo = {
  id: number;
  filename: string;
  originalName: string;
  size?: number;
  url: string;
  imageId?: number;
  role?: string;
  modality?: string;
  uploadTime?: string;
};

const PoseManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images } = useSelector((state: any) => state.annotation);
  const [showMeshModal, setShowMeshModal] = useState(false);
  const [meshes, setMeshes] = useState<MeshInfo[]>([]);
  const [dragMesh, setDragMesh] = useState<MeshInfo | null>(null);
  const [selectedMesh, setSelectedMesh] = useState<MeshInfo | null>(null);

  // 右侧图层（参考 2D 的 layers 交互，但这里先做“可见性开关”）
  const [showRgbLayer, setShowRgbLayer] = useState(true);
  const [showDepthLayer, setShowDepthLayer] = useState(false);
  const [showPointCloudLayer, setShowPointCloudLayer] = useState(false);
  const [depthList, setDepthList] = useState<DepthInfo[]>([]);
  const [selectedDepthId, setSelectedDepthId] = useState<number | null>(null);
  const [depthOpacity, setDepthOpacity] = useState(0.45);
  const [depthBlendMode, setDepthBlendMode] = useState<'multiply' | 'normal' | 'screen'>('multiply');
  const [pointStride, setPointStride] = useState(2);
  const [pointDepthScale, setPointDepthScale] = useState(1.0);

  const selectedDepth = useMemo(() => {
    if (!selectedDepthId) return null;
    return depthList.find((d) => d.id === selectedDepthId) || null;
  }, [depthList, selectedDepthId]);

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

      if (!currentImage) {
        navigate('/pose', { replace: true });
      }
    };

    checkAuthAndImage();
  }, [currentImage, navigate]);

  const handleBack = () => {
    dispatch(setCurrentImage(null));
    navigate('/pose', { replace: true });
  };

  const handleNavigateImage = (direction: 'prev' | 'next') => {
    if (!currentImage || !images || images.length === 0) return;
    const currentIndex = images.findIndex((img: Image) => img.id === currentImage.id);
    if (currentIndex === -1) return;

    if (direction === 'prev') {
      if (currentIndex === 0) return;
      const prevImage = images[currentIndex - 1];
      dispatch(setCurrentImage(prevImage));
    } else {
      if (currentIndex === images.length - 1) return;
      const nextImage = images[currentIndex + 1];
      dispatch(setCurrentImage(nextImage));
    }
  };

  if (!currentImage) {
    return null;
  }

  const projectId = getStoredCurrentProject<any>()?.id;

  return (
    <div className="manual-annotation">
      {/* 顶部导航栏（样式复用 2D 人工标注） */}
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
            disabled={
              !images ||
              images.length === 0 ||
              images.findIndex((img: Image) => img.id === currentImage.id) === images.length - 1
            }
            title="下一张"
          >
            →
          </button>
        </div>
      </header>

      {/* 主工作区域：布局模仿 2D 标注，但工具栏内容保留为空占位 */}
      <div className="annotation-main">
        {/* 左侧工具栏占位 */}
        <div className="annotation-left-panel">
          <div className="tool-section" style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="start-annotation-btn"
              style={{ margin: 0 }}
              onClick={async () => {
                setShowMeshModal(true);
                if (meshes.length === 0) {
                  try {
                    const savedProject = getStoredCurrentProject<any>();
                    const projectId = savedProject?.id;
                    if (!projectId) {
                      alert('当前未找到项目信息，无法加载 Mesh 列表');
                      return;
                    }
                    const list = await meshApi.getMeshes(projectId);
                    setMeshes(list);
                  } catch (e) {
                    console.error('[PoseManualAnnotation] 加载 Mesh 列表失败:', e);
                    alert('加载 Mesh 列表失败，请稍后重试');
                  }
                }
              }}
            >
              导入 Mesh (OBJ)
            </button>
          </div>
        </div>

        {/* 中间画布区域：暂时只显示图片预览，后续可嵌入 3D 视图/pose 编辑器 */}
        <div className="annotation-center-panel">
          <div className="canvas-area">
            <div className="image-container" style={{ width: '100%', height: '100%' }}>
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                {showRgbLayer && (
                  <img
                    src={`http://localhost:3001${currentImage.url}`}
                    alt={currentImage.originalName || currentImage.filename}
                    className="annotation-image"
                    style={{ position: 'absolute', inset: 0, margin: 'auto' }}
                  />
                )}

                {showDepthLayer &&
                  selectedDepth &&
                  (selectedDepth.modality === 'depth_png' || (selectedDepth.url || '').toLowerCase().endsWith('.png')) && (
                    <img
                      src={`http://localhost:3001${selectedDepth.url}`}
                      alt={selectedDepth.originalName || selectedDepth.filename}
                      className="annotation-image"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        margin: 'auto',
                        opacity: Math.max(0, Math.min(1, depthOpacity)),
                        mixBlendMode: depthBlendMode,
                        pointerEvents: 'none',
                      }}
                      onError={(e) => {
                        console.error('[PoseManualAnnotation] 深度 PNG 加载失败:', selectedDepth.url, e);
                      }}
                    />
                  )}

                {showDepthLayer && selectedDepth && selectedDepth.modality === 'depth_raw' && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#999',
                      fontSize: '0.9rem',
                      pointerEvents: 'none',
                      padding: '1rem',
                      textAlign: 'center',
                    }}
                  >
                    已选择深度原始数据（.npy），当前版本暂不支持直接可视化预览。
                  </div>
                )}

                {showPointCloudLayer && (
                  <div style={{ position: 'absolute', inset: 0 }}>
                    {selectedDepth && selectedDepth.modality === 'depth_raw' ? (
                      <PointCloudPreview3D
                        npyUrl={selectedDepth.url ? `http://localhost:3001${selectedDepth.url}` : null}
                        stride={pointStride}
                        depthScale={pointDepthScale}
                      />
                    ) : (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#999',
                          fontSize: '0.9rem',
                          pointerEvents: 'none',
                          padding: '1rem',
                          textAlign: 'center',
                        }}
                      >
                        点云图层需要选择深度原始数据（depth_raw_*.npy）。
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右侧面板 - 属性面板（结构模仿 2D ManualAnnotation） */}
        <div className="annotation-right-panel">
          <div className="properties-panel">
            <h3>属性面板</h3>

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div
                  className={`layer-item ${showRgbLayer ? 'active' : ''}`}
                  onClick={() => setShowRgbLayer((v) => !v)}
                  title="RGB 图层"
                >
                  <span>RGB 图层</span>
                  <span className="layer-visible">{showRgbLayer ? '👁️' : '🚫'}</span>
                </div>

                <div
                  className={`layer-item ${showDepthLayer ? 'active' : ''}`}
                  onClick={async () => {
                    const next = !showDepthLayer;
                    setShowDepthLayer(next);
                    if (next) {
                      try {
                        if (!projectId) {
                          alert('当前未找到项目信息，无法加载深度列表');
                          return;
                        }
                        const list = await depthApi.getDepth(projectId, currentImage.id);
                        setDepthList(list);
                        if (list.length > 0) {
                          const firstPng = list.find(
                            (d) => d.modality === 'depth_png' || String(d.originalName || d.filename).toLowerCase().endsWith('.png'),
                          );
                          setSelectedDepthId((firstPng || list[0]).id);
                        } else {
                          setSelectedDepthId(null);
                        }
                      } catch (e) {
                        console.error('[PoseManualAnnotation] 加载深度列表失败:', e);
                        alert('加载深度列表失败，请稍后重试');
                      }
                    }
                  }}
                  title="深度图层"
                >
                  <span>深度图层</span>
                  <span className="layer-visible">{showDepthLayer ? '👁️' : '🚫'}</span>
                </div>

                <div
                  className={`layer-item ${showPointCloudLayer ? 'active' : ''}`}
                  onClick={async () => {
                    const next = !showPointCloudLayer;
                    setShowPointCloudLayer(next);
                    if (!next) return;
                    try {
                      if (!projectId) {
                        alert('当前未找到项目信息，无法加载深度列表');
                        return;
                      }
                      // 尽量复用已有 depthList；没有则拉取一次
                      const list = depthList.length > 0 ? depthList : await depthApi.getDepth(projectId, currentImage.id);
                      if (depthList.length === 0) setDepthList(list);

                      const firstRaw = list.find((d) => d.modality === 'depth_raw' || String(d.originalName || d.filename).toLowerCase().endsWith('.npy'));
                      if (firstRaw) {
                        setSelectedDepthId(firstRaw.id);
                        setShowDepthLayer(false); // 避免 PNG 叠加和点云同时开造成“白布/遮挡”的错觉
                      } else {
                        alert('当前图片未找到绑定的 depth_raw（.npy）文件，无法生成点云');
                      }
                    } catch (e) {
                      console.error('[PoseManualAnnotation] 加载深度列表失败（点云）:', e);
                      alert('加载深度列表失败，请稍后重试');
                    }
                  }}
                  title="点云图层（占位）"
                >
                  <span>点云图层</span>
                  <span className="layer-visible">{showPointCloudLayer ? '👁️' : '🚫'}</span>
                </div>
              </div>

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

                  <div style={{ marginTop: '0.5rem' }}>
                    <div style={{ fontSize: '0.85rem', color: '#495057', fontWeight: 600, marginBottom: '0.35rem' }}>
                      叠加模式
                    </div>
                    <select
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.6rem',
                        borderRadius: 8,
                        border: '1px solid #d0d7e2',
                        background: '#fff',
                        color: '#111',
                        fontSize: '0.85rem',
                      }}
                      value={depthBlendMode}
                      onChange={(e) => setDepthBlendMode(e.target.value as any)}
                    >
                      <option value="multiply">multiply（更不易发白）</option>
                      <option value="normal">normal</option>
                      <option value="screen">screen（容易发白）</option>
                    </select>
                  </div>
                </div>
              )}

              {showPointCloudLayer && (
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.85rem', color: '#495057', fontWeight: 600, marginBottom: '0.35rem' }}>
                    点云参数（临时）
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#6c757d', marginBottom: '0.35rem' }}>
                    stride 越大越省性能；depthScale 用于单位换算（当前样例看起来是米=1.0）。
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.8rem', color: '#495057' }}>
                      stride
                      <input
                        type="number"
                        min={1}
                        max={16}
                        step={1}
                        value={pointStride}
                        onChange={(e) => setPointStride(Math.max(1, Math.min(16, Number(e.target.value) || 2)))}
                        style={{
                          width: '100%',
                          marginTop: 4,
                          padding: '0.45rem 0.55rem',
                          borderRadius: 8,
                          border: '1px solid #d0d7e2',
                        }}
                      />
                    </label>
                    <label style={{ fontSize: '0.8rem', color: '#495057' }}>
                      depthScale
                      <input
                        type="number"
                        min={0.0001}
                        step={0.1}
                        value={pointDepthScale}
                        onChange={(e) => setPointDepthScale(Number(e.target.value) || 1.0)}
                        style={{
                          width: '100%',
                          marginTop: 4,
                          padding: '0.45rem 0.55rem',
                          borderRadius: 8,
                          border: '1px solid #d0d7e2',
                        }}
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mesh 预览弹窗 */}
      {showMeshModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          onClick={() => setShowMeshModal(false)}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: '1.25rem 1.5rem',
              width: '520px',
              maxWidth: '90vw',
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, marginBottom: '0.75rem', fontSize: '1.05rem' }}>Mesh 预览（开发中）</h3>
            <div
              style={{
                borderRadius: 10,
                border: '1px solid #e0e0e0',
                padding: '0.5rem 0.75rem',
                marginBottom: '0.75rem',
                background: '#f8f9fa',
                fontSize: '0.9rem',
                color: '#495057',
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {meshes.length === 0 ? (
                <div>当前项目暂无已上传的 Mesh，请先在 Pose 工作区上传 OBJ 文件。</div>
              ) : (
                meshes.map((m) => (
                  <div
                    key={m.id ?? m.filename}
                    draggable
                    onDragStart={() => setDragMesh(m)}
                    onClick={() => setSelectedMesh(m)}
                    style={{
                      padding: '0.35rem 0.5rem',
                      borderRadius: 6,
                      cursor: 'grab',
                      marginBottom: 4,
                      background:
                        selectedMesh && selectedMesh.id === m.id ? 'rgba(102,126,234,0.16)' : 'transparent',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{m.originalName || m.filename}</div>
                    {m.size != null && (
                      <div style={{ fontSize: '0.75rem', color: '#868e96' }}>
                        {(m.size / (1024 * 1024)).toFixed(2)} MB
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div
              style={{
                position: 'relative',
                borderRadius: 10,
                border: '1px solid #e0e0e0',
                background: '#020617',
                height: 220,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#e5e7eb',
                fontSize: '0.9rem',
                overflow: 'hidden',
              }}
              onDragOver={(e) => {
                if (dragMesh) {
                  e.preventDefault();
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragMesh) {
                  setSelectedMesh(dragMesh);
                }
              }}
            >
              {selectedMesh ? (
                <>
                  <div
                    style={{
                      position: 'absolute',
                      top: 6,
                      left: 10,
                      right: 10,
                      fontSize: '0.78rem',
                      opacity: 0.9,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {selectedMesh.originalName || selectedMesh.filename}
                  </div>
                  <MeshPreview3D
                    meshUrl={selectedMesh.url ? `http://localhost:3001${selectedMesh.url}` : null}
                  />
                </>
              ) : (
                <>将左侧列表中的 Mesh 拖拽到此处进行 3D 预览</>
              )}
            </div>
            <div style={{ marginTop: '0.9rem', textAlign: 'right' }}>
              <button
                type="button"
                className="ai-prompt-modal-btn secondary"
                style={{ marginRight: '0.5rem' }}
                onClick={() => setShowMeshModal(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => setShowMeshModal(false)}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PoseManualAnnotation;

