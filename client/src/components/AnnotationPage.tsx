import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setImages, setLoading, setError, setCurrentImage } from '../store/annotationSlice';
import { imageApi, annotationApi, projectApi } from '../services/api';
import type { Image, Mask, BoundingBox } from '../types';
import ImageUploader from './ImageUploader';
import './AnnotationPage.css';

const AnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { images, loading, error } = useSelector((state: any) => state.annotation);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<Image | null>(null);
  const [previewDisplayMode, setPreviewDisplayMode] = useState<'image' | 'mask'>('image');
  const [previewMasks, setPreviewMasks] = useState<Mask[]>([]);
  const [previewAnnoLoading, setPreviewAnnoLoading] = useState(false);
  const [previewImageSize, setPreviewImageSize] = useState<{ width: number; height: number } | null>(null);
  const [thumbnailMasks, setThumbnailMasks] = useState<Record<number, Mask[]>>({});
  const [thumbnailSizes, setThumbnailSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [showThumbnailMasks, setShowThumbnailMasks] = useState(true);
  const [currentProject, setCurrentProject] = useState<any>(null);  // 当前项目
  const [aiProgress, setAiProgress] = useState(0);  // AI标注进度 0-100
  const [batchAnnotating, setBatchAnnotating] = useState(false);  // 批量标注进行中
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    completed: number;
    current: string;
    results: Array<{ image: Image; success: boolean; annotations?: any; error?: string }>;
  }>({
    total: 0,
    completed: 0,
    current: '',
    results: []
  });  // 批量标注进度
  const [aiPrompt, setAiPrompt] = useState<string>(''); // AI提示词（传给 Grounded SAM2 / Mask R-CNN，逗号分隔多个）
  const [aiPrompts, setAiPrompts] = useState<string[]>([]); // 多条提示词输入
  const [showPromptModal, setShowPromptModal] = useState(false); // 是否显示提示词配置弹窗
  const [annotationSummary, setAnnotationSummary] = useState<{
    totalImages: number;
    annotatedImages: number;
    latestAnnotatedImageId: number | null;
    latestUpdatedAt: string | null;
  } | null>(null);

  // 统一的颜色调色板（用于确保不同标签分配不同颜色）
  const COLOR_PALETTE = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80',
  ];

  const assignColorsForAnnotations = (input: { masks: Mask[]; boundingBoxes: BoundingBox[] }) => {
    const labelColorMap = new Map<string, string>();

    const getColorForLabel = (label: string | undefined, fallbackIndex: number): string => {
      const key = label && label.trim().length > 0 ? label.trim() : `__unnamed_${fallbackIndex}`;
      if (labelColorMap.has(key)) {
        return labelColorMap.get(key)!;
      }
      const color = COLOR_PALETTE[labelColorMap.size % COLOR_PALETTE.length];
      labelColorMap.set(key, color);
      return color;
    };

    const coloredMasks: Mask[] = input.masks.map((mask, index) => ({
      ...mask,
      color: mask.color || getColorForLabel(mask.label, index),
    }));

    const coloredBBoxes: BoundingBox[] = input.boundingBoxes.map((bbox, index) => ({
      ...bbox,
      color: bbox.color || getColorForLabel(bbox.label, input.masks.length + index),
    }));

    return {
      masks: coloredMasks,
      boundingBoxes: coloredBBoxes,
    };
  };

  const loadPreviewMasks = async (imageId: number) => {
    try {
      setPreviewAnnoLoading(true);
      const resp = await annotationApi.getAnnotation(imageId);
      const anno = resp?.annotation;
      setPreviewMasks(anno?.masks || []);
    } catch (e) {
      console.warn('[AnnotationPage] 预览加载 masks 失败, imageId =', imageId, e);
      setPreviewMasks([]);
    } finally {
      setPreviewAnnoLoading(false);
    }
  };

  // 预览图切换时：重置 overlay 相关状态
  useEffect(() => {
    setPreviewMasks([]);
    setPreviewImageSize(null);
    if (!selectedPreviewImage) return;
    if (previewDisplayMode === 'mask') {
      loadPreviewMasks(selectedPreviewImage.id);
    }
  }, [selectedPreviewImage]);

  // 切换到 mask 显示时：按需拉取标注
  useEffect(() => {
    if (!selectedPreviewImage) return;
    if (previewDisplayMode !== 'mask') return;
    loadPreviewMasks(selectedPreviewImage.id);
  }, [previewDisplayMode]);

  const ensureThumbnailMasks = async (imageId: number) => {
    if (!showThumbnailMasks) return;
    if (thumbnailMasks[imageId]) return;
    try {
      const resp = await annotationApi.getAnnotation(imageId);
      const anno = resp?.annotation;
      if (anno?.masks) {
        setThumbnailMasks(prev => ({ ...prev, [imageId]: anno.masks }));
      }
    } catch (e) {
      console.warn('[AnnotationPage] 缩略图加载 masks 失败, imageId =', imageId, e);
    }
  };

  // 从 localStorage 恢复当前项目
  useEffect(() => {
    const savedProject = localStorage.getItem('currentProject');
    if (savedProject) {
      try {
        const project = JSON.parse(savedProject);
        setCurrentProject(project);
        console.log('AnnotationPage: 恢复当前项目:', project);
      } catch (e) {
        console.error('AnnotationPage: 解析保存的项目失败', e);
        localStorage.removeItem('currentProject');
      }
    } else {
      console.warn('AnnotationPage: 未在 localStorage 中找到当前项目');
    }
  }, []);

  // 根据当前项目加载已有图像
  useEffect(() => {
    if (currentProject) {
      const loadImages = async () => {
        try {
          dispatch(setLoading(true));
          // 根据项目ID加载该项目的图片
          const loadedImages = await imageApi.getImages(currentProject.id);
          dispatch(setImages(loadedImages));

          // 同步拉取项目标注汇总（用于“已完成AI标注数量”）
          const summary = await projectApi.getAnnotationSummary(currentProject.id);
          setAnnotationSummary(summary);
        } catch (err: any) {
          dispatch(setError(err.message || '加载图像失败'));
        } finally {
          dispatch(setLoading(false));
        }
      };

      loadImages();
    }
  }, [dispatch, currentProject]);

  const refreshAnnotationSummary = async () => {
    if (!currentProject) return;
    try {
      const summary = await projectApi.getAnnotationSummary(currentProject.id);
      setAnnotationSummary(summary);
    } catch (e) {
      console.warn('刷新标注汇总失败:', e);
    }
  };

  const handleUploadComplete = (newImages: Image[]) => {
    if (!currentProject) {
      alert('请先创建或选择项目！');
      return;
    }
    console.log('上传完成:', newImages);
    // TODO: 将图片与当前项目关联
  };

  const handleStartManualAnnotation = (image: Image) => {
    dispatch(setCurrentImage(image));
    navigate('./manual-annotation');
  };

  const handleBack = () => {
    navigate('/');
  };

  // 处理批量AI自动标注
  const handleBatchAIAutoAnnotation = async () => {
    if (images.length === 0) {
      alert('当前没有可标注的图片');
      return;
    }

    if (!currentProject) {
      alert('请先选择项目');
      return;
    }

    const confirmMessage = `确定要对所有 ${images.length} 张图片进行批量AI自动标注吗？\n\n` +
      `当前提示词: ${aiPrompt ? `"${aiPrompt}"` : '（空，自动识别常见目标）'}\n\n` +
      `将使用Grounded SAM2模型进行对象检测和分割。\n\n注意：批量标注可能需要较长时间，请耐心等待。`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      setBatchAnnotating(true);
      setBatchProgress({
        total: images.length,
        completed: 0,
        current: '',
        results: []
      });

      const results: Array<{ image: Image; success: boolean; annotations?: any; error?: string }> = [];

      // 逐个处理每张图片
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        setBatchProgress(prev => ({
          ...prev,
          current: `正在处理: ${image.originalName} (${i + 1}/${images.length})`
        }));

        try {
          // 调用后端AI标注API
          const result = await annotationApi.autoAnnotate(image.id, aiPrompt || undefined);

          // 为本次结果分配颜色（同一标签复用同一颜色）
          const colored = assignColorsForAnnotations(result.annotations);

          // 自动保存标注结果（带颜色信息）
          await annotationApi.saveAnnotation(image.id, {
            masks: colored.masks,
            boundingBoxes: colored.boundingBoxes,
            polygons: [],
          });

          results.push({
            image,
            success: true,
            annotations: colored
          });

          setBatchProgress(prev => ({
            ...prev,
            completed: prev.completed + 1,
            results: [...results]
          }));
        } catch (error: any) {
          console.error(`图片 ${image.originalName} 标注失败:`, error);
          results.push({
            image,
            success: false,
            error: error.message || '未知错误'
          });

          setBatchProgress(prev => ({
            ...prev,
            completed: prev.completed + 1,
            results: [...results]
          }));
        }

        // 更新总进度
        const progress = Math.round(((i + 1) / images.length) * 100);
        setAiProgress(progress);
      }

      // 批量标注完成（仅更新进度 & 统计，不自动跳转预览）
      setBatchProgress(prev => ({
        ...prev,
        current: '批量标注完成！',
        results: [...results]
      }));
      setAiProgress(100);
      await refreshAnnotationSummary();

      // 显示汇总结果
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      setTimeout(() => {
        alert(`批量标注完成！\n\n成功: ${successCount} 张\n失败: ${failCount} 张`);
        setBatchAnnotating(false);
        setAiProgress(0);
        // 保留批量结果，方便后续查看；如需清空可在页面刷新时重置
      }, 1000);

    } catch (error: any) {
      console.error('批量AI标注失败:', error);
      alert(`批量标注失败: ${error.message || '未知错误'}`);
      setBatchAnnotating(false);
      setAiProgress(0);
      setBatchProgress({
        total: 0,
        completed: 0,
        current: '',
        results: []
      });
    }
  };

  const handlePreviewNavigate = (direction: 'prev' | 'next') => {
    if (!selectedPreviewImage || images.length === 0) return;
    const currentIndex = images.findIndex((img: Image) => img.id === selectedPreviewImage.id);
    if (currentIndex === -1) return;

    if (direction === 'prev') {
      if (currentIndex === 0) return;
      const prevImage = images[currentIndex - 1];
      setSelectedPreviewImage(prevImage);
    } else {
      if (currentIndex === images.length - 1) return;
      const nextImage = images[currentIndex + 1];
      setSelectedPreviewImage(nextImage);
    }
  };

  return (
    <div className="annotation-page">
      {/* 顶部导航栏 */}
      <header className="page-header">
        <div className="header-left">
          <button className="back-button" onClick={handleBack}>
            ← 返回主页
          </button>
          <h1>图像标注工作区</h1>
        </div>
        <div className="header-right">
          <span className="status">
            {loading ? '加载中...' : `${images.length} 张图片`}
          </span>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          错误: {error}
          <button onClick={() => dispatch(setError(null))}>×</button>
        </div>
      )}

      {/* 主内容区域 */}
      <div className="page-content">
        <div className="welcome-section">
          {/* 三区域布局 */}
          <div className="welcome-layout">
            {/* 左上区域 - 欢迎内容 */}
            <div className="welcome-left-top">
              <div className="welcome-content">
                <ImageUploader 
                  onUploadComplete={handleUploadComplete} 
                  projectId={currentProject?.id}
                />
                
                {/* AI标注功能区域 */}
                <div className="ai-section">
                  <div className="ai-header-row">
                  <h3>AI自动标注</h3>
                  </div>
                  <div className="ai-controls">
                    <div className="ai-controls-top">
                      <div className="ai-prompt-group">
                        <button 
                          type="button"
                          className="ai-prompt-manage-btn"
                          onClick={() => {
                            if (aiPrompts.length === 0) {
                              setAiPrompts(['']);
                            }
                            setShowPromptModal(true);
                          }}
                        >
                          {aiPrompts.filter((p) => p.trim().length > 0).length > 0
                            ? `已配置 ${aiPrompts.filter((p) => p.trim().length > 0).length} 条提示词`
                            : '点击配置提示词'}
                        </button>
                        <div className="ai-prompt-helper">
                          点击上方按钮，在弹窗中添加/编辑提示词。多条提示词会按顺序传给模型，例如：person, dog, car。
                        </div>
                      </div>
                      {/* 标注结果汇总模块（移动到提示词右侧） */}
                      <div className="ai-summary">
                        <div className="ai-summary-left">
                          <div className="ai-summary-label">已完成AI标注</div>
                          <div className="ai-summary-count">
                            {annotationSummary?.annotatedImages ?? 0} 张
                          </div>
                        </div>
                      </div>
                    </div>
                    <button 
                      className="ai-annotation-btn"
                      onClick={handleBatchAIAutoAnnotation}
                      disabled={images.length === 0 || batchAnnotating}
                    >
                      {batchAnnotating ? '批量标注中...' : `🤖 批量AI标注 (${images.length}张)`}
                    </button>
                  </div>
                  <p className="ai-description">
                    使用Grounded SAM2模型自动识别所有图像中的对象并生成标注
                  </p>
                  
                  {/* 批量标注进度 */}
                  {batchAnnotating && (
                    <div className="ai-progress-container">
                      <div className="batch-progress-info">
                        <div className="batch-progress-stats">
                          <span>进度: {batchProgress.completed}/{batchProgress.total}</span>
                          <span>{Math.round((batchProgress.completed / batchProgress.total) * 100)}%</span>
                        </div>
                        {batchProgress.current && (
                          <div className="batch-progress-current">
                            {batchProgress.current}
                          </div>
                        )}
                      </div>
                      <div className="ai-progress-bar">
                        <div 
                          className="ai-progress-fill"
                          style={{ width: `${aiProgress}%` }}
                        />
                      </div>
                      <div className="ai-progress-text">
                        {batchProgress.completed > 0 && (
                          <div className="batch-results-summary">
                            成功: {batchProgress.results.filter(r => r.success).length} | 
                            失败: {batchProgress.results.filter(r => !r.success).length}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {/* 右上区域 - 图片预览放大 */}
            <div className="welcome-right-top">
              {selectedPreviewImage ? (
                <div className="image-preview-container">
                  <div className="preview-header">
                    <h3>{selectedPreviewImage.originalName}</h3>
                    <button 
                      className="close-preview-btn"
                      onClick={() => setSelectedPreviewImage(null)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="image-preview-wrapper">
                    {/* 左上角悬浮窗：原图 / Mask 切换 */}
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
                        className={`preview-mode-btn ${previewDisplayMode === 'mask' ? 'active' : ''}`}
                        onClick={() => setPreviewDisplayMode('mask')}
                      >
                        Mask
                      </button>
                      {previewDisplayMode === 'mask' && previewAnnoLoading && (
                        <span className="preview-mode-loading">加载中...</span>
                      )}
                    </div>

                    <div className="preview-image-layer">
                      <img 
                        src={`http://localhost:3001${selectedPreviewImage.url}?t=${Date.now()}`} 
                        alt={selectedPreviewImage.originalName}
                        className="preview-image"
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setPreviewImageSize({
                            width: img.naturalWidth,
                            height: img.naturalHeight,
                          });
                        }}
                      />

                      {previewDisplayMode === 'mask' && previewImageSize && (
                        <svg
                          className="preview-mask-overlay"
                          viewBox={`0 0 ${previewImageSize.width} ${previewImageSize.height}`}
                          preserveAspectRatio="xMidYMid meet"
                        >
                          {previewMasks.map((mask) => {
                            const pointsStr = mask.points
                              .reduce<string[]>((acc, val, idx, arr) => {
                                if (idx % 2 === 0) {
                                  const x = val;
                                  const y = arr[idx + 1];
                                  acc.push(`${x},${y}`);
                                }
                                return acc;
                              }, [])
                              .join(' ');

                            return (
                              <polygon
                                key={mask.id}
                                points={pointsStr}
                                fill={mask.color || '#ff0000'}
                                fillOpacity={mask.opacity ?? 0.25}
                                stroke={mask.color || '#ff0000'}
                                strokeWidth={2}
                                strokeOpacity={0.9}
                              />
                            );
                          })}
                        </svg>
                      )}

                      {previewDisplayMode === 'mask' && !previewAnnoLoading && previewMasks.length === 0 && (
                        <div className="preview-mask-empty">暂无 Mask</div>
                      )}
                    </div>
                  </div>
                  <div className="preview-actions">
                    <button
                      className="nav-image-btn prev-image-btn"
                      onClick={() => handlePreviewNavigate('prev')}
                      disabled={
                        images.findIndex((img: Image) => img.id === selectedPreviewImage.id) <= 0
                      }
                    >
                      ← 上一张
                    </button>

                    <div className="preview-actions-center">
                    <button 
                      className="start-annotation-btn"
                      onClick={() => handleStartManualAnnotation(selectedPreviewImage)}
                    >
                      开始人工标注
                    </button>
                    <button 
                      className="delete-image-btn"
                        onClick={async (e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定要删除图片 "${selectedPreviewImage.originalName}" 吗？`)) {
                          const imageId = selectedPreviewImage.id;
                          console.log(`[前端] 开始删除图片，ID: ${imageId}`, selectedPreviewImage);
                          
                          try {
                            dispatch(setLoading(true));
                            
                            // 调用后端API删除图片
                            console.log(`[前端] 调用API删除图片: DELETE /api/images/${imageId}`);
                            await imageApi.deleteImage(imageId);
                            console.log(`[前端] API调用成功，图片ID ${imageId} 已从数据库删除`);
                            
                          // 从Redux状态中移除图片
                          dispatch({
                            type: 'annotation/removeImage',
                              payload: imageId
                            });
                            console.log(`[前端] 已从Redux状态中移除图片ID: ${imageId}`);
                            
                            // 清空预览
                            setSelectedPreviewImage(null);
                            console.log(`[前端] 已清空预览图片`);
                            
                            // 重新加载图片列表以确保数据同步
                            if (currentProject) {
                              console.log(`[前端] 重新加载项目图片列表，项目ID: ${currentProject.id}`);
                              const loadedImages = await imageApi.getImages(currentProject.id);
                              dispatch(setImages(loadedImages));
                              console.log(`[前端] 图片列表已刷新，当前图片数量: ${loadedImages.length}`);
                            }
                            
                            console.log(`[前端] 删除图片流程完成，图片ID: ${imageId}`);
                          } catch (error: any) {
                            console.error(`[前端] 删除图片失败，图片ID: ${imageId}:`, error);
                            dispatch(setError(error.message || '删除图片失败'));
                            alert(`删除图片失败: ${error.message || '未知错误'}`);
                          } finally {
                            dispatch(setLoading(false));
                          }
                        }
                      }}
                    >
                      🗑️ 删除图片
                      </button>
                    </div>

                    <button
                      className="nav-image-btn next-image-btn"
                      onClick={() => handlePreviewNavigate('next')}
                      disabled={
                        images.findIndex((img: Image) => img.id === selectedPreviewImage.id) ===
                        images.length - 1
                      }
                    >
                      下一张 →
                    </button>
                  </div>
                </div>
              ) : (
                <div className="no-preview-selected">
                  <div className="preview-placeholder">
                    <span className="preview-icon">🔍</span>
                    <p>点击下方缩略图查看详情</p>
                  </div>
                </div>
              )}
            </div>
            
            {/* 下方区域 - 缩略图网格 */}
            {currentProject && images.length > 0 && (
              <div className="welcome-bottom">
                <div className="uploaded-images-preview">
                  <div className="preview-header uploaded-preview-header">
                    <h3>已上传图片 ({images.length})</h3>
                    <button
                      type="button"
                      className={`thumbnail-mask-toggle ${showThumbnailMasks ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowThumbnailMasks((v) => !v);
                      }}
                      title="切换缩略图Mask预览"
                    >
                      Mask预览：{showThumbnailMasks ? '开' : '关'}
                    </button>
                    <div className="project-info">
                      <span className="project-name">项目: {currentProject.name}</span>
                      <span className="project-id">ID: {currentProject.id}</span>
                    </div>
                  </div>
                  <div className="thumbnails-grid">
                    {images.slice(0, 12).map((image: Image) => (
                      <div 
                        key={image.id}
                        className={`thumbnail-item-small ${selectedPreviewImage?.id === image.id ? 'selected' : ''}`}
                        onClick={() => setSelectedPreviewImage(image)}
                        onMouseEnter={() => ensureThumbnailMasks(image.id)}
                      >
                        <div className="thumbnail-image-layer">
                          <img 
                            src={`http://localhost:3001${image.url}?t=${Date.now()}`} 
                            alt={image.originalName}
                            onError={() => {
                              console.error('❌ 图片加载失败:', image.url);
                            }}
                            onLoad={(e) => {
                              const imgEl = e.currentTarget;
                              setThumbnailSizes(prev => ({
                                ...prev,
                                [image.id]: {
                                  width: imgEl.naturalWidth,
                                  height: imgEl.naturalHeight,
                                },
                              }));
                              console.log('✅ 图片加载成功:', image.url);
                            }}
                          />

                          {showThumbnailMasks && thumbnailMasks[image.id] && thumbnailSizes[image.id] && (
                            <svg
                              className="thumbnail-mask-overlay"
                              viewBox={`0 0 ${thumbnailSizes[image.id].width} ${thumbnailSizes[image.id].height}`}
                              preserveAspectRatio="xMidYMid slice"
                            >
                              {thumbnailMasks[image.id].map((mask) => {
                                const pointsStr = mask.points
                                  .reduce<string[]>((acc, val, idx, arr) => {
                                    if (idx % 2 === 0) {
                                      const x = val;
                                      const y = arr[idx + 1];
                                      acc.push(`${x},${y}`);
                                    }
                                    return acc;
                                  }, [])
                                  .join(' ');

                                return (
                                  <polygon
                                    key={mask.id}
                                    points={pointsStr}
                                    fill={mask.color || '#ff0000'}
                                    fillOpacity={mask.opacity ?? 0.25}
                                    stroke={mask.color || '#ff0000'}
                                    strokeWidth={1.5}
                                    strokeOpacity={0.9}
                                  />
                                );
                              })}
                            </svg>
                          )}
                        </div>

                        <div className="thumbnail-overlay">
                          <span className="thumbnail-name">{image.originalName}</span>
                        </div>
                      </div>
                    ))}
                    {images.length > 12 && (
                      <div className="thumbnail-item-small more-indicator">
                        <div className="more-count">+{images.length - 12}</div>
                        <div className="more-text">更多图片</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 提示词配置弹窗 */}
      {showPromptModal && (
        <div
          className="ai-prompt-modal-backdrop"
          onClick={() => setShowPromptModal(false)}
        >
          <div
            className="ai-prompt-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ai-prompt-modal-title">配置提示词</h3>
            <p className="ai-prompt-modal-desc">
              每行一个提示词，例如：person、dog、car。留空则由模型自动识别常见目标。
            </p>
            <div className="ai-prompt-modal-list">
              {aiPrompts.map((value, index) => (
                <input
                  key={index}
                  className="ai-prompt-input"
                  type="text"
                  placeholder={`提示词 ${index + 1}`}
                  value={value}
                  onChange={(e) => {
                    const newList = [...aiPrompts];
                    newList[index] = e.target.value;
                    setAiPrompts(newList);
                    const joined = newList
                      .map((p) => p.trim())
                      .filter((p) => p.length > 0)
                      .join(', ');
                    setAiPrompt(joined);
                  }}
                />
              ))}
              <button
                type="button"
                className="ai-prompt-add"
                onClick={() => setAiPrompts([...aiPrompts, ''])}
              >
                + 新增提示词
              </button>
            </div>
            <div className="ai-prompt-modal-actions">
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => setShowPromptModal(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default AnnotationPage;