import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image } from '../types';
import { setCurrentImage } from '../store/annotationSlice';
import { authApi, depthApi, meshApi } from '../services/api';
import { getStoredCurrentProject } from '../tabStorage';
import { toAbsoluteUrl } from '../utils/urls';
import './ManualAnnotation.css';
import MeshThumbnail from './MeshThumbnail';
import PointCloudPreview3D from './PointCloudPreview3D';

type MeshInfo = {
  id?: number;
  filename: string;
  originalName: string;
  size?: number;
  url: string;
  uploadTime?: string;
  assetDirUrl?: string;
  assets?: string[];
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
  const [meshInScene, setMeshInScene] = useState<MeshInfo | null>(null); // 场景中的 Mesh
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [transformValues, setTransformValues] = useState<{
    position: { x: number; y: number; z: number };
    rotationDeg: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  }>({
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  const [transformRequestId, setTransformRequestId] = useState(0);
  const [scaleLocked, setScaleLocked] = useState(true);
  const [scaleDraft, setScaleDraft] = useState<{ x: string; y: string; z: string }>({ x: '1', y: '1', z: '1' });
  const [editingScaleAxis, setEditingScaleAxis] = useState<'x' | 'y' | 'z' | null>(null);

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

  // 当点云图层关闭时，清空场景中的 Mesh
  useEffect(() => {
    if (!showPointCloudLayer) {
      setMeshInScene(null);
      setTransformValues({
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
      setScaleDraft({ x: '1', y: '1', z: '1' });
      setEditingScaleAxis(null);
    }
  }, [showPointCloudLayer]);

  // 场景 -> UI：同步 scale 数值到输入框（不打断用户正在输入）
  useEffect(() => {
    if (editingScaleAxis) return;
    const sx = transformValues.scale.x;
    const sy = transformValues.scale.y;
    const sz = transformValues.scale.z;
    // 避免展示过长的小数
    const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '1');
    setScaleDraft({ x: fmt(sx), y: fmt(sy), z: fmt(sz) });
  }, [transformValues.scale.x, transformValues.scale.y, transformValues.scale.z, editingScaleAxis]);

  const applyScaleDraft = (axis: 'x' | 'y' | 'z') => {
    const raw = scaleDraft[axis];
    const parsed = Number(raw);
    // 输入阶段允许 0 / 0. / 空等中间态；应用阶段做校验
    const v = Number.isFinite(parsed) ? parsed : NaN;
    const safe = !Number.isFinite(v) || v <= 0 ? 1 : v;

    const next = scaleLocked
      ? { ...transformValues, scale: { x: safe, y: safe, z: safe } }
      : { ...transformValues, scale: { ...transformValues.scale, [axis]: safe } as any };

    setTransformValues(next);
    // 同步 draft（让最终落地值可见）
    const s = String(safe);
    setScaleDraft(scaleLocked ? { x: s, y: s, z: s } : { ...scaleDraft, [axis]: s });
    setTransformRequestId((id) => id + 1);
  };

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
              disabled={!showPointCloudLayer}
              onClick={async () => {
                if (!showPointCloudLayer) {
                  alert('请先激活点云图层');
                  return;
                }
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
              title={showPointCloudLayer ? '点击选择 Mesh 并加载到点云场景' : '请先激活点云图层'}
            >
              拖入 Mesh (OBJ)
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
                    src={toAbsoluteUrl(currentImage.url) || currentImage.url}
                    alt={currentImage.originalName || currentImage.filename}
                    className="annotation-image"
                    style={{ position: 'absolute', inset: 0, margin: 'auto' }}
                  />
                )}

                {showDepthLayer &&
                  selectedDepth &&
                  (selectedDepth.modality === 'depth_png' || (selectedDepth.url || '').toLowerCase().endsWith('.png')) && (
                    <img
                      src={toAbsoluteUrl(selectedDepth.url) || selectedDepth.url}
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
                      <>
                        <PointCloudPreview3D
                          npyUrl={toAbsoluteUrl(selectedDepth.url) || null}
                          stride={pointStride}
                          depthScale={pointDepthScale}
                          selectedMesh={meshInScene}
                          transformMode={transformMode}
                          onTransformModeChange={setTransformMode}
                          onTransformValuesChange={(vals) => {
                            // 场景 -> UI：同步显示（不触发回写请求）
                            setTransformValues(vals);
                          }}
                          transformRequest={{
                            id: transformRequestId,
                            ...transformValues,
                          }}
                        />
                      </>
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

            {/* 变换工具（点云 + 已加载 Mesh 时展示） */}
            {showPointCloudLayer && meshInScene && (
              <div className="property-section">
                <h4>变换工具</h4>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setTransformMode('translate')}
                    style={{
                      padding: '0.45rem 0.6rem',
                      borderRadius: 8,
                      border: '1px solid',
                      borderColor: transformMode === 'translate' ? '#667eea' : '#d0d7e2',
                      background: transformMode === 'translate' ? 'rgba(102, 126, 234, 0.12)' : '#fff',
                      color: transformMode === 'translate' ? '#2b3a67' : '#111',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      fontWeight: transformMode === 'translate' ? 600 : 500,
                    }}
                    title="移动 (W)"
                  >
                    W 移动
                  </button>
                  <button
                    type="button"
                    onClick={() => setTransformMode('rotate')}
                    style={{
                      padding: '0.45rem 0.6rem',
                      borderRadius: 8,
                      border: '1px solid',
                      borderColor: transformMode === 'rotate' ? '#667eea' : '#d0d7e2',
                      background: transformMode === 'rotate' ? 'rgba(102, 126, 234, 0.12)' : '#fff',
                      color: transformMode === 'rotate' ? '#2b3a67' : '#111',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      fontWeight: transformMode === 'rotate' ? 600 : 500,
                    }}
                    title="旋转 (E)"
                  >
                    E 旋转
                  </button>
                  <button
                    type="button"
                    onClick={() => setTransformMode('scale')}
                    style={{
                      padding: '0.45rem 0.6rem',
                      borderRadius: 8,
                      border: '1px solid',
                      borderColor: transformMode === 'scale' ? '#667eea' : '#d0d7e2',
                      background: transformMode === 'scale' ? 'rgba(102, 126, 234, 0.12)' : '#fff',
                      color: transformMode === 'scale' ? '#2b3a67' : '#111',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      fontWeight: transformMode === 'scale' ? 600 : 500,
                    }}
                    title="缩放 (R)"
                  >
                    R 缩放
                  </button>
                </div>
                <div style={{ marginTop: '0.35rem', fontSize: '0.8rem', color: '#6c757d' }}>
                  快捷键：W 移动，E 旋转，R 缩放
                </div>

                {/* Unity Detail 面板：Position / Rotation / Scale */}
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.82rem', color: '#495057', fontWeight: 600, marginBottom: '0.35rem' }}>
                    Transform（数值）
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: '0.4rem', alignItems: 'center' }}>
                    <div style={{ fontSize: '0.8rem', color: '#6c757d' }}>Position</div>
                    <input
                      type="number"
                      step="0.01"
                      value={transformValues.position.x}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, position: { ...transformValues.position, x: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Position X"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={transformValues.position.y}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, position: { ...transformValues.position, y: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Position Y"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={transformValues.position.z}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, position: { ...transformValues.position, z: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Position Z"
                    />

                    <div style={{ fontSize: '0.8rem', color: '#6c757d' }}>Rotation</div>
                    <input
                      type="number"
                      step="1"
                      value={transformValues.rotationDeg.x}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, rotationDeg: { ...transformValues.rotationDeg, x: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Rotation X (deg)"
                    />
                    <input
                      type="number"
                      step="1"
                      value={transformValues.rotationDeg.y}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, rotationDeg: { ...transformValues.rotationDeg, y: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Rotation Y (deg)"
                    />
                    <input
                      type="number"
                      step="1"
                      value={transformValues.rotationDeg.z}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const next = { ...transformValues, rotationDeg: { ...transformValues.rotationDeg, z: v } };
                        setTransformValues(next);
                        setTransformRequestId((id) => id + 1);
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Rotation Z (deg)"
                    />

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <div style={{ fontSize: '0.8rem', color: '#6c757d' }}>Scale</div>
                      <button
                        type="button"
                        onClick={() => setScaleLocked((v) => !v)}
                        style={{
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          borderRadius: 8,
                          padding: '0.15rem 0.45rem',
                          cursor: 'pointer',
                          color: '#6c757d',
                          lineHeight: 1.1,
                          fontSize: '0.9rem',
                        }}
                        title="比例锁：开启后缩放保持等比（修改任一轴会同步到 X/Y/Z）"
                      >
                        {scaleLocked ? '🔒' : '🔓'}
                      </button>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      value={scaleDraft.x}
                      onChange={(e) => {
                        setEditingScaleAxis('x');
                        setScaleDraft((prev) => ({ ...prev, x: e.target.value }));
                      }}
                      onFocus={() => setEditingScaleAxis('x')}
                      onBlur={() => {
                        applyScaleDraft('x');
                        setEditingScaleAxis(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyScaleDraft('x');
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Scale X"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={scaleDraft.y}
                      onChange={(e) => {
                        setEditingScaleAxis('y');
                        setScaleDraft((prev) => ({ ...prev, y: e.target.value }));
                      }}
                      onFocus={() => setEditingScaleAxis('y')}
                      onBlur={() => {
                        applyScaleDraft('y');
                        setEditingScaleAxis(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyScaleDraft('y');
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Scale Y"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={scaleDraft.z}
                      onChange={(e) => {
                        setEditingScaleAxis('z');
                        setScaleDraft((prev) => ({ ...prev, z: e.target.value }));
                      }}
                      onFocus={() => setEditingScaleAxis('z')}
                      onBlur={() => {
                        applyScaleDraft('z');
                        setEditingScaleAxis(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyScaleDraft('z');
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Scale Z"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div
                  className={`layer-item ${showRgbLayer ? 'active' : ''}`}
                  onClick={() => {
                    const next = !showRgbLayer;
                    setShowRgbLayer(next);
                    // RGB/深度 与 点云 互斥：打开 RGB 时关闭点云
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
                  }}
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
                    // RGB/深度 与 点云 互斥：打开深度时关闭点云
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
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
                            (d) =>
                              d.modality === 'depth_png' ||
                              String(d.originalName || d.filename).toLowerCase().endsWith('.png'),
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

                    // 打开点云时，RGB 和 深度图层都应关闭
                    if (showRgbLayer) setShowRgbLayer(false);
                    if (showDepthLayer) setShowDepthLayer(false);

                    try {
                      if (!projectId) {
                        alert('当前未找到项目信息，无法加载深度列表');
                        return;
                      }
                      // 尽量复用已有 depthList；没有则拉取一次
                      const list =
                        depthList.length > 0 ? depthList : await depthApi.getDepth(projectId, currentImage.id);
                      if (depthList.length === 0) setDepthList(list);

                      const firstRaw = list.find(
                        (d) =>
                          d.modality === 'depth_raw' ||
                          String(d.originalName || d.filename).toLowerCase().endsWith('.npy'),
                      );
                      if (firstRaw) {
                        setSelectedDepthId(firstRaw.id);
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
            {meshes.length === 0 ? (
              <div
                style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: '#666',
                  fontSize: '0.9rem',
                }}
              >
                当前项目暂无已上传的 Mesh，请先在 Pose 工作区上传 OBJ 文件。
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(125px, 1fr))',
                  gap: '12px',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  padding: '0.5rem',
                }}
              >
                {meshes.map((m) => (
                  <div
                    key={m.id ?? m.filename}
                    onClick={() => {
                      if (!showPointCloudLayer) {
                        alert('请先激活点云图层');
                        return;
                      }
                      setMeshInScene(m); // 加载到场景
                      setShowMeshModal(false); // 关闭弹窗
                    }}
                    style={{
                      position: 'relative',
                      width: '125px',
                      height: '125px',
                      borderRadius: 8,
                      border: meshInScene && meshInScene.id === m.id ? '2px solid #667eea' : '1px solid #e0e0e0',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      background: '#020617',
                      transition: 'border-color 0.2s',
                    }}
                    title={m.originalName || m.filename}
                  >
                    <MeshThumbnail
                      meshUrl={m.url || null}
                      label={m.originalName || m.filename}
                      assetDirUrl={m.assetDirUrl || undefined}
                      assets={m.assets}
                      width={125}
                      height={125}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.75rem',
                        color: '#fff',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {m.originalName || m.filename}
                    </div>
                  </div>
                ))}
              </div>
            )}
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

