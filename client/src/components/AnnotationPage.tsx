import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setImages, setLoading, setError, setCurrentImage } from '../store/annotationSlice';
import { imageApi, annotationApi, projectApi } from '../services/api';
import type { Image, Mask, BoundingBox } from '../types';
import ImageUploader from './ImageUploader';
import AIAnnotationPreview from './AIAnnotationPreview';
import './AnnotationPage.css';

const AnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { images, loading, error } = useSelector((state: any) => state.annotation);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<Image | null>(null);
  const [currentProject, setCurrentProject] = useState<any>(null);  // 当前项目
  const [aiAnnotating, setAiAnnotating] = useState(false);  // AI标注进行中
  const [aiProgress, setAiProgress] = useState(0);  // AI标注进度 0-100
  const [aiProgressMessage, setAiProgressMessage] = useState('');  // 进度消息
  const [aiAnnotationResult, setAiAnnotationResult] = useState<{
    image: Image;
    annotations: { masks: Mask[]; boundingBoxes: BoundingBox[] };
  } | null>(null);  // AI标注结果（单张预览）
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
  const [previewAnnotatedImages, setPreviewAnnotatedImages] = useState<Image[]>([]); // 预览中可切换的已标注图片列表
  const [annotationSummary, setAnnotationSummary] = useState<{
    totalImages: number;
    annotatedImages: number;
    latestAnnotatedImageId: number | null;
    latestUpdatedAt: string | null;
  } | null>(null);

  // 统一的颜色调色板（与 AIAnnotationPreview 中保持一致）
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

  // 保存AI标注结果
  const handleSaveAIAnnotation = async () => {
    if (!aiAnnotationResult) return;

    try {
      dispatch(setLoading(true));
      // 如果当前结果还没有颜色，则为其分配颜色；否则沿用已有颜色
      const hasAnyColor =
        aiAnnotationResult.annotations.masks.some(m => !!m.color) ||
        aiAnnotationResult.annotations.boundingBoxes.some(b => !!b.color);

      const colored = hasAnyColor
        ? aiAnnotationResult.annotations
        : assignColorsForAnnotations(aiAnnotationResult.annotations);

      await annotationApi.saveAnnotation(aiAnnotationResult.image.id, {
        masks: colored.masks,
        boundingBoxes: colored.boundingBoxes,
        polygons: [],
      });
      alert('标注已保存！');
      setAiAnnotationResult(null);
    } catch (error: any) {
      console.error('保存标注失败:', error);
      alert(`保存标注失败: ${error.message || '未知错误'}`);
    } finally {
      dispatch(setLoading(false));
    }
  };

  // 编辑AI标注结果（跳转到手动标注页面）
  const handleEditAIAnnotation = () => {
    if (!aiAnnotationResult) return;
    dispatch(setCurrentImage(aiAnnotationResult.image));
    setAiAnnotationResult(null);
    navigate('./manual-annotation');
  };

  // 在AI预览弹窗中切换图片
  const handleSelectPreviewImage = async (targetImage: Image) => {
    try {
      const resp = await annotationApi.getAnnotation(targetImage.id);
      const anno = resp?.annotation;
      if (!anno) {
        alert('该图片暂无AI标注数据');
        return;
      }
      setAiAnnotationResult({
        image: targetImage,
        annotations: {
          masks: anno.masks || [],
          boundingBoxes: anno.boundingBoxes || [],
        },
      });
    } catch (e: any) {
      console.error('切换预览图片失败:', e);
      alert(e?.message || '切换预览图片失败');
    }
  };

  // 打开批量结果的预览（默认查看最新一张已标注的图片）
  const handleOpenBatchPreview = async () => {
    console.log('🔍 handleOpenBatchPreview 调用');
    console.log('当前项目:', currentProject);
    console.log('annotationSummary:', annotationSummary);
    console.log('当前内存中的图片列表(images):', images);

    const latestIdRaw = annotationSummary?.latestAnnotatedImageId;
    const latestId = latestIdRaw != null ? Number(latestIdRaw) : null;
    console.log('最新已标注图片ID latestAnnotatedImageId(raw):', latestIdRaw, ' parsed:', latestId);

    if (!latestId) {
      console.warn('handleOpenBatchPreview: latestAnnotatedImageId 为空');
      alert('当前还没有AI标注结果');
      return;
    }

    // 先在当前内存中的图片列表里查找
    let image = images.find((img: Image) => img.id === latestId);
    console.log('在当前 images 中匹配到的图片:', image);

    // 如果没找到，尝试重新加载一次项目图片列表
    if (!image && currentProject) {
      try {
        console.log('在当前 images 中未找到，尝试重新加载项目图片列表，项目ID:', currentProject.id);
        const freshImages = await imageApi.getImages(currentProject.id);
        console.log('重新加载的图片列表 freshImages:', freshImages);
        dispatch(setImages(freshImages));
        image = freshImages.find((img: Image) => img.id === latestId) || null;
        console.log('在 freshImages 中匹配到的图片:', image);
      } catch (e) {
        console.warn('刷新项目图片列表失败:', e);
      }
    }

    if (!image) {
      console.error('handleOpenBatchPreview: 依然找不到图片, latestId =', latestId);
      // 退一步兜底：遍历当前项目所有图片，找到第一张已经有标注的图片
      if (!currentProject) {
        alert('找不到可预览的图片（请刷新页面后重试）');
        return;
      }
      try {
        console.log('尝试兜底：遍历项目全部图片，查找已有标注的图片，项目ID:', currentProject.id);
        const freshImages = await imageApi.getImages(currentProject.id);
        console.log('兜底 freshImages:', freshImages);

        const annotatedList: Image[] = [];
        let firstAnnotatedImage: Image | null = null;
        let firstAnnotatedAnno: any = null;

        for (const img of freshImages as Image[]) {
          try {
            console.log('尝试获取图片标注, imageId =', img.id);
            const resp = await annotationApi.getAnnotation(img.id);
            console.log('标注响应 resp:', resp);
            if (resp?.annotation) {
              annotatedList.push(img);
              if (!firstAnnotatedImage) {
                firstAnnotatedImage = img;
                firstAnnotatedAnno = resp.annotation;
              }
            }
          } catch (e) {
            console.warn('获取单张图片标注失败, imageId =', img.id, e);
          }
        }

        if (!firstAnnotatedImage || !firstAnnotatedAnno) {
          alert('该项目暂无可预览的AI标注结果');
          return;
        }

        console.log('兜底找到可预览图片及标注:', {
          image: firstAnnotatedImage,
          masks: firstAnnotatedAnno.masks,
          boundingBoxes: firstAnnotatedAnno.boundingBoxes,
        });

        setAiAnnotationResult({
          image: firstAnnotatedImage,
          annotations: {
            masks: firstAnnotatedAnno.masks || [],
            boundingBoxes: firstAnnotatedAnno.boundingBoxes || [],
          },
        });
        // 兜底时也构建一个已标注图片列表，方便在预览中切换
        if (annotatedList.length > 0) {
          setPreviewAnnotatedImages(annotatedList);
        }
        return;
      } catch (e) {
        console.error('兜底查找可预览图片失败:', e);
        alert('找不到可预览的图片（请刷新页面后重试）');
        return;
      }
    }

    try {
      console.log('开始从后端获取标注数据, imageId =', latestId);
      const resp = await annotationApi.getAnnotation(latestId);
      console.log('后端返回的标注响应 resp:', resp);
      const anno = resp?.annotation;
      if (!anno) {
        console.warn('handleOpenBatchPreview: annotation 为空');
        alert('该图片暂无标注数据');
        return;
      }
      console.log('解析到的标注数据 masks/boundingBoxes:', {
        masks: anno.masks,
        boundingBoxes: anno.boundingBoxes,
      });
      setAiAnnotationResult({
        image,
        annotations: {
          masks: anno.masks || [],
          boundingBoxes: anno.boundingBoxes || [],
        },
      });

      // 打开预览时，根据当前项目构建一个“已有AI标注的图片”列表，用于右侧缩略图切换
      if (currentProject) {
        try {
          const freshImages = await imageApi.getImages(currentProject.id);
          const annotatedList: Image[] = [];
          for (const img of freshImages as Image[]) {
            try {
              const r = await annotationApi.getAnnotation(img.id);
              if (r?.annotation) {
                annotatedList.push(img);
              }
            } catch {
              // 单张失败忽略
            }
          }
          if (annotatedList.length > 0) {
            setPreviewAnnotatedImages(annotatedList);
          }
        } catch (e) {
          console.warn('构建已标注图片列表失败:', e);
        }
      }
    } catch (err) {
      console.error('获取标注数据失败:', err);
      alert('获取标注数据失败，请检查后端服务');
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
                  
                  {/* 标注结果汇总模块 */}
                  <div className="ai-summary">
                    <div className="ai-summary-left">
                      <div className="ai-summary-label">已完成AI标注</div>
                      <div className="ai-summary-count">
                        {annotationSummary?.annotatedImages ?? 0} 张
                      </div>
                    </div>
                    <div className="ai-summary-right">
                      <button 
                        className="ai-summary-btn"
                        onClick={handleOpenBatchPreview}
                        disabled={!annotationSummary?.annotatedImages}
                      >
                        查看预览
                      </button>
                    </div>
                  </div>
                  
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
                    <img 
                      src={`http://localhost:3001${selectedPreviewImage.url}?t=${Date.now()}`} 
                      alt={selectedPreviewImage.originalName}
                      className="preview-image"
                    />
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
                  <div className="preview-header">
                    <h3>已上传图片 ({images.length})</h3>
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
                      >
                        <img 
                          src={`http://localhost:3001${image.url}?t=${Date.now()}`} 
                          alt={image.originalName}
                          onError={() => {
                            console.error('❌ 图片加载失败:', image.url);
                          }}
                          onLoad={() => {
                            console.log('✅ 图片加载成功:', image.url);
                          }}
                        />
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

      {/* AI标注结果预览 */}
      {aiAnnotationResult && (
        <AIAnnotationPreview
          image={aiAnnotationResult.image}
          annotations={aiAnnotationResult.annotations}
          images={previewAnnotatedImages}
          currentImageId={aiAnnotationResult.image.id}
          onSelectImage={handleSelectPreviewImage}
          onClose={() => setAiAnnotationResult(null)}
          onSave={handleSaveAIAnnotation}
          onEdit={handleEditAIAnnotation}
        />
      )}
    </div>
  );
};

export default AnnotationPage;