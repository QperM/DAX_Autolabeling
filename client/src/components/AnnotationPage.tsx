import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setImages, setLoading, setError, setCurrentImage } from '../store/annotationSlice';
import { imageApi, annotationApi, projectApi } from '../services/api';
import type { Image, Mask, BoundingBox, Polygon } from '../types';
import ImageUploader from './ImageUploader';
import './AnnotationPage.css';
import JSZip from 'jszip';

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
  const loadingThumbnailMasksRef = useRef<Set<number>>(new Set()); // 正在加载的 mask ID 集合
  // 缩略图虚拟滚动（Windows 文件管理器式：只渲染视口范围内）
  const thumbnailsScrollRef = useRef<HTMLDivElement | null>(null);
  const thumbnailsMeasureRef = useRef<HTMLDivElement | null>(null);
  // 使用 ref 而不是 state，避免 ref 回调中的 setState 导致无限循环
  const thumbScrollElRef = useRef<HTMLDivElement | null>(null);
  const thumbMeasureElRef = useRef<HTMLDivElement | null>(null);
  const thumbScrollRafRef = useRef<number | null>(null);
  const thumbViewportRafRef = useRef<number | null>(null);
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
  const [, setAnnotationSummary] = useState<{
    totalImages: number;
    annotatedImages: number;
    latestAnnotatedImageId: number | null;
    latestUpdatedAt: string | null;
  } | null>(null);
  const [showLabelMappingModal, setShowLabelMappingModal] = useState(false); // 是否显示 label 对照表弹窗
  const [colorLabelMapping, setColorLabelMapping] = useState<Map<string, string>>(new Map()); // 颜色 -> label 映射
  const [labelMappingLoading, setLabelMappingLoading] = useState(false); // 加载/保存中
  const [deleteByColorProgress, setDeleteByColorProgress] = useState<{
    active: boolean;
    total: number;
    completed: number;
    current: string;
    color: string;
    label?: string;
  }>({
    active: false,
    total: 0,
    completed: 0,
    current: '',
    color: '',
    label: '',
  });
  const [showModelParamModal, setShowModelParamModal] = useState(false); // 是否显示模型参数弹窗
  const [modelParams, setModelParams] = useState<{
    modelBackend: 'maskrcnn' | 'yolo_seg' | 'sam2_amg';
    baseScoreThresh: number;
    lowerScoreThresh: number;
    maxDetections: number;
    maskThreshold: number;
    maxPolygonPoints: number;
    // YOLO-Seg
    yoloConf: number;
    yoloIou: number;
    yoloImgSize: number;
    yoloMaxDet: number;
    // SAM2 AMG
    sam2PointsPerSide: number;
    sam2PredIouThresh: number;
    sam2StabilityScoreThresh: number;
    sam2BoxNmsThresh: number;
    sam2MinMaskRegionArea: number;
  }>({
    modelBackend: 'sam2_amg',
    baseScoreThresh: 0.5,
    lowerScoreThresh: 0.3,
    maxDetections: 50,
    maskThreshold: 0.5,
    maxPolygonPoints: 80,
    yoloConf: 0.25,
    yoloIou: 0.7,
    yoloImgSize: 640,
    yoloMaxDet: 300,
    sam2PointsPerSide: 32,
    sam2PredIouThresh: 0.88,
    sam2StabilityScoreThresh: 0.95,
    sam2BoxNmsThresh: 0.7,
    sam2MinMaskRegionArea: 0,
  });

  // 图片 URL 缓存破坏因子：只在列表内容发生变化时更新，避免每次 render 都触发图片重新请求
  const [imageCacheBust, setImageCacheBust] = useState(0);
  const [exportFormat, setExportFormat] = useState<'project' | 'labelme-zip'>('project');
  const [importExportProgress, setImportExportProgress] = useState<{
    active: boolean;
    mode: 'import' | 'export' | null;
    total: number;
    completed: number;
    current: string;
  }>({
    active: false,
    mode: null,
    total: 0,
    completed: 0,
    current: '',
  });

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
    '#17BECF', // 青色 - 辅助目标
    '#BCBD22', // 橄榄绿 - 统计/辅助区域
    '#FF9896', // 浅红 - 次要告警
    '#98DF8A', // 浅绿 - 次要物体
    '#AEC7E8', // 浅蓝 - 背景物体
    '#C49C94', // 浅棕 - 结构/支撑
    '#F7B6D2', // 浅粉 - 其他类别
    '#C5B0D5', // 淡紫
    '#FFBB78', // 淡橙
    '#FF7F7F', // 珊瑚红
    '#C7C7C7', // 浅灰
    '#DBDB8D', // 淡黄绿
    '#9EDAE5', // 天蓝
    '#FDB462', // 金橙
    '#B5CF6B', // 黄绿
    '#BD9E39', // 土黄
    '#8C6D31', // 深棕
    '#E7969C', // 玫瑰粉
    '#A55194', // 深紫
    '#6B6ECF', // 靛蓝
    '#B5A300', // 橄榄黄
    '#393B79', // 深蓝
  ];

  // 项目级 label -> color 映射表（同一项目内保持稳定）
  const labelColorMapRef = React.useRef<Map<string, string>>(new Map());

  // 加载当前项目的模型参数（从 localStorage）
  useEffect(() => {
    if (!currentProject || !currentProject.id) {
      setModelParams({
        modelBackend: 'sam2_amg',
        baseScoreThresh: 0.5,
        lowerScoreThresh: 0.3,
        maxDetections: 50,
        maskThreshold: 0.5,
        maxPolygonPoints: 80,
        yoloConf: 0.25,
        yoloIou: 0.7,
        yoloImgSize: 640,
        yoloMaxDet: 300,
        sam2PointsPerSide: 32,
        sam2PredIouThresh: 0.88,
        sam2StabilityScoreThresh: 0.95,
        sam2BoxNmsThresh: 0.7,
        sam2MinMaskRegionArea: 0,
      });
      return;
    }
    const key = `modelParams:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        modelBackend: 'maskrcnn' | 'yolo_seg' | 'sam2_amg';
        baseScoreThresh: number;
        lowerScoreThresh: number;
        maxDetections: number;
        maskThreshold: number;
        maxPolygonPoints: number;
        yoloConf: number;
        yoloIou: number;
        yoloImgSize: number;
        yoloMaxDet: number;
        sam2PointsPerSide: number;
        sam2PredIouThresh: number;
        sam2StabilityScoreThresh: number;
        sam2BoxNmsThresh: number;
        sam2MinMaskRegionArea: number;
      }>;
      setModelParams({
        modelBackend:
          parsed.modelBackend === 'yolo_seg' || parsed.modelBackend === 'sam2_amg'
            ? parsed.modelBackend
            : 'maskrcnn',
        baseScoreThresh: typeof parsed.baseScoreThresh === 'number' ? parsed.baseScoreThresh : 0.5,
        lowerScoreThresh: typeof parsed.lowerScoreThresh === 'number' ? parsed.lowerScoreThresh : 0.3,
        maxDetections: typeof parsed.maxDetections === 'number' ? parsed.maxDetections : 50,
        maskThreshold: typeof parsed.maskThreshold === 'number' ? parsed.maskThreshold : 0.5,
        maxPolygonPoints: typeof parsed.maxPolygonPoints === 'number' ? parsed.maxPolygonPoints : 80,
        yoloConf: typeof parsed.yoloConf === 'number' ? parsed.yoloConf : 0.25,
        yoloIou: typeof parsed.yoloIou === 'number' ? parsed.yoloIou : 0.7,
        yoloImgSize: typeof parsed.yoloImgSize === 'number' ? parsed.yoloImgSize : 640,
        yoloMaxDet: typeof parsed.yoloMaxDet === 'number' ? parsed.yoloMaxDet : 300,
        sam2PointsPerSide: typeof parsed.sam2PointsPerSide === 'number' ? parsed.sam2PointsPerSide : 32,
        sam2PredIouThresh: typeof parsed.sam2PredIouThresh === 'number' ? parsed.sam2PredIouThresh : 0.88,
        sam2StabilityScoreThresh:
          typeof parsed.sam2StabilityScoreThresh === 'number' ? parsed.sam2StabilityScoreThresh : 0.95,
        sam2BoxNmsThresh: typeof parsed.sam2BoxNmsThresh === 'number' ? parsed.sam2BoxNmsThresh : 0.7,
        sam2MinMaskRegionArea:
          typeof parsed.sam2MinMaskRegionArea === 'number' ? parsed.sam2MinMaskRegionArea : 0,
      });
    } catch (e) {
      console.warn('加载模型参数失败，将使用默认值', e);
    }
  }, [currentProject?.id]);

  // 加载当前项目的提示词（从 localStorage）
  useEffect(() => {
    if (!currentProject || !currentProject.id) {
      setAiPrompts([]);
      setAiPrompt('');
      return;
    }
    const key = `aiPrompts:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        setAiPrompts([]);
        setAiPrompt('');
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
      setAiPrompts(list);
      const joined = list
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .join(', ');
      setAiPrompt(joined);
    } catch (e) {
      console.warn('加载提示词失败，将使用空提示词', e);
      setAiPrompts([]);
      setAiPrompt('');
    }
  }, [currentProject?.id]);

  const saveAiPromptsToStorage = () => {
    if (!currentProject || !currentProject.id) return;
    const key = `aiPrompts:${currentProject.id}`;
    try {
      localStorage.setItem(key, JSON.stringify(aiPrompts));
    } catch (e) {
      console.warn('保存提示词失败', e);
    }
  };

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
    const scrollEl = thumbScrollElRef.current || thumbnailsScrollRef.current;
    const measureEl = thumbMeasureElRef.current || thumbnailsMeasureRef.current;
    if (!scrollEl || !measureEl) return;

    const updateViewport = () => {
      // 使用 requestAnimationFrame 防抖，避免频繁更新导致无限循环
      if (thumbViewportRafRef.current) {
        cancelAnimationFrame(thumbViewportRafRef.current);
      }
      thumbViewportRafRef.current = requestAnimationFrame(() => {
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
  const THUMB_GAP = 16; // 对应 CSS gap: 1rem
  const thumbStride = THUMB_SIZE + THUMB_GAP;

  const batchSuccessCount = useMemo(
    () => batchProgress.results.filter((r) => r.success).length,
    [batchProgress.results]
  );
  const batchFailCount = useMemo(
    () => batchProgress.results.filter((r) => !r.success).length,
    [batchProgress.results]
  );
  const showBatchResultBreakdown = batchProgress.results.length > 0;

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
    if (loadingThumbnailMasksRef.current.has(imageId)) return; // 正在加载中，避免重复请求
    
    loadingThumbnailMasksRef.current.add(imageId);
    try {
      const resp = await annotationApi.getAnnotation(imageId);
      const anno = resp?.annotation;
      if (anno?.masks) {
        setThumbnailMasks(prev => ({ ...prev, [imageId]: anno.masks }));
      }
    } catch (e) {
      console.warn('[AnnotationPage] 缩略图加载 masks 失败, imageId =', imageId, e);
    } finally {
      loadingThumbnailMasksRef.current.delete(imageId);
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

  // 保存批量标注进度到 localStorage
  const saveBatchProgressToStorage = (progress: typeof batchProgress, isAnnotating: boolean, progressPercent: number) => {
    if (!currentProject?.id) return;
    const key = `batchAnnotationProgress:${currentProject.id}`;
    try {
      const data = {
        projectId: currentProject.id,
        batchAnnotating: isAnnotating,
        batchProgress: progress,
        aiProgress: progressPercent,
        timestamp: Date.now()
      };
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('保存批量标注进度失败', e);
    }
  };

  // 清除批量标注进度
  const clearBatchProgressFromStorage = () => {
    if (!currentProject?.id) return;
    const key = `batchAnnotationProgress:${currentProject.id}`;
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('清除批量标注进度失败', e);
    }
  };

  // 从 localStorage 恢复批量标注进度
  useEffect(() => {
    if (!currentProject?.id) {
      // 如果没有项目，清除可能存在的旧进度
      setBatchAnnotating(false);
      setBatchProgress({
        total: 0,
        completed: 0,
        current: '',
        results: []
      });
      setAiProgress(0);
      return;
    }

    const key = `batchAnnotationProgress:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return;
      }
      const data = JSON.parse(raw);
      
      // 验证是否是同一个项目的进度
      if (data.projectId !== currentProject.id) {
        console.warn('批量标注进度项目ID不匹配，忽略恢复');
        return;
      }

      // 如果进度已完成（completed >= total），不恢复为进行中状态
      if (data.batchProgress && data.batchProgress.completed >= data.batchProgress.total) {
        // 只恢复结果，不恢复为进行中状态
        setBatchProgress(data.batchProgress);
        setAiProgress(100);
        setBatchAnnotating(false);
        return;
      }

      // 恢复进度状态
      if (data.batchProgress) {
        setBatchProgress(data.batchProgress);
        setAiProgress(data.aiProgress || 0);
        // 注意：如果页面刷新了，实际任务已中断，所以不恢复 batchAnnotating 为 true
        // 但保留进度显示，让用户知道之前有任务在进行
        setBatchAnnotating(false);
        console.log('[AnnotationPage] 恢复了批量标注进度:', data.batchProgress);
      }
    } catch (e) {
      console.warn('恢复批量标注进度失败', e);
    }
  }, [currentProject?.id]);

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

  // ===== Labelme JSON 兼容（导入/导出）=====
  // 参考：labelme 输出结构（version/flags/shapes/imagePath/imageData/imageHeight/imageWidth）
  type LabelmeShape = {
    label: string;
    points: number[][];
    group_id?: number | null;
    description?: string;
    shape_type: string;
    flags?: Record<string, any>;
    mask?: any;
  };

  type LabelmeJson = {
    version?: string;
    flags?: Record<string, any>;
    shapes: LabelmeShape[];
    imagePath?: string;
    imageData?: string | null;
    imageHeight?: number | null;
    imageWidth?: number | null;
    // 允许额外字段（比 labelme 多一些信息）
    [k: string]: any;
  };

  const normalizePathBaseName = (p: string) => {
    const s = String(p || '').replace(/\\/g, '/');
    const parts = s.split('/');
    return (parts[parts.length - 1] || '').trim();
  };

  const stripExt = (name: string) => {
    const n = String(name || '').trim();
    return n.replace(/\.[^.]+$/, '');
  };

  const isLabelmeJson = (obj: any): obj is LabelmeJson => {
    if (!obj || typeof obj !== 'object') return false;
    if (!Array.isArray(obj.shapes)) return false;
    // labelme 常见字段：version、imagePath、imageWidth/Height、imageData
    if ('imagePath' in obj || 'imageWidth' in obj || 'imageHeight' in obj) return true;
    // 兜底：有 shapes 也当作 labelme-like
    return true;
  };

  const flatPointsToPairs = (pts: number[]) => {
    const pairs: number[][] = [];
    const arr = Array.isArray(pts) ? pts : [];
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const x = Number(arr[i]);
      const y = Number(arr[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pairs.push([x, y]);
    }
    return pairs;
  };

  const pairsToFlatPoints = (pairs: any) => {
    const out: number[] = [];
    if (!Array.isArray(pairs)) return out;
    for (const p of pairs) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push(x, y);
    }
    return out;
  };

  const labelmeToInternal = (labelme: LabelmeJson): { masks: Mask[]; boundingBoxes: BoundingBox[]; polygons: Polygon[] } => {
    const masksOut: Mask[] = [];
    const bboxesOut: BoundingBox[] = [];
    const polygonsOut: Polygon[] = [];

    const shapes = Array.isArray(labelme?.shapes) ? labelme.shapes : [];
    const baseId = `${Date.now()}`;
    shapes.forEach((shape, idx) => {
      const shapeType = String(shape?.shape_type || '').toLowerCase();
      const label = String(shape?.label || '');
      const flags = (shape?.flags || {}) as Record<string, any>;
      const daxType = String(flags?.dax_type || '').toLowerCase();
      const daxColor = typeof flags?.dax_color === 'string' ? flags.dax_color : undefined;

      if (shapeType === 'rectangle') {
        // Labelme rectangle: points = [[x1,y1],[x2,y2]]
        const pts = Array.isArray(shape?.points) ? shape.points : [];
        const p1 = pts[0];
        const p2 = pts[1];
        if (!Array.isArray(p1) || !Array.isArray(p2) || p1.length < 2 || p2.length < 2) return;
        const x1 = Number(p1[0]);
        const y1 = Number(p1[1]);
        const x2 = Number(p2[0]);
        const y2 = Number(p2[1]);
        if (![x1, y1, x2, y2].every(Number.isFinite)) return;
        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        bboxesOut.push({
          id: `bbox-${baseId}-${idx}`,
          x,
          y,
          width,
          height,
          label,
          color: daxColor,
        });
        return;
      }

      if (shapeType === 'polygon') {
        const flat = pairsToFlatPoints(shape?.points);
        if (flat.length < 6) return; // 至少 3 个点
        const common = {
          id: `poly-${baseId}-${idx}`,
          points: flat,
          label,
          color: daxColor,
        };
        // 我们导出时会带 flags.dax_type，以便导入时恢复到 masks/polygons
        if (daxType === 'polygon') {
          polygonsOut.push({ ...common });
        } else {
          masksOut.push({
            id: `mask-${baseId}-${idx}`,
            points: flat,
            label,
            color: daxColor,
            opacity: 0.7,
          });
        }
        return;
      }

      // 其他 shape_type：先忽略，但给日志提示，避免悄悄丢数据
      console.warn('[Import][Labelme] 不支持的 shape_type，将忽略:', shapeType, shape);
    });

    return { masks: masksOut, boundingBoxes: bboxesOut, polygons: polygonsOut };
  };

  const buildLabelmeFromInternal = (args: {
    image: Image;
    masks: Mask[];
    boundingBoxes: BoundingBox[];
    polygons: Polygon[];
  }): LabelmeJson => {
    const { image, masks, boundingBoxes, polygons } = args;
    const shapes: LabelmeShape[] = [];

    (masks || []).forEach((m) => {
      shapes.push({
        label: String(m.label || ''),
        points: flatPointsToPairs(m.points || []),
        group_id: null,
        description: '',
        shape_type: 'polygon',
        flags: {
          dax_type: 'mask',
          dax_id: m.id,
          dax_color: m.color,
          dax_opacity: m.opacity,
        },
        mask: null,
      });
    });

    (polygons || []).forEach((p) => {
      shapes.push({
        label: String(p.label || ''),
        points: flatPointsToPairs(p.points || []),
        group_id: null,
        description: '',
        shape_type: 'polygon',
        flags: {
          dax_type: 'polygon',
          dax_id: p.id,
          dax_color: p.color,
        },
        mask: null,
      });
    });

    (boundingBoxes || []).forEach((b) => {
      const x1 = Number(b.x);
      const y1 = Number(b.y);
      const x2 = Number(b.x + b.width);
      const y2 = Number(b.y + b.height);
      shapes.push({
        label: String(b.label || ''),
        points: [
          [x1, y1],
          [x2, y2],
        ],
        group_id: null,
        description: '',
        shape_type: 'rectangle',
        flags: {
          dax_type: 'bbox',
          dax_id: b.id,
          dax_color: b.color,
        },
        mask: null,
      });
    });

    return {
      version: '5.5.0',
      flags: {},
      shapes,
      // Labelme 通常写原图路径；这里用 originalName（或 filename）对齐导入时的匹配规则
      imagePath: image.originalName || image.filename,
      // 不写 imageData，避免文件巨大；labelme 允许 imageData=null
      imageData: null,
      imageHeight: typeof image.height === 'number' ? image.height : null,
      imageWidth: typeof image.width === 'number' ? image.width : null,
      dax: {
        source: 'DAXautolabeling',
        imageId: image.id,
        filename: image.filename,
        url: image.url,
      },
    };
  };

  const assignColorsForAll = (input: { masks: Mask[]; boundingBoxes: BoundingBox[]; polygons: Polygon[] }) => {
    const labelColorMap = labelColorMapRef.current;
    const getColorForLabel = (label: string | undefined, fallbackIndex: number): string => {
      const key = label && label.trim().length > 0 ? label.trim() : `__unnamed_${fallbackIndex}`;
      if (labelColorMap.has(key)) return labelColorMap.get(key)!;
      const color = COLOR_PALETTE[labelColorMap.size % COLOR_PALETTE.length];
      labelColorMap.set(key, color);
      return color;
    };

    const masksColored: Mask[] = (input.masks || []).map((m, idx) => ({
      ...m,
      color: m.color || getColorForLabel(m.label, idx),
    }));

    const bboxesColored: BoundingBox[] = (input.boundingBoxes || []).map((b, idx) => ({
      ...b,
      color: b.color || getColorForLabel(b.label, (input.masks?.length || 0) + idx),
    }));

    const polygonsColored: Polygon[] = (input.polygons || []).map((p, idx) => ({
      ...p,
      color: p.color || getColorForLabel(p.label, (input.masks?.length || 0) + (input.boundingBoxes?.length || 0) + idx),
    }));

    return { masks: masksColored, boundingBoxes: bboxesColored, polygons: polygonsColored };
  };

  // 导入标注数据从 JSON
  const handleImportAnnotations = async () => {
    if (!currentProject) {
      alert('请先选择项目');
      return;
    }

    // 创建文件选择器
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        // 进度条：导入开始
        setImportExportProgress({
          active: true,
          mode: 'import',
          total: 0,
          completed: 0,
          current: `读取文件: ${file.name}`,
        });
        dispatch(setLoading(true));
        const text = await file.text();
        const importData = JSON.parse(text);

        // 1) labelme 单图 JSON：{ shapes, imagePath, imageWidth/Height, ... }
        // 2) 我们的 labelme-like 项目包：{ format: "labelme-project", images: [{ labelme: {...} }, ...] }
        // 3) 旧版导出 JSON：{ images: [{ masks, boundingBoxes, polygons, originalName/filename }, ...] }
        const isSingleLabelme = isLabelmeJson(importData) && !Array.isArray(importData.images);
        const isLabelmeProjectPack =
          importData &&
          typeof importData === 'object' &&
          importData.format === 'labelme-project' &&
          Array.isArray(importData.images);
        const isLegacyProjectPack = importData && typeof importData === 'object' && Array.isArray(importData.images) && importData.format !== 'labelme-project';

        if (!isSingleLabelme && !isLabelmeProjectPack && !isLegacyProjectPack) {
          alert('导入文件格式错误：未识别为 labelme JSON 或项目导出包（images 数组）');
          return;
        }

        const importTotal = isSingleLabelme ? 1 : (Array.isArray(importData.images) ? importData.images.length : 0);
        setImportExportProgress((prev) => ({
          ...prev,
          total: importTotal,
          completed: 0,
          current: `开始导入（共 ${importTotal} 项）`,
        }));

        let successCount = 0;
        let failCount = 0;
        let notFoundCount = 0;
        const collectedLabelColor = new Map<string, string>();
        let processedCount = 0;

        const projectId = currentProject.id;
        const updateProjectLabelColorMap = (pairs: Array<{ label: string; color: string }>) => {
          if (!pairs.length) return;
          const key = `labelColorMap:${projectId}`;
          try {
            const existingMap = new Map<string, string>();
            const raw = localStorage.getItem(key);
            if (raw) {
              const obj = JSON.parse(raw) as Record<string, string>;
              Object.entries(obj).forEach(([label, color]) => {
                if (label && color) existingMap.set(label, color);
              });
            }

            pairs.forEach(({ label, color }) => {
              const l = (label || '').trim();
              const c = (color || '').trim();
              if (!l || !c) return;
              existingMap.set(l, c);
            });

            const objToSave: Record<string, string> = {};
            existingMap.forEach((color, label) => {
              objToSave[label] = color;
            });
            localStorage.setItem(key, JSON.stringify(objToSave));
          } catch (err) {
            console.warn('[Import] 更新 labelColorMap 失败:', err);
          }
        };

        const matchImageByAnyName = (target: string) => {
          const tBase = normalizePathBaseName(target);
          const tNoExt = stripExt(tBase);
          return images.find((img: Image) => {
            const c1 = normalizePathBaseName(img.originalName);
            const c2 = normalizePathBaseName(img.filename);
            return (
              c1 === tBase ||
              c2 === tBase ||
              stripExt(c1) === tNoExt ||
              stripExt(c2) === tNoExt ||
              img.originalName === target ||
              img.filename === target
            );
          });
        };

        const importOne = async (args: {
          targetName: string;
          internal: { masks: Mask[]; boundingBoxes: BoundingBox[]; polygons: Polygon[] };
        }) => {
          // 进度条：更新当前处理项（即使找不到也算处理过）
          setImportExportProgress((prev) => ({
            ...prev,
            current: `导入: ${args.targetName}`,
          }));

          const matchedImage = matchImageByAnyName(args.targetName);
          if (!matchedImage) {
            notFoundCount++;
            console.warn(`[Import] 未找到匹配图片: ${args.targetName}`);
            processedCount += 1;
            setImportExportProgress((prev) => ({
              ...prev,
              completed: Math.min(prev.total, processedCount),
            }));
            return;
          }

          try {
            // 为 labelme 输入（通常不含颜色）按项目规则补齐颜色
            const colored = assignColorsForAll(args.internal);
            await annotationApi.saveAnnotation(matchedImage.id, colored);

            // 收集 label -> color（用于刷新项目级映射）
            [...colored.masks, ...colored.boundingBoxes, ...colored.polygons].forEach((item: any) => {
              const label = (item?.label || '').trim();
              const color = (item?.color || '').trim?.() || item?.color;
              if (!label || !color) return;
              if (!collectedLabelColor.has(label)) collectedLabelColor.set(label, color);
            });

            successCount++;
          } catch (error: any) {
            console.error(`[Import] 导入图片 ${matchedImage.originalName} 标注失败:`, error);
            failCount++;
          } finally {
            processedCount += 1;
            setImportExportProgress((prev) => ({
              ...prev,
              completed: Math.min(prev.total, processedCount),
            }));
          }
        };

        if (isSingleLabelme) {
          // 单文件 labelme：用 imagePath/文件名匹配图片
          const targetName = normalizePathBaseName(importData.imagePath || file.name);
          const internal = labelmeToInternal(importData);
          await importOne({ targetName, internal });
        } else {
          // 项目包（labelme-project 或 legacy）
          for (const importedImage of importData.images) {
            if (isLabelmeProjectPack && importedImage?.labelme && isLabelmeJson(importedImage.labelme)) {
              const labelme = importedImage.labelme as LabelmeJson;
              const targetName = normalizePathBaseName(labelme.imagePath || importedImage.originalName || importedImage.filename || '');
              const internal = labelmeToInternal(labelme);
              await importOne({ targetName, internal });
              continue;
            }

            // legacy：直接使用内部结构字段
            const targetName = normalizePathBaseName(importedImage.originalName || importedImage.filename || '');
            const internal = {
              masks: importedImage.masks || [],
              boundingBoxes: importedImage.boundingBoxes || [],
              polygons: importedImage.polygons || [],
            };
            await importOne({ targetName, internal });
          }
        }

        // 更新项目级 label -> color 映射（导入后立即同步到本地，重命名下拉框可立即看到）
        if (collectedLabelColor.size > 0) {
          const pairs = Array.from(collectedLabelColor.entries()).map(([label, color]) => ({ label, color }));
          updateProjectLabelColorMap(pairs);
        }

        // 刷新图片列表和标注汇总
        if (currentProject) {
          const loadedImages = await imageApi.getImages(currentProject.id);
          dispatch(setImages(loadedImages));
          await refreshAnnotationSummary();
        }

        // 显示导入结果
        let message = `导入完成！\n\n成功: ${successCount} 张`;
        if (notFoundCount > 0) {
          message += `\n未找到匹配图片: ${notFoundCount} 张（请确保图片已上传）`;
        }
        if (failCount > 0) {
          message += `\n失败: ${failCount} 张`;
        }
        alert(message);
      } catch (error: any) {
        console.error('导入标注数据失败:', error);
        if (error instanceof SyntaxError) {
          alert('导入失败：JSON 文件格式错误，请检查文件是否完整');
        } else {
          alert(`导入失败: ${error.message || '未知错误'}`);
        }
      } finally {
        dispatch(setLoading(false));
        // 进度条：导入结束（稍后自动隐藏）
        setTimeout(() => {
          setImportExportProgress((prev) => ({ ...prev, active: false, mode: null, current: '' }));
        }, 1200);
      }
    };

    input.click();
  };

  // 导出标注数据（支持两种格式：项目 JSON / Labelme ZIP）
  const handleExportAnnotations = async () => {
    if (!currentProject) {
      alert('请先选择项目');
      return;
    }

    if (images.length === 0) {
      alert('当前没有可导出的图片');
      return;
    }

    try {
      // 进度条：导出开始
      setImportExportProgress({
        active: true,
        mode: 'export',
        total: images.length,
        completed: 0,
        current: `开始导出（共 ${images.length} 张）`,
      });
      dispatch(setLoading(true));

      if (exportFormat === 'labelme-zip') {
        // 导出为 Labelme：一图一 JSON，打包为 ZIP
        const zip = new JSZip();

        for (let i = 0; i < images.length; i++) {
          const image = images[i];
          setImportExportProgress((prev) => ({
            ...prev,
            current: `导出: ${image.originalName || image.filename || `image_${image.id}`}`,
            completed: Math.max(prev.completed, i),
          }));
          try {
            const resp = await annotationApi.getAnnotation(image.id);
            const anno = resp?.annotation;

            const masks0: Mask[] = anno?.masks || [];
            const bboxes0: BoundingBox[] = anno?.boundingBoxes || [];
            const polygons0: Polygon[] = anno?.polygons || [];

            const labelme = buildLabelmeFromInternal({
              image,
              masks: masks0,
              boundingBoxes: bboxes0,
              polygons: polygons0,
            });

            const baseName = stripExt(normalizePathBaseName(image.originalName || image.filename || `image_${image.id}`));
            const fileName = `${baseName || `image_${image.id}`}.json`;
            zip.file(fileName, JSON.stringify(labelme, null, 2));
          } catch (e) {
            console.warn(`[Labelme 导出] 获取图片 ${image.id} 标注失败，将导出空标注:`, e);
            const labelme = buildLabelmeFromInternal({
              image,
              masks: [],
              boundingBoxes: [],
              polygons: [],
            });
            const baseName = stripExt(normalizePathBaseName(image.originalName || image.filename || `image_${image.id}`));
            const fileName = `${baseName || `image_${image.id}`}.json`;
            zip.file(fileName, JSON.stringify(labelme, null, 2));
          }
          setImportExportProgress((prev) => ({
            ...prev,
            completed: Math.max(prev.completed, i + 1),
          }));
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `labelme_${currentProject.name}_${new Date().toISOString().split('T')[0]}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert(`Labelme ZIP 导出成功！\n\n共导出 ${images.length} 个 JSON（每图一个）`);
      } else {
        // 导出为项目内部 JSON（兼容旧格式）
        const exportData = {
          project: {
            id: currentProject.id,
            name: currentProject.name,
            description: currentProject.description || '',
          },
          exportTime: new Date().toISOString(),
          totalImages: images.length,
          images: [] as Array<{
            imageId: number;
            filename: string;
            originalName: string;
            url: string;
            width?: number;
            height?: number;
            masks: Mask[];
            boundingBoxes: BoundingBox[];
            polygons: Polygon[];
          }>,
        };

        for (let i = 0; i < images.length; i++) {
          const image = images[i];
          setImportExportProgress((prev) => ({
            ...prev,
            current: `导出: ${image.originalName || image.filename || `image_${image.id}`}`,
            completed: Math.max(prev.completed, i),
          }));
          try {
            const resp = await annotationApi.getAnnotation(image.id);
            const anno = resp?.annotation;

            exportData.images.push({
              imageId: image.id,
              filename: image.filename,
              originalName: image.originalName,
              url: image.url,
              width: image.width,
              height: image.height,
              masks: anno?.masks || [],
              boundingBoxes: anno?.boundingBoxes || [],
              polygons: anno?.polygons || [],
            });
          } catch (e) {
            console.warn(`[项目导出] 获取图片 ${image.id} 标注失败:`, e);
            exportData.images.push({
              imageId: image.id,
              filename: image.filename,
              originalName: image.originalName,
              url: image.url,
              width: image.width,
              height: image.height,
              masks: [],
              boundingBoxes: [],
              polygons: [],
            });
          }
          setImportExportProgress((prev) => ({
            ...prev,
            completed: Math.max(prev.completed, i + 1),
          }));
        }

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `annotations_${currentProject.name}_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert(`项目 JSON 导出成功！\n\n共导出 ${exportData.images.length} 张图片的标注数据`);
      }
    } catch (error: any) {
      console.error('导出标注数据失败:', error);
      alert(`导出失败: ${error.message || '未知错误'}`);
    } finally {
      dispatch(setLoading(false));
      // 进度条：导出结束（稍后自动隐藏）
      setTimeout(() => {
        setImportExportProgress((prev) => ({ ...prev, active: false, mode: null, current: '' }));
      }, 1200);
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
    setDeleteByColorProgress({
      active: true,
      total: images.length,
      completed: 0,
      current: '开始删除...',
      color: targetColor,
      label,
    });
    let affectedImages = 0;
    let deletedMasks = 0;
    let deletedBBoxes = 0;
    let failCount = 0;
    let processed = 0;

    try {
      for (const image of images) {
        setDeleteByColorProgress((prev) => ({
          ...prev,
          current: `处理中: ${image.originalName || image.filename || `image_${image.id}`}`,
          completed: processed,
        }));
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
        } finally {
          processed += 1;
          setDeleteByColorProgress((prev) => ({
            ...prev,
            completed: processed,
          }));
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
      setTimeout(() => {
        setDeleteByColorProgress((prev) => ({
          ...prev,
          active: false,
          current: '',
        }));
      }, 1200);
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

  // 单张图片 AI 试标注（仅对当前选中图片调用一次 AI，不做批量）
  const handleSingleAIAutoAnnotation = async (image: Image) => {
    if (!image) return;
    if (!currentProject) {
      alert('请先选择项目');
      return;
    }
    try {
      dispatch(setLoading(true));
      console.log(`[前端] 单张AI试标注开始，imageId=${image.id}, name=${image.originalName}`);
      const result = await annotationApi.autoAnnotate(image.id, aiPrompt || undefined, modelParams);
      const colored = assignColorsForAnnotations(result.annotations);
      await annotationApi.saveAnnotation(image.id, {
        masks: colored.masks,
        boundingBoxes: colored.boundingBoxes,
        polygons: [],
      });
      console.log('[前端] 单张AI试标注完成并已保存标注：', {
        imageId: image.id,
        masks: colored.masks.length,
        bboxes: colored.boundingBoxes.length,
      });
      alert('当前图片 AI 试标注完成（结果已保存，可在“人工标注”中查看和微调）');
      await refreshAnnotationSummary();
      // 刷新缩略图的 Mask 叠加（不依赖旧缓存，直接覆盖当前这张的缓存）
      if (showThumbnailMasks) {
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          setThumbnailMasks(prev => ({
            ...prev,
            [image.id]: anno?.masks || [],
          }));
        } catch (e) {
          console.warn('[前端] 单张AI试标注后刷新缩略图 masks 失败, imageId =', image.id, e);
        }
      }
      // 如果当前大图预览正好是这张图片，且处于 Mask 模式，则主动刷新一次预览 Mask
      if (selectedPreviewImage && selectedPreviewImage.id === image.id && previewDisplayMode === 'mask') {
        await loadPreviewMasks(image.id);
      }
    } catch (e: any) {
      console.error('[前端] 单张AI试标注失败:', e);
      alert(e?.message || 'AI 试标注失败，请稍后重试');
    } finally {
      dispatch(setLoading(false));
    }
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
      const initialProgress = {
        total: images.length,
        completed: 0,
        current: '',
        results: []
      };
      setBatchProgress(initialProgress);
      saveBatchProgressToStorage(initialProgress, true, 0);

      const results: Array<{ image: Image; success: boolean; annotations?: any; error?: string }> = [];

      // 逐个处理每张图片
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        const updatedProgress = {
          total: images.length,
          completed: results.length,
          current: `正在处理: ${image.originalName} (${i + 1}/${images.length})`,
          results: [...results]
        };
        setBatchProgress(updatedProgress);
        const progressPercent = Math.round((results.length / images.length) * 100);
        setAiProgress(progressPercent);
        saveBatchProgressToStorage(updatedProgress, true, progressPercent);

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

          const progressAfterSuccess = {
            total: images.length,
            completed: results.length,
            current: `正在处理: ${image.originalName} (${i + 1}/${images.length})`,
            results: [...results]
          };
          setBatchProgress(progressAfterSuccess);
          const progressPercentAfterSuccess = Math.round((results.length / images.length) * 100);
          setAiProgress(progressPercentAfterSuccess);
          saveBatchProgressToStorage(progressAfterSuccess, true, progressPercentAfterSuccess);
        } catch (error: any) {
          console.error(`图片 ${image.originalName} 标注失败:`, error);
          results.push({
            image,
            success: false,
            error: error.message || '未知错误'
          });

          const progressAfterError = {
            total: images.length,
            completed: results.length,
            current: `正在处理: ${image.originalName} (${i + 1}/${images.length})`,
            results: [...results]
          };
          setBatchProgress(progressAfterError);
          const progressPercentAfterError = Math.round((results.length / images.length) * 100);
          setAiProgress(progressPercentAfterError);
          saveBatchProgressToStorage(progressAfterError, true, progressPercentAfterError);
        }
      }

      // 批量标注完成（仅更新进度 & 统计，不自动跳转预览）
      const finalProgress = {
        total: images.length,
        completed: results.length,
        current: '批量标注完成！',
        results: [...results]
      };
      setBatchProgress(finalProgress);
      setAiProgress(100);
      saveBatchProgressToStorage(finalProgress, false, 100);
      await refreshAnnotationSummary();

      // 显示汇总结果
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      setTimeout(() => {
        alert(`批量标注完成！\n\n成功: ${successCount} 张\n失败: ${failCount} 张`);
        setBatchAnnotating(false);
        setAiProgress(0);
        // 清除 localStorage 中的进度（但保留结果供查看）
        clearBatchProgressFromStorage();
      }, 1000);

    } catch (error: any) {
      console.error('批量AI标注失败:', error);
      alert(`批量标注失败: ${error.message || '未知错误'}`);
      setBatchAnnotating(false);
      setAiProgress(0);
      const errorProgress = {
        total: 0,
        completed: 0,
        current: '',
        results: []
      };
      setBatchProgress(errorProgress);
      clearBatchProgressFromStorage();
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
                          <div className="ai-summary-stat success">
                            成功 {showBatchResultBreakdown ? batchSuccessCount : 0}
                          </div>
                          <div className="ai-summary-stat fail">
                            失败 {showBatchResultBreakdown ? batchFailCount : 0}
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
                      {batchAnnotating ? '批量标注中...' : '🤖 批量AI标注'}
                    </button>
                    <div className="import-export-buttons">
                      <button 
                        className="ai-annotation-btn import-btn"
                        onClick={handleImportAnnotations}
                        disabled={!currentProject || loading}
                      >
                        📤 导入标注 (JSON)
                      </button>
                      <div className="export-row">
                        <select
                          className="export-format-select"
                          value={exportFormat}
                          onChange={(e) => setExportFormat(e.target.value as 'project' | 'labelme-zip')}
                        >
                          <option value="project">项目默认 JSON</option>
                          <option value="labelme-zip">Labelme ZIP</option>
                        </select>
                        <button 
                          className="ai-annotation-btn export-btn"
                          onClick={handleExportAnnotations}
                          disabled={images.length === 0 || loading}
                        >
                          📥 导出标注数据
                        </button>
                      </div>

                      {/* 导入/导出进度条 */}
                      {importExportProgress.active && importExportProgress.total > 0 && (
                        <div className="ai-progress-container" style={{ marginTop: '0.75rem' }}>
                          <div className="batch-progress-info">
                            <div className="batch-progress-stats">
                              <span>
                                {importExportProgress.mode === 'import' ? '导入进度' : '导出进度'}:
                                {' '}
                                {importExportProgress.completed}/{importExportProgress.total}
                              </span>
                              <span>
                                {Math.round(
                                  (importExportProgress.completed / Math.max(1, importExportProgress.total)) * 100
                                )}%
                              </span>
                            </div>
                            {importExportProgress.current && (
                              <div className="batch-progress-current">
                                {importExportProgress.current}
                              </div>
                            )}
                          </div>
                          <div className="ai-progress-bar">
                            <div
                              className="ai-progress-fill"
                              style={{
                                width: `${Math.round(
                                  (importExportProgress.completed / Math.max(1, importExportProgress.total)) * 100
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  
                  {/* 批量标注进度 */}
                  {(batchAnnotating || (batchProgress.total > 0 && batchProgress.completed > 0)) && (
                    <div className="ai-progress-container">
                      <div className="batch-progress-info">
                        <div className="batch-progress-stats">
                          <span>进度: {batchProgress.completed}/{batchProgress.total}</span>
                          <span>{Math.round((batchProgress.completed / batchProgress.total) * 100)}%</span>
                          {!batchAnnotating && batchProgress.completed < batchProgress.total && (
                            <span style={{ fontSize: '0.8rem', color: '#999', marginLeft: '0.5rem' }}>
                              (已中断)
                            </span>
                          )}
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
                            {!batchAnnotating && batchProgress.completed < batchProgress.total && (
                              <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#999' }}>
                                (任务已中断，可重新开始批量标注)
                              </span>
                            )}
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
                        className="start-annotation-btn ai-single-annotate-btn"
                        onClick={() => handleSingleAIAutoAnnotation(selectedPreviewImage)}
                      >
                        AI 试标注
                      </button>
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
                      thumbScrollElRef.current = el;
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
                        thumbMeasureElRef.current = el;
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
                              // 只在尺寸确实需要更新时才更新状态，避免不必要的重新渲染
                              setThumbnailSizes(prev => {
                                const existing = prev[image.id];
                                if (existing && existing.width === imgEl.naturalWidth && existing.height === imgEl.naturalHeight) {
                                  return prev; // 尺寸未变化，不更新
                                }
                                return {
                                  ...prev,
                                  [image.id]: {
                                    width: imgEl.naturalWidth,
                                    height: imgEl.naturalHeight,
                                  },
                                };
                              });
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
          onClick={() => {
            saveAiPromptsToStorage();
            setShowPromptModal(false);
          }}
        >
          <div
            className="ai-prompt-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ai-prompt-modal-title">配置提示词</h3>
            <p className="ai-prompt-modal-desc">
              每行一个提示词，例如：person、dog、car。留空则不过滤。
              <br />
              说明：当前仅 <b>Mask R-CNN</b> 会使用提示词（按 COCO 类别名做包含匹配过滤）；YOLO-Seg / SAM2（AMG）会忽略提示词。
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
                onClick={() => {
                  saveAiPromptsToStorage();
                  setShowPromptModal(false);
                }}
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
              可在 Mask R-CNN / YOLO-Seg / SAM2（AMG）之间切换，参数按项目单独保存。
            </p>
            <div className="model-param-group">
              <div className="model-param-row">
                <div className="model-param-label">模型后端</div>
                <select
                  className="ai-prompt-input"
                  value={modelParams.modelBackend}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      modelBackend: e.target.value as any,
                    }))
                  }
                >
                  <option value="maskrcnn">Mask R-CNN</option>
                  <option value="yolo_seg">YOLO-Seg</option>
                  <option value="sam2_amg">SAM2</option>
                </select>
                <div className="model-param-hint">
                  切换后端后，下面仅显示该后端相关参数；未显示的参数会被忽略。
                </div>
              </div>

              {modelParams.modelBackend === 'maskrcnn' && (
                <div className="model-param-row">
                  <div className="model-param-label">
                    提示词（可选）
                    <span className="model-param-value">
                      {aiPrompts.filter((p) => p.trim().length > 0).length > 0
                        ? `已配置 ${aiPrompts.filter((p) => p.trim().length > 0).length} 条`
                        : '未配置'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ai-prompt-manage-btn"
                    onClick={() => {
                      if (aiPrompts.length === 0) {
                        setAiPrompts(['']);
                      }
                      // 避免双层弹窗叠在一起
                      setShowModelParamModal(false);
                      setShowPromptModal(true);
                    }}
                  >
                    配置提示词
                  </button>
                  <div className="model-param-hint">
                    仅 Mask R-CNN 使用提示词（按 COCO 类别名包含匹配过滤）。
                  </div>
                </div>
              )}

              {modelParams.modelBackend === 'maskrcnn' && (
                <>
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
                </>
              )}

              {modelParams.modelBackend === 'yolo_seg' && (
                <>
                  <div className="model-param-row">
                    <div className="model-param-label">
                      YOLO 置信度阈值
                      <span className="model-param-value">{modelParams.yoloConf.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={0.9}
                      step={0.05}
                      value={modelParams.yoloConf}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          yoloConf: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">越高越严格，目标会更少（默认 0.25）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      YOLO NMS IoU 阈值
                      <span className="model-param-value">{modelParams.yoloIou.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.9}
                      step={0.05}
                      value={modelParams.yoloIou}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          yoloIou: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">越低越不容易合并相近目标（默认 0.70）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      YOLO 输入尺寸（imgsz）
                      <span className="model-param-value">{modelParams.yoloImgSize}</span>
                    </div>
                    <input
                      type="range"
                      min={320}
                      max={1280}
                      step={32}
                      value={modelParams.yoloImgSize}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          yoloImgSize: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">更大更精细，但更慢（默认 640）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      YOLO 最多输出目标数
                      <span className="model-param-value">{modelParams.yoloMaxDet}</span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={800}
                      step={50}
                      value={modelParams.yoloMaxDet}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          yoloMaxDet: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">限制每张图最多输出多少个实例（默认 300）。</div>
                  </div>
                </>
              )}

              {modelParams.modelBackend === 'sam2_amg' && (
                <>
                  <div className="model-param-row">
                    <div className="model-param-label">
                      SAM2 points_per_side
                      <span className="model-param-value">{modelParams.sam2PointsPerSide}</span>
                    </div>
                    <input
                      type="range"
                      min={8}
                      max={64}
                      step={4}
                      value={modelParams.sam2PointsPerSide}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          sam2PointsPerSide: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">越大分割越细，但更慢（默认 32）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      SAM2 pred_iou_thresh
                      <span className="model-param-value">{modelParams.sam2PredIouThresh.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={0.98}
                      step={0.02}
                      value={modelParams.sam2PredIouThresh}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          sam2PredIouThresh: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">越高越严格，保留的 mask 更少（默认 0.88）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      SAM2 stability_score_thresh
                      <span className="model-param-value">{modelParams.sam2StabilityScoreThresh.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={0.98}
                      step={0.02}
                      value={modelParams.sam2StabilityScoreThresh}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          sam2StabilityScoreThresh: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">越高越偏向稳定的大块区域（默认 0.95）。</div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      SAM2 box_nms_thresh
                      <span className="model-param-value">
                        {modelParams.sam2BoxNmsThresh.toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.3}
                      max={0.95}
                      step={0.05}
                      value={modelParams.sam2BoxNmsThresh}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          sam2BoxNmsThresh: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">
                      控制相邻 mask 的合并程度：越低越容易保留相近的多个目标，越高越容易合并（默认 0.70）。
                    </div>
                  </div>

                  <div className="model-param-row">
                    <div className="model-param-label">
                      SAM2 min_mask_region_area
                      <span className="model-param-value">
                        {modelParams.sam2MinMaskRegionArea}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={20000}
                      step={500}
                      value={modelParams.sam2MinMaskRegionArea}
                      onChange={(e) =>
                        setModelParams((prev) => ({
                          ...prev,
                          sam2MinMaskRegionArea: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="model-param-hint">
                      过滤掉特别小的噪声区域（像素面积）。0 表示不过滤（默认 0，可按需要提高到几千）。
                    </div>
                  </div>
                </>
              )}

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
                    modelBackend: 'sam2_amg',
                    baseScoreThresh: 0.5,
                    lowerScoreThresh: 0.3,
                    maxDetections: 50,
                    maskThreshold: 0.5,
                    maxPolygonPoints: 80,
                    yoloConf: 0.25,
                    yoloIou: 0.7,
                    yoloImgSize: 640,
                    yoloMaxDet: 300,
                    sam2PointsPerSide: 32,
                    sam2PredIouThresh: 0.88,
                    sam2StabilityScoreThresh: 0.95,
                    sam2BoxNmsThresh: 0.7,
                    sam2MinMaskRegionArea: 0,
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
            {/* 删除进度条 */}
            {deleteByColorProgress.active && deleteByColorProgress.total > 0 && (
              <div className="ai-progress-container" style={{ marginBottom: '0.75rem' }}>
                <div className="batch-progress-info">
                  <div className="batch-progress-stats">
                    <span>
                      删除进度: {deleteByColorProgress.completed}/{deleteByColorProgress.total}
                    </span>
                    <span>
                      {Math.round(
                        (deleteByColorProgress.completed / Math.max(1, deleteByColorProgress.total)) * 100
                      )}%
                    </span>
                  </div>
                  {deleteByColorProgress.current && (
                    <div className="batch-progress-current">
                      {deleteByColorProgress.label
                        ? `Label: ${deleteByColorProgress.label} | `
                        : ''}
                      颜色: {deleteByColorProgress.color}
                      <br />
                      {deleteByColorProgress.current}
                    </div>
                  )}
                </div>
                <div className="ai-progress-bar">
                  <div
                    className="ai-progress-fill"
                    style={{
                      width: `${Math.round(
                        (deleteByColorProgress.completed / Math.max(1, deleteByColorProgress.total)) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}
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