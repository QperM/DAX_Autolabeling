import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const [showThumbnailMasks, setShowThumbnailMasks] = useState(false);
  // 缩略图虚拟滚动（Windows 文件管理器式：只渲染视口范围内）
  const thumbnailsScrollRef = useRef<HTMLDivElement | null>(null);
  const thumbnailsMeasureRef = useRef<HTMLDivElement | null>(null);
  // callback ref 的兜底：确保节点挂载时能触发重新测量（避免条件渲染导致测量为 0）
  const [thumbScrollEl, setThumbScrollEl] = useState<HTMLDivElement | null>(null);
  const [thumbMeasureEl, setThumbMeasureEl] = useState<HTMLDivElement | null>(null);
  const thumbScrollRafRef = useRef<number | null>(null);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewport, setThumbViewport] = useState({ width: 0, height: 0 });
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
  const [showLabelMappingModal, setShowLabelMappingModal] = useState(false); // 是否显示 label 对照表弹窗
  const [colorLabelMapping, setColorLabelMapping] = useState<Map<string, string>>(new Map()); // 颜色 -> label 映射
  const [labelMappingLoading, setLabelMappingLoading] = useState(false); // 加载/保存中
  const [showModelParamModal, setShowModelParamModal] = useState(false); // 是否显示模型参数弹窗
  const [modelParams, setModelParams] = useState<{
    baseScoreThresh: number;
    lowerScoreThresh: number;
    maxDetections: number;
    maskThreshold: number;
    maxPolygonPoints: number;
  }>({
    baseScoreThresh: 0.5,
    lowerScoreThresh: 0.3,
    maxDetections: 50,
    maskThreshold: 0.5,
    maxPolygonPoints: 80,
  });

  // 图片 URL 缓存破坏因子：只在列表内容发生变化时更新，避免每次 render 都触发图片重新请求
  const [imageCacheBust, setImageCacheBust] = useState(0);

  // 统一的颜色调色板（项目级、按 label 固定）
  // 使用一组高对比度颜色，便于在同一项目中区分不同目标
  const COLOR_PALETTE = [
    '#1F77B4', // 亮蓝 - 人 / 高优先级目标
    '#FF7F0E', // 橙红 - 狗 / 第二优先级
    '#2CA02C', // 翠绿 - 车辆 / 物体
    '#D62728', // 砖红 - 危险/重要区域
    '#9467BD', // 紫罗兰 - 猫 / 其他主体
    '#8C564B', // 棕褐 - 家具/树木
    '#E377C2', // 粉红 - 小物件
    '#7F7F7F', // 灰绿/灰 - 其他/次要目标
  ];

  // 项目级 label -> color 映射表（同一项目内保持稳定）
  const labelColorMapRef = React.useRef<Map<string, string>>(new Map());

  // 加载当前项目的模型参数（从 localStorage）
  useEffect(() => {
    if (!currentProject || !currentProject.id) {
      setModelParams({
        baseScoreThresh: 0.5,
        lowerScoreThresh: 0.3,
        maxDetections: 50,
        maskThreshold: 0.5,
        maxPolygonPoints: 80,
      });
      return;
    }
    const key = `modelParams:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        baseScoreThresh: number;
        lowerScoreThresh: number;
        maxDetections: number;
        maskThreshold: number;
        maxPolygonPoints: number;
      }>;
      setModelParams({
        baseScoreThresh: typeof parsed.baseScoreThresh === 'number' ? parsed.baseScoreThresh : 0.5,
        lowerScoreThresh: typeof parsed.lowerScoreThresh === 'number' ? parsed.lowerScoreThresh : 0.3,
        maxDetections: typeof parsed.maxDetections === 'number' ? parsed.maxDetections : 50,
        maskThreshold: typeof parsed.maskThreshold === 'number' ? parsed.maskThreshold : 0.5,
        maxPolygonPoints: typeof parsed.maxPolygonPoints === 'number' ? parsed.maxPolygonPoints : 80,
      });
    } catch (e) {
      console.warn('加载模型参数失败，将使用默认值', e);
    }
  }, [currentProject?.id]);

  const saveModelParamsToStorage = () => {
    if (!currentProject || !currentProject.id) return;
    const key = `modelParams:${currentProject.id}`;
    try {
      localStorage.setItem(key, JSON.stringify(modelParams));
    } catch (e) {
      console.warn('保存模型参数失败', e);
    }
  };

  // 切换项目时，重置当前项目的颜色映射
  useEffect(() => {
    labelColorMapRef.current = new Map();
  }, [currentProject?.id]);

  useEffect(() => {
    // project 或图片列表变动时更新一次即可
    setImageCacheBust((v) => (v + 1) % 1_000_000);
  }, [currentProject?.id, images.length]);

  useEffect(() => {
    // 注意：缩略图容器是条件渲染的（项目/图片加载后才出现），所以这里必须在依赖变化时重试挂载
    const scrollEl = thumbScrollEl || thumbnailsScrollRef.current;
    const measureEl = thumbMeasureEl || thumbnailsMeasureRef.current;
    if (!scrollEl || !measureEl) return;

    const updateViewport = () => {
      const cs = window.getComputedStyle(measureEl);
      const padLeft = parseFloat(cs.paddingLeft || '0') || 0;
      const padRight = parseFloat(cs.paddingRight || '0') || 0;
      // 用 scroll 容器的 clientWidth 更稳定（避免内部绝对定位导致测量异常）
      const contentW = Math.max(0, Math.round(scrollEl.clientWidth - padLeft - padRight));
      const contentH = Math.max(0, Math.round(scrollEl.clientHeight));

      setThumbViewport((prev) => {
        if (prev.width === contentW && prev.height === contentH) return prev;
        return { width: contentW, height: contentH };
      });
      setThumbScrollTop(scrollEl.scrollTop || 0);
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
    };
  }, [currentProject?.id, images.length, thumbScrollEl, thumbMeasureEl]);

  const THUMB_SIZE = 125;
  const THUMB_GAP = 16; // 对应 CSS gap: 1rem
  const thumbStride = THUMB_SIZE + THUMB_GAP;

  const thumbCols = useMemo(() => {
    const w = thumbViewport.width;
    if (!w) return 1;
    return Math.max(1, Math.floor((w + THUMB_GAP) / thumbStride));
  }, [thumbViewport.width, thumbStride, THUMB_GAP]);

  const thumbTotalRows = useMemo(() => {
    return Math.ceil(images.length / thumbCols);
  }, [images.length, thumbCols]);

  const thumbTotalHeight = useMemo(() => {
    if (images.length === 0) return 0;
    return Math.max(0, thumbTotalRows * THUMB_SIZE + Math.max(0, thumbTotalRows - 1) * THUMB_GAP);
  }, [thumbTotalRows, images.length]);

  const virtualThumbRange = useMemo(() => {
    const viewH = thumbViewport.height || 0;
    const overscanRows = 2;
    const rowHeight = thumbStride;
    const startRow = Math.max(0, Math.floor((thumbScrollTop - overscanRows * rowHeight) / rowHeight));
    const endRow = Math.min(
      Math.max(0, thumbTotalRows - 1),
      Math.ceil((thumbScrollTop + viewH + overscanRows * rowHeight) / rowHeight)
    );
    const startIndex = startRow * thumbCols;
    const endIndex = Math.min(images.length, (endRow + 1) * thumbCols);
    return { startIndex, endIndex };
  }, [thumbCols, thumbScrollTop, thumbTotalRows, thumbViewport.height, images.length, thumbStride]);

  const visibleThumbImages = useMemo(() => {
    return images.slice(virtualThumbRange.startIndex, virtualThumbRange.endIndex);
  }, [images, virtualThumbRange.startIndex, virtualThumbRange.endIndex]);

  const assignColorsForAnnotations = (input: { masks: Mask[]; boundingBoxes: BoundingBox[] }) => {
    const labelColorMap = labelColorMapRef.current;

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

  // 当开启缩略图 Mask 预览或可视区域变化时，为当前视口内的缩略图预加载 Mask
  useEffect(() => {
    if (!showThumbnailMasks) return;
    if (!visibleThumbImages || visibleThumbImages.length === 0) return;

    visibleThumbImages.forEach((img: Image) => {
      ensureThumbnailMasks(img.id);
    });
  }, [showThumbnailMasks, visibleThumbImages]);

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

  // 加载项目中所有标注的颜色-label 映射
  const loadColorLabelMapping = async () => {
    if (!currentProject || images.length === 0) {
      setColorLabelMapping(new Map());
      return;
    }

    setLabelMappingLoading(true);
    try {
      const colorMap = new Map<string, string>();

      // 遍历所有图片，收集颜色和对应的 label
      for (const image of images) {
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) continue;

          // 收集 masks 的颜色-label 映射
          if (anno.masks) {
            anno.masks.forEach((mask: Mask) => {
              if (mask.color && mask.label) {
                // 如果该颜色还没有映射，或者当前 label 更常见，则更新
                if (!colorMap.has(mask.color)) {
                  colorMap.set(mask.color, mask.label);
                }
              }
            });
          }

          // 收集 bboxes 的颜色-label 映射
          if (anno.boundingBoxes) {
            anno.boundingBoxes.forEach((bbox: BoundingBox) => {
              if (bbox.color && bbox.label) {
                if (!colorMap.has(bbox.color)) {
                  colorMap.set(bbox.color, bbox.label);
                }
              }
            });
          }
        } catch (e) {
          console.warn(`[loadColorLabelMapping] 加载图片 ${image.id} 标注失败:`, e);
        }
      }

      setColorLabelMapping(colorMap);
      console.log('[loadColorLabelMapping] 已收集颜色-label 映射:', Array.from(colorMap.entries()));
    } catch (e) {
      console.error('[loadColorLabelMapping] 加载颜色-label 映射失败:', e);
      alert('加载颜色-label 映射失败: ' + (e as Error).message);
    } finally {
      setLabelMappingLoading(false);
    }
  };

  // 批量保存颜色-label 映射到所有图片
  const saveColorLabelMapping = async () => {
    if (!currentProject || images.length === 0) {
      alert('当前没有可更新的图片');
      return;
    }

    const confirmMsg = `确定要将颜色-label 映射应用到所有 ${images.length} 张图片的标注吗？\n\n` +
      `这将按颜色批量修改所有标注的 label。`;
    if (!window.confirm(confirmMsg)) {
      return;
    }

    setLabelMappingLoading(true);
    let successCount = 0;
    let failCount = 0;

    try {
      for (const image of images) {
        try {
          // 获取当前图片的标注
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) {
            continue; // 没有标注的图片跳过
          }

          let hasChanges = false;

          // 更新 masks 的 label（按颜色）
          const updatedMasks = (anno.masks || []).map((mask: Mask) => {
            if (mask.color && colorLabelMapping.has(mask.color)) {
              const newLabel = colorLabelMapping.get(mask.color)!;
              if (mask.label !== newLabel) {
                hasChanges = true;
                return { ...mask, label: newLabel };
              }
            }
            return mask;
          });

          // 更新 bboxes 的 label（按颜色）
          const updatedBBoxes = (anno.boundingBoxes || []).map((bbox: BoundingBox) => {
            if (bbox.color && colorLabelMapping.has(bbox.color)) {
              const newLabel = colorLabelMapping.get(bbox.color)!;
              if (bbox.label !== newLabel) {
                hasChanges = true;
                return { ...bbox, label: newLabel };
              }
            }
            return bbox;
          });

          // 如果有变化，保存
          if (hasChanges) {
            await annotationApi.saveAnnotation(image.id, {
              masks: updatedMasks,
              boundingBoxes: updatedBBoxes,
              polygons: anno.polygons || [],
            });
            successCount++;
          } else {
            successCount++; // 没有变化也算成功
          }
        } catch (e) {
          console.error(`[saveColorLabelMapping] 更新图片 ${image.id} 失败:`, e);
          failCount++;
        }
      }

      // 同步更新项目级 label -> color 映射（供画布 R 键、整块改名使用）
      try {
        const labelColorMap: Record<string, string> = {};
        for (const [color, label] of colorLabelMapping.entries()) {
          const trimmed = label.trim();
          if (!trimmed) continue;
          if (labelColorMap[trimmed]) continue; // 已有同名 label，则保持先出现的那一个颜色
          labelColorMap[trimmed] = color;
        }
        const storageKey = `labelColorMap:${currentProject.id}`;
        localStorage.setItem(storageKey, JSON.stringify(labelColorMap));
      } catch (e) {
        console.warn('[saveColorLabelMapping] 同步 labelColorMap 到 localStorage 失败:', e);
      }

      alert(`批量更新完成！\n\n成功: ${successCount} 张\n失败: ${failCount} 张`);
      setShowLabelMappingModal(false);
      
      // 刷新标注汇总和预览
      await refreshAnnotationSummary();
      if (selectedPreviewImage && previewDisplayMode === 'mask') {
        loadPreviewMasks(selectedPreviewImage.id);
      }
    } catch (e) {
      console.error('[saveColorLabelMapping] 批量保存失败:', e);
      alert('批量保存失败: ' + (e as Error).message);
    } finally {
      setLabelMappingLoading(false);
    }
  };

  // 删除某个颜色对应的所有标注（跨项目所有图片）
  const deleteAnnotationsByColor = async (targetColor: string) => {
    if (!currentProject || images.length === 0) {
      alert('当前没有可更新的图片');
      return;
    }

    const label = (colorLabelMapping.get(targetColor) || '').trim();
    const confirmMsg =
      `确定要删除该颜色对应的所有标注吗？\n\n` +
      `颜色: ${targetColor}${label ? `\nLabel: ${label}` : ''}\n\n` +
      `这会遍历所有 ${images.length} 张图片，并删除所有 color = ${targetColor} 的 Mask / 框。\n` +
      `该操作不可撤销。`;
    if (!window.confirm(confirmMsg)) return;

    setLabelMappingLoading(true);
    let affectedImages = 0;
    let deletedMasks = 0;
    let deletedBBoxes = 0;
    let failCount = 0;

    try {
      for (const image of images) {
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) continue;

          const beforeMasks = (anno.masks || []) as Mask[];
          const beforeBBoxes = (anno.boundingBoxes || []) as BoundingBox[];

          const afterMasks = beforeMasks.filter((m) => m.color !== targetColor);
          const afterBBoxes = beforeBBoxes.filter((b) => b.color !== targetColor);

          const masksRemoved = beforeMasks.length - afterMasks.length;
          const bboxesRemoved = beforeBBoxes.length - afterBBoxes.length;
          if (masksRemoved === 0 && bboxesRemoved === 0) continue;

          deletedMasks += masksRemoved;
          deletedBBoxes += bboxesRemoved;
          affectedImages += 1;

          await annotationApi.saveAnnotation(image.id, {
            masks: afterMasks,
            boundingBoxes: afterBBoxes,
            polygons: anno.polygons || [],
          });
        } catch (e) {
          console.error(`[deleteAnnotationsByColor] 更新图片 ${image.id} 失败:`, e);
          failCount++;
        }
      }

      // 更新当前弹窗内的映射表：移除该颜色条目
      const nextMap = new Map(colorLabelMapping);
      nextMap.delete(targetColor);
      setColorLabelMapping(nextMap);

      // 同步更新项目级 label -> color 映射（供画布 R 键、整块改名使用）
      try {
        const labelColorMap: Record<string, string> = {};
        for (const [color, l] of nextMap.entries()) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          if (labelColorMap[trimmed]) continue;
          labelColorMap[trimmed] = color;
        }
        const storageKey = `labelColorMap:${currentProject.id}`;
        localStorage.setItem(storageKey, JSON.stringify(labelColorMap));
      } catch (e) {
        console.warn('[deleteAnnotationsByColor] 同步 labelColorMap 到 localStorage 失败:', e);
      }

      // 清理缩略图缓存，避免 UI 仍显示旧 masks
      setThumbnailMasks({});

      await refreshAnnotationSummary();
      if (selectedPreviewImage && previewDisplayMode === 'mask') {
        loadPreviewMasks(selectedPreviewImage.id);
      }

      alert(
        `删除完成！\n\n` +
          `影响图片: ${affectedImages} 张\n` +
          `删除 Masks: ${deletedMasks}\n` +
          `删除 框: ${deletedBBoxes}\n` +
          `失败: ${failCount} 张`
      );
    } catch (e) {
      console.error('[deleteAnnotationsByColor] 批量删除失败:', e);
      alert('批量删除失败: ' + (e as Error).message);
    } finally {
      setLabelMappingLoading(false);
    }
  };

  const handleUploadComplete = (newImages: Image[]) => {
    if (!currentProject) {
      alert('请先创建或选择项目！');
      return;
    }
    console.log('上传完成:', newImages);
    // 上传接口已在后端完成“图片入库 + 关联项目”
    // 这里做一次刷新，确保 ZIP 解压批量导入等场景下列表与数据库完全一致
    (async () => {
      try {
        dispatch(setLoading(true));
        const loadedImages = await imageApi.getImages(currentProject.id);
        dispatch(setImages(loadedImages));
      } catch (e: any) {
        console.warn('[AnnotationPage] 上传后刷新图片列表失败:', e);
      } finally {
        dispatch(setLoading(false));
      }
    })();
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
          // 调用后端AI标注API（携带当前项目的模型参数）
          const result = await annotationApi.autoAnnotate(image.id, aiPrompt || undefined, modelParams);

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
                        <button
                          type="button"
                          className="ai-model-config-btn"
                          onClick={() => {
                            if (!currentProject) {
                              alert('请先选择项目');
                              return;
                            }
                            setShowModelParamModal(true);
                          }}
                        >
                          调整模型参数
                        </button>
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
                    {/* Mask Label 对照表按钮 */}
                    <button
                      type="button"
                      className="label-mapping-btn"
                      onClick={async () => {
                        if (!currentProject) {
                          alert('请先选择项目');
                          return;
                        }
                        setShowLabelMappingModal(true);
                        await loadColorLabelMapping();
                      }}
                    >
                      🏷️ Mask Label 对照表
                    </button>
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
                      src={`http://localhost:3001${selectedPreviewImage.url}?v=${imageCacheBust}`} 
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
                                fillOpacity={mask.opacity ?? 0.45}
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
                  <div
                    className="thumbnails-grid thumbnails-virtual-scroll"
                    ref={(el) => {
                      thumbnailsScrollRef.current = el;
                      if (thumbScrollEl !== el) setThumbScrollEl(el);
                    }}
                    onScroll={(e) => {
                      const top = (e.currentTarget as HTMLDivElement).scrollTop;
                      if (thumbScrollRafRef.current) {
                        cancelAnimationFrame(thumbScrollRafRef.current);
                      }
                      thumbScrollRafRef.current = requestAnimationFrame(() => {
                        setThumbScrollTop(top);
                      });
                    }}
                  >
                    <div
                      className="thumbnails-virtual-measure"
                      ref={(el) => {
                        thumbnailsMeasureRef.current = el;
                        if (thumbMeasureEl !== el) setThumbMeasureEl(el);
                      }}
                    >
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
                              onMouseEnter={() => ensureThumbnailMasks(image.id)}
                            >
                        <div className="thumbnail-image-layer">
                        <img 
                          src={`http://localhost:3001${image.url}?v=${imageCacheBust}`} 
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
                          );
                        })}
                      </div>
                    </div>
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
              每行一个提示词，例如：person、dog、car。留空则由模型自动识别所有常见目标。
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

      {/* 模型参数调整弹窗 */}
      {showModelParamModal && (
        <div
          className="ai-prompt-modal-backdrop"
          onClick={() => setShowModelParamModal(false)}
        >
          <div
            className="ai-prompt-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ai-prompt-modal-title">调整模型参数</h3>
            <p className="ai-prompt-modal-desc">
              这些参数会影响 Grounded SAM2 / Mask R-CNN 的检测结果，并按项目单独保存。
            </p>
            <div className="model-param-group">
              <div className="model-param-row">
                <div className="model-param-label">
                  初始置信度阈值
                  <span className="model-param-value">
                    {modelParams.baseScoreThresh.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={modelParams.baseScoreThresh}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      baseScoreThresh: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  越高越严格，低分目标会被过滤掉（默认 0.50）。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  兜底置信度下限
                  <span className="model-param-value">
                    {modelParams.lowerScoreThresh.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={modelParams.lowerScoreThresh}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      lowerScoreThresh: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  当高阈值下没有结果时，会尝试降到这个阈值再筛一轮（默认 0.30）。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  最多检测目标数
                  <span className="model-param-value">
                    {modelParams.maxDetections}
                  </span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={200}
                  step={5}
                  value={modelParams.maxDetections}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      maxDetections: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  限制每张图最多输出多少个目标，避免结果过多影响标注效率（默认 50）。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  Mask 二值化阈值（描边紧/松）
                  <span className="model-param-value">
                    {modelParams.maskThreshold.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={modelParams.maskThreshold}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      maskThreshold: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  这是把模型输出的 mask 概率图变成轮廓的阈值。调高更“收紧”但可能缺一块；调低更“外扩”但更容易粘连（默认 0.50）。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  轮廓精细度（最大点数）
                  <span className="model-param-value">
                    {modelParams.maxPolygonPoints}
                  </span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={400}
                  step={10}
                  value={modelParams.maxPolygonPoints}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      maxPolygonPoints: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  控制从 mask 轮廓抽样的最大点数。越大边缘越贴合，但生成/渲染更重（默认 80）。
                </div>
              </div>
            </div>
            <div className="ai-prompt-modal-actions">
              <button
                type="button"
                className="ai-prompt-modal-btn secondary"
                onClick={() => {
                  // 恢复默认参数但不立即保存
                  setModelParams({
                    baseScoreThresh: 0.5,
                    lowerScoreThresh: 0.3,
                    maxDetections: 50,
                    maskThreshold: 0.5,
                    maxPolygonPoints: 80,
                  });
                }}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => {
                  saveModelParamsToStorage();
                  setShowModelParamModal(false);
                }}
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mask Label 对照表弹窗 */}
      {showLabelMappingModal && (
        <div
          className="ai-prompt-modal-backdrop"
          onClick={() => !labelMappingLoading && setShowLabelMappingModal(false)}
        >
          <div
            className="label-mapping-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ai-prompt-modal-title">Mask Label 对照表</h3>
            <p className="ai-prompt-modal-desc">
              左侧显示颜色，右侧可编辑对应的 label。保存后将应用到整个项目的所有图片标注。
            </p>
            {labelMappingLoading && colorLabelMapping.size === 0 ? (
              <div className="label-mapping-loading">加载中...</div>
            ) : colorLabelMapping.size === 0 ? (
              <div className="label-mapping-empty">当前项目暂无标注数据</div>
            ) : (
              <div className="label-mapping-list">
                {Array.from(colorLabelMapping.entries()).map(([color, label]) => (
                  <div key={color} className="label-mapping-item">
                    <span
                      className="label-mapping-color-dot"
                      style={{ backgroundColor: color }}
                    />
                    <input
                      className="label-mapping-input"
                      type="text"
                      value={label}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const trimmed = raw.trim();
                        const newMap = new Map(colorLabelMapping);
                        newMap.set(color, raw);

                        // 保证一个 label 只对应一种颜色：
                        // 如果其他颜色已经有同名 label，则移除那些条目，保留当前这一条
                        if (trimmed.length > 0) {
                          for (const [c, l] of Array.from(newMap.entries())) {
                            if (c === color) continue;
                            if (l.trim() === trimmed) {
                              newMap.delete(c);
                            }
                          }
                        }

                        setColorLabelMapping(newMap);
                      }}
                      placeholder="输入 label 名称"
                    />
                    <button
                      type="button"
                      className="label-mapping-delete-btn"
                      title="删除该颜色对应的所有标注（跨项目所有图片）"
                      disabled={labelMappingLoading}
                      onClick={() => !labelMappingLoading && deleteAnnotationsByColor(color)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-prompt-modal-actions">
              <button
                type="button"
                className="ai-prompt-modal-btn secondary"
                onClick={() => setShowLabelMappingModal(false)}
                disabled={labelMappingLoading}
              >
                取消
              </button>
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={saveColorLabelMapping}
                disabled={labelMappingLoading || colorLabelMapping.size === 0}
              >
                {labelMappingLoading ? '保存中...' : '保存并全局应用'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default AnnotationPage;