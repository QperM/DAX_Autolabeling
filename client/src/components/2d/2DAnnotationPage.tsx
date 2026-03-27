import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setImages, setLoading, setError, setCurrentImage } from '../../store/annotationSlice';
import { imageApi, annotationApi, projectApi, authApi } from '../../services/api';
import type { Image, Mask, BoundingBox } from '../../types';
import ImageUploader from './ImageUploader';
import ModelConfigModal from './ModelConfigModal';
import { clearStoredCurrentProject, getStoredCurrentProject } from '../../utils/tabStorage';
import { toAbsoluteUrl } from '../../utils/urls';
import { sortByWindowsFilename } from '../../utils/windowsFilenameSort';
import VirtualThumbGrid from '../common/VirtualThumbGrid';
import './2DAnnotationPage.css';
import { AnnotationLabelmeZipExportButton, type LabelmeExportProgressState } from './AnnotationLabelmeZipExport';
import { debugLog } from '../../utils/debugSettings';
import { ProgressPopupModal, type ProgressPopupBar } from '../common/ProgressPopupModal';
import { useAppAlert } from '../common/AppAlert';
import { useProjectSessionGuard } from '../../utils/projectSessionGuard';
import ColorLabelMappingManager from '../common/ColorLabelMappingManager';
import { SAM2_OBJECT_LABEL, SAM2_OBJECT_RESERVED_COLOR } from '../common/annotationColors';
import { assignMissingColorsForAnnotations } from '../common/annotationColorLogic';

type Sam2ModelParams = {
  maxPolygonPoints: number;
  sam2PointsPerSide: number;
  sam2PredIouThresh: number;
  sam2StabilityScoreThresh: number;
  sam2BoxNmsThresh: number;
  sam2MinMaskRegionArea: number;
  sam2MergeGapPx: number;
};

const DEFAULT_MODEL_PARAMS: Sam2ModelParams = {
  maxPolygonPoints: 60,
  sam2PointsPerSide: 20,
  sam2PredIouThresh: 0.88,
  sam2StabilityScoreThresh: 0.95,
  sam2BoxNmsThresh: 0.35,
  sam2MinMaskRegionArea: 6000,
  sam2MergeGapPx: 0,
};

const GLOBAL_MODEL_PARAMS_STORAGE_KEY = 'modelParams:globalDefault';

const sanitizeModelParams = (
  input: Partial<Sam2ModelParams> | null | undefined,
  fallback: Sam2ModelParams,
): Sam2ModelParams => ({
  maxPolygonPoints: typeof input?.maxPolygonPoints === 'number' ? input.maxPolygonPoints : fallback.maxPolygonPoints,
  sam2PointsPerSide: typeof input?.sam2PointsPerSide === 'number' ? input.sam2PointsPerSide : fallback.sam2PointsPerSide,
  sam2PredIouThresh:
    typeof input?.sam2PredIouThresh === 'number' ? input.sam2PredIouThresh : fallback.sam2PredIouThresh,
  sam2StabilityScoreThresh:
    typeof input?.sam2StabilityScoreThresh === 'number'
      ? input.sam2StabilityScoreThresh
      : fallback.sam2StabilityScoreThresh,
  sam2BoxNmsThresh: typeof input?.sam2BoxNmsThresh === 'number' ? input.sam2BoxNmsThresh : fallback.sam2BoxNmsThresh,
  sam2MinMaskRegionArea:
    typeof input?.sam2MinMaskRegionArea === 'number'
      ? input.sam2MinMaskRegionArea
      : fallback.sam2MinMaskRegionArea,
  sam2MergeGapPx: typeof input?.sam2MergeGapPx === 'number' ? input.sam2MergeGapPx : fallback.sam2MergeGapPx,
});

const AnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { images, loading, error } = useSelector((state: any) => state.annotation);
  const { alert, confirm } = useAppAlert();
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<Image | null>(null);
  const [previewDisplayMode, setPreviewDisplayMode] = useState<'image' | 'mask'>('image');
  const [previewMasks, setPreviewMasks] = useState<Mask[]>([]);
  const [previewAnnoLoading, setPreviewAnnoLoading] = useState(false);
  const [previewImageSize, setPreviewImageSize] = useState<{ width: number; height: number } | null>(null);
  const [thumbnailMasks, setThumbnailMasks] = useState<Record<number, Mask[]>>({});
  const [thumbnailSizes, setThumbnailSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [showThumbnailMasks, setShowThumbnailMasks] = useState(false);
  const loadingThumbnailMasksRef = useRef<Set<number>>(new Set()); // 正在加载的 mask ID 集合
  // 虚拟滚动可视区内的缩略图（用于 mask 预加载）
  const [visibleThumbImages, setVisibleThumbImages] = useState<Image[]>([]);
  const THUMB_SIZE = 125;
  const THUMB_GAP = 16; // 对应 CSS gap: 1rem
  const [currentProject, setCurrentProject] = useState<any>(null);  // 当前项目
  useProjectSessionGuard(currentProject?.id ? Number(currentProject.id) : null, !!currentProject?.id);
  const [isAdmin, setIsAdmin] = useState(false); // 当前是否为管理员
  const [aiProgress, setAiProgress] = useState(0);  // AI标注进度 0-100
  const [batchAnnotating, setBatchAnnotating] = useState(false);  // 批量标注进行中
  const [batchProgressPopupDismissed, setBatchProgressPopupDismissed] = useState(false); // 允许手动关闭批量进度弹层
  const [singleAnnotating, setSingleAnnotating] = useState(false); // 单张 AI 试标注进行中（与批量互斥）
  const [singleAiProgress, setSingleAiProgress] = useState(0); // 单图 AI 试标注进度 0-100
  const [singleAiProgressText, setSingleAiProgressText] = useState('正在计算与生成标注…');
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
  const [, setAnnotationSummary] = useState<{
    totalImages: number;
    annotatedImages: number;
    latestAnnotatedImageId: number | null;
    latestUpdatedAt: string | null;
  } | null>(null);
  const [modelParams, setModelParams] = useState<Sam2ModelParams>(DEFAULT_MODEL_PARAMS);
  const [globalDefaultModelParams, setGlobalDefaultModelParams] = useState<Sam2ModelParams>(DEFAULT_MODEL_PARAMS);

  // 图片 URL 缓存破坏因子：只在列表内容发生变化时更新，避免每次 render 都触发图片重新请求
  const [imageCacheBust, setImageCacheBust] = useState(0);
  const [exportProgress, setExportProgress] = useState<LabelmeExportProgressState>({
    active: false,
    mode: null,
    total: 0,
    completed: 0,
    current: '',
  });

  // 项目级 label -> color 映射表（同一项目内保持稳定）
  const labelColorMapRef = React.useRef<Map<string, string>>(new Map());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(GLOBAL_MODEL_PARAMS_STORAGE_KEY);
      if (!raw) {
        setGlobalDefaultModelParams(DEFAULT_MODEL_PARAMS);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<Sam2ModelParams>;
      setGlobalDefaultModelParams(sanitizeModelParams(parsed, DEFAULT_MODEL_PARAMS));
    } catch (e) {
      console.warn('加载全局默认模型参数失败，将使用内置默认值', e);
      setGlobalDefaultModelParams(DEFAULT_MODEL_PARAMS);
    }
  }, []);

  // 加载当前项目的模型参数（从 localStorage）
  useEffect(() => {
    if (!currentProject || !currentProject.id) {
      setModelParams(globalDefaultModelParams);
      return;
    }
    const key = `modelParams:${currentProject.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        setModelParams(globalDefaultModelParams);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<Sam2ModelParams>;
      setModelParams(sanitizeModelParams(parsed, globalDefaultModelParams));
    } catch (e) {
      console.warn('加载模型参数失败，将使用默认值', e);
      setModelParams(globalDefaultModelParams);
    }
  }, [currentProject?.id, globalDefaultModelParams]);

  const saveModelParamsToStorage = () => {
    if (!currentProject || !currentProject.id) return;
    const key = `modelParams:${currentProject.id}`;
    try {
      localStorage.setItem(key, JSON.stringify(modelParams));
    } catch (e) {
      console.warn('保存模型参数失败', e);
    }
  };

  const saveCurrentModelParamsAsGlobalDefault = async () => {
    if (!isAdmin) return;
    try {
      localStorage.setItem(GLOBAL_MODEL_PARAMS_STORAGE_KEY, JSON.stringify(modelParams));
      setGlobalDefaultModelParams(modelParams);
      await alert('已将当前参数保存为“全局默认值”');
    } catch (e) {
      console.warn('保存全局默认模型参数失败', e);
      await alert('保存全局默认值失败，请稍后重试');
    }
  };

  // 切换项目时，重置当前项目的颜色映射
  useEffect(() => {
    labelColorMapRef.current = new Map();
  }, [currentProject?.id]);

  // 以数据库中的项目映射作为颜色分配的初始种子
  useEffect(() => {
    if (!currentProject?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const mappings = await projectApi.getLabelColors(Number(currentProject.id));
        if (cancelled) return;
        const seeded = new Map<string, string>();
        for (const m of mappings) {
          const label = String(m?.label || '').trim();
          const color = String(m?.color || '').trim();
          if (!label || !color) continue;
          if (!seeded.has(label)) seeded.set(label, color);
        }
        labelColorMapRef.current = seeded;
      } catch (_) {
        // ignore seed load failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);

  useEffect(() => {
    // project 或图片列表变动时更新一次即可
    setImageCacheBust((v) => (v + 1) % 1_000_000);
  }, [currentProject?.id, images.length]);

  const assignColorsForAnnotations = (input: { masks: Mask[]; boundingBoxes: BoundingBox[] }) => {
    return assignMissingColorsForAnnotations(input, labelColorMapRef.current);
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

  // 从当前标签页的 sessionStorage 恢复当前项目
  useEffect(() => {
    const savedProject = getStoredCurrentProject<any>();
    if (savedProject) {
      try {
        const project = savedProject;
        setCurrentProject(project);
      } catch (e) {
        console.error('AnnotationPage: 解析保存的项目失败', e);
        clearStoredCurrentProject();
      }
    } else {
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
      }
    } catch (e) {
      console.warn('恢复批量标注进度失败', e);
    }
  }, [currentProject?.id]);

  // 权限检查：确保用户已通过验证码或登录
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const authStatus = await authApi.checkAuth();
        // 记录是否为管理员
        setIsAdmin(!!authStatus.isAdmin);

        if (!authStatus.authenticated) {
          // 未登录也没有验证码session，重定向到首页
          navigate('/');
          return;
        }
        
        // 检查是否有当前项目
        const savedProject = getStoredCurrentProject<any>();
        if (!savedProject) {
          navigate('/');
          return;
        }
        
        try {
          const project = savedProject;
          // 管理员有全部权限，跳过项目访问检查
          if (authStatus.isAdmin) return;
          
          // 普通用户：优先用 session 中的 accessibleProjectIds 快速判断
          const accessibleIds = (authStatus as any).accessibleProjectIds;
          if (accessibleIds && Array.isArray(accessibleIds)) {
            if (accessibleIds.includes(project.id)) return;
          }
          
          // 兜底：从后端查一次可访问项目
          try {
            const accessibleProjects = await authApi.getAccessibleProjects();
            const hasAccess = accessibleProjects.some(p => p.id === project.id);
            if (hasAccess) return;
          } catch {
            // 查询失败也不阻塞
          }
          
          alert('您没有访问该项目的权限，请重新输入验证码');
          clearStoredCurrentProject();
          navigate('/');
        } catch (e) {
          console.error('解析项目失败', e);
          clearStoredCurrentProject();
          navigate('/');
        }
      } catch (error) {
        console.error('权限检查失败', error);
        // 网络错误时不强制跳转，避免后端临时不可用导致丢失工作
        console.warn('权限检查网络错误，暂不跳转');
      }
    };
    
    checkAuth();
  }, [navigate]);

  // 根据当前项目加载已有图像
  useEffect(() => {
    if (currentProject) {
      const loadImages = async () => {
        try {
          dispatch(setLoading(true));
          // 根据项目ID加载该项目的图片
          const loadedImages = await imageApi.getImages(currentProject.id);
          const sortedImages = sortByWindowsFilename(loadedImages, (img) => img.originalName || img.filename);
          dispatch(setImages(sortedImages));

          // 同步拉取项目标注汇总（用于“已完成AI标注数量”）
          const summary = await projectApi.getAnnotationSummary(currentProject.id);
          setAnnotationSummary(summary);
        } catch (err: any) {
          // 如果是权限错误，重定向到首页
          if (err.response?.status === 403) {
            alert('您没有访问该项目的权限，请重新输入验证码');
            navigate('/');
          } else {
          dispatch(setError(err.message || '加载图像失败'));
          }
        } finally {
          dispatch(setLoading(false));
        }
      };

      loadImages();
    }
  }, [dispatch, currentProject, navigate]);

  const refreshAnnotationSummary = async () => {
    if (!currentProject) return;
    try {
      const summary = await projectApi.getAnnotationSummary(currentProject.id);
      setAnnotationSummary(summary);
    } catch (e) {
      console.warn('刷新标注汇总失败:', e);
    }
  };

  const handleUploadComplete = () => {
    if (!currentProject) {
      alert('请先创建或选择项目！');
      return;
    }
    // 上传接口已在后端完成“图片入库 + 关联项目”
    // 这里做一次刷新，确保 ZIP 解压批量导入等场景下列表与数据库完全一致
    (async () => {
      try {
        dispatch(setLoading(true));
        const loadedImages = await imageApi.getImages(currentProject.id);
        const sortedImages = sortByWindowsFilename(loadedImages, (img) => img.originalName || img.filename);
        dispatch(setImages(sortedImages));
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
    if (batchAnnotating) return;
    if (!currentProject) {
      alert('请先选择项目');
      return;
    }
    const confirmSingle = await confirm(
      `确认开始对当前图片执行 AI 标注吗？\n\n图片：${image.originalName || image.filename}`,
      { title: '确认执行 AI 标注' },
    );
    if (!confirmSingle) return;
    try {
      setSingleAnnotating(true);
      setSingleAiProgress(1);
      setSingleAiProgressText('任务已提交，正在进入队列…');
      dispatch(setLoading(true));
      let pollCancelled = false;
      const pollQueue = async () => {
        if (pollCancelled) return;
        try {
          const qResp: any = await annotationApi.getAutoAnnotateQueueStatus();
          const q = qResp?.status;
          if (q?.active && q?.state === 'queued') {
            const pos = Number(q?.queuePosition || 0);
            debugLog('frontend', 'frontendSam2Queue', '[2DAnnotationPage] queue status', { state: 'queued', pos, imageId: image.id });
            setSingleAiProgress(Math.max(1, Math.min(10, pos > 0 ? 11 - pos : 1)));
            setSingleAiProgressText(pos > 0 ? `排队中：当前第 ${pos} 位` : '排队中，等待计算槽位…');
          } else if (q?.active && q?.state === 'running') {
            debugLog('frontend', 'frontendSam2Queue', '[2DAnnotationPage] queue status', { state: 'running', imageId: image.id });
            setSingleAiProgress((p) => Math.max(p, 12));
            setSingleAiProgressText('正在计算与生成标注…');
          }
        } catch (_) {}
      };
      await pollQueue();
      const queueTimer = window.setInterval(() => {
        void pollQueue();
      }, 700);
      let result: any;
      try {
        result = await annotationApi.autoAnnotate(image.id, modelParams);
      } finally {
        pollCancelled = true;
        window.clearInterval(queueTimer);
      }
      const colored = assignColorsForAnnotations(result.annotations);
      await annotationApi.saveAnnotation(image.id, {
        masks: colored.masks,
        boundingBoxes: colored.boundingBoxes,
        polygons: [],
      });
      // 先把进度拉到 100%，再弹窗成功提示（避免看到 0% 已完成的错觉）
      setSingleAiProgress(100);
      setSingleAiProgressText('完成');
      await new Promise((r) => setTimeout(r, 300));
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
      setSingleAnnotating(false);
      setSingleAiProgress(0);
      setSingleAiProgressText('正在计算与生成标注…');
    }
  };

  const handleBack = () => {
    navigate('/');
  };

  // 处理批量AI自动标注
  const handleBatchAIAutoAnnotation = async () => {
    if (singleAnnotating) {
      alert('当前有单张 AI 试标注正在执行，请等待完成后再启动批量标注');
      return;
    }
    if (!isAdmin) {
      alert('当前账号无权限执行批量AI标注，请联系管理员操作');
      return;
    }

    if (images.length === 0) {
      alert('当前没有可标注的图片');
      return;
    }

    if (!currentProject) {
      alert('请先选择项目');
      return;
    }

    const confirmMessage = `确定要对所有 ${images.length} 张图片进行批量AI自动标注吗？\n\n` +
      `将使用 SAM2 模型进行自动分割。\n\n注意：批量标注可能需要较长时间，请耐心等待。`;
    if (!(await confirm(confirmMessage, { title: '确认批量 AI 标注' }))) {
      return;
    }

    try {
      setBatchAnnotating(true);
      setBatchProgressPopupDismissed(false);
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
          current: `正在处理: ${image.originalName || image.filename} (${i + 1}/${images.length})`,
          results: [...results]
        };
        setBatchProgress(updatedProgress);
        const progressPercent = Math.round((results.length / images.length) * 100);
        setAiProgress(progressPercent);
        saveBatchProgressToStorage(updatedProgress, true, progressPercent);

        try {
          // 调用后端AI标注API（携带当前项目的模型参数）
          const result = await annotationApi.autoAnnotate(image.id, modelParams);

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
            current: `正在处理: ${image.originalName || image.filename} (${i + 1}/${images.length})`,
            results: [...results]
          };
          setBatchProgress(progressAfterSuccess);
          const progressPercentAfterSuccess = Math.round((results.length / images.length) * 100);
          setAiProgress(progressPercentAfterSuccess);
          saveBatchProgressToStorage(progressAfterSuccess, true, progressPercentAfterSuccess);
        } catch (error: any) {
            console.error(`图片 ${image.originalName || image.filename} 标注失败:`, error);
          results.push({
            image,
            success: false,
            error: error.message || '未知错误'
          });

          const progressAfterError = {
            total: images.length,
            completed: results.length,
            current: `正在处理: ${image.originalName || image.filename} (${i + 1}/${images.length})`,
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
        // 整体重新用 SAM2 跑完后，项目级颜色-Label 对照表仅保留 object -> #1F77B4
        if (currentProject?.id) {
          void projectApi
            .saveLabelColors(Number(currentProject.id), [
              { label: SAM2_OBJECT_LABEL, color: SAM2_OBJECT_RESERVED_COLOR, usageOrder: 0 },
            ])
            .catch((e: any) => {
              console.warn('[AnnotationPage] 重置项目颜色-Label 对照表失败:', e);
            });
        }
        setBatchAnnotating(false);
        setAiProgress(0);
        setBatchProgressPopupDismissed(true); // 完成后收起进度弹层
        // 清除 localStorage 中的进度（但保留结果供查看）
        clearBatchProgressFromStorage();
      }, 1000);

    } catch (error: any) {
      console.error('批量AI标注失败:', error);
      alert(`批量标注失败: ${error.message || '未知错误'}`);
      setBatchAnnotating(false);
      setAiProgress(0);
      setBatchProgressPopupDismissed(true);
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

  const shouldShowBatchProgressPopup = batchAnnotating || (batchProgress.total > 0 && batchProgress.completed > 0);
  const batchProgressPercent =
    batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : aiProgress;
  const batchSuccessCount = batchProgress.results.filter((r) => r.success).length;
  const batchFailCount = batchProgress.results.filter((r) => !r.success).length;
  const isBatchInterrupted = !batchAnnotating && batchProgress.total > 0 && batchProgress.completed < batchProgress.total;

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
                {isAdmin ? (
                <ImageUploader 
                  onUploadComplete={handleUploadComplete} 
                  projectId={currentProject?.id}
                />
                ) : (
                  <div className="image-uploader">
                    <div className="dropzone disabled-dropzone">
                      <div className="upload-prompt">
                        <p>当前账号为标注用户，不能上传新图片。</p>
                        <p className="hint">如需新增图片，请联系管理员在后台上传。</p>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* AI标注功能区域 */}
                <div className="ai-section">
                  <div className="ai-controls">
                    <div className="ai-controls-top">
                      <div className="ai-prompt-group">
                        <ModelConfigModal
                          hasProject={!!currentProject}
                          isAdmin={isAdmin}
                          modelParams={modelParams}
                          globalDefaultModelParams={globalDefaultModelParams}
                          setModelParams={setModelParams}
                          onMissingProject={() => alert('请先选择项目')}
                          onSaveAsGlobalDefault={saveCurrentModelParamsAsGlobalDefault}
                          onSaveAndClose={() => {
                            saveModelParamsToStorage();
                          }}
                        />
                      </div>
                    </div>
                    <button
                      className="ai-annotation-btn"
                      onClick={handleBatchAIAutoAnnotation}
                      disabled={!isAdmin || images.length === 0 || batchAnnotating || singleAnnotating}
                      title={
                        !isAdmin
                          ? '普通用户已禁用：批量AI标注可能导致服务器过载，请联系管理员'
                          : singleAnnotating
                            ? '单图AI标注进行中，暂不可执行批量标注'
                            : ''
                      }
                    >
                      {batchAnnotating ? '批量标注中...' : '🤖 批量AI标注'}
                    </button>
                    <ColorLabelMappingManager
                      currentProjectId={currentProject?.id ? Number(currentProject.id) : null}
                      images={images}
                      selectedPreviewImage={selectedPreviewImage}
                      previewDisplayMode={previewDisplayMode}
                      onRefreshAnnotationSummary={refreshAnnotationSummary}
                      onReloadPreviewMasks={loadPreviewMasks}
                      onClearThumbnailMasks={() => setThumbnailMasks({})}
                    />
                    <div className="import-export-buttons">
                      <AnnotationLabelmeZipExportButton
                        project={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
                        images={images}
                        isAdmin={isAdmin}
                        pageLoading={loading}
                        setExportProgress={setExportProgress}
                      />
                    </div>
                  </div>
                  
                  
                  <ProgressPopupModal
                    open={shouldShowBatchProgressPopup && !batchProgressPopupDismissed}
                    title="批量AI标注进度"
                    closable
                    onClose={() => setBatchProgressPopupDismissed(true)}
                    bars={[
                      {
                        key: 'batch-ai',
                        title: 'AI标注进度',
                        percent: batchProgressPercent,
                        tone: 'primary',
                        currentText: batchProgress.current || undefined,
                      },
                    ]}
                    summary={
                      batchProgress.completed > 0 ? (
                        <div>
                          成功: {batchSuccessCount} | 失败: {batchFailCount}
                          {isBatchInterrupted && (
                            <span style={{ marginLeft: '0.5rem', fontSize: '0.78rem', color: '#94a3b8' }}>
                              (任务已中断，可重新开始批量标注)
                            </span>
                          )}
                        </div>
                      ) : undefined
                    }
                  />
                  <ProgressPopupModal
                    open={exportProgress.active && exportProgress.total > 0}
                    title="Labelme ZIP 导出进度"
                    bars={[
                      {
                        key: 'labelme-export',
                        title: '导出进度',
                        percent: Math.round((exportProgress.completed / Math.max(1, exportProgress.total)) * 100),
                        currentText: exportProgress.current || undefined,
                      } satisfies ProgressPopupBar,
                    ]}
                    summary={
                      exportProgress.total > 0 ? (
                        <div>
                          {exportProgress.completed}/{exportProgress.total}
                        </div>
                      ) : undefined
                    }
                  />
                  <ProgressPopupModal
                    open={singleAnnotating}
                    title="AI 试标注进度"
                    bars={[
                      {
                        key: 'single-ai',
                        title: '运行中',
                        percent: singleAiProgress,
                        currentText: singleAiProgressText,
                      } satisfies ProgressPopupBar,
                    ]}
                  />
                </div>
              </div>
            </div>
            
            {/* 右上区域 - 图片预览放大 */}
            <div className="welcome-right-top">
              {selectedPreviewImage ? (
                <div className="image-preview-container">
                  <div className="preview-header">
                    <h3>{selectedPreviewImage.originalName || selectedPreviewImage.filename}</h3>
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
                      src={`${(toAbsoluteUrl(selectedPreviewImage.url) || selectedPreviewImage.url)}?v=${imageCacheBust}`} 
                      alt={selectedPreviewImage.originalName || selectedPreviewImage.filename}
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
                        disabled={batchAnnotating || singleAnnotating}
                        title={batchAnnotating ? '批量AI标注进行中，暂不可执行单图试标注' : ''}
                      >
                        {singleAnnotating ? 'AI标注中...' : 'AI标注'}
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
                        if (await confirm(`确定要删除图片 "${selectedPreviewImage.originalName || selectedPreviewImage.filename}" 吗？`, { title: '确认删除' })) {
                          const imageId = selectedPreviewImage.id;
                          debugLog('frontend', 'frontend2DDelete', '[2DAnnotationPage] start delete image', { imageId });
                          try {
                            dispatch(setLoading(true));
                            
                            // 调用后端API删除图片
                            await imageApi.deleteImage(imageId);
                            debugLog('frontend', 'frontend2DDelete', '[2DAnnotationPage] delete API success', { imageId });
                            
                          // 从Redux状态中移除图片
                          dispatch({
                            type: 'annotation/removeImage',
                              payload: imageId
                            });
                            
                            // 清空预览
                            setSelectedPreviewImage(null);
                            
                            // 重新加载图片列表以确保数据同步
                            if (currentProject) {
                              const loadedImages = await imageApi.getImages(currentProject.id);
                              const sortedImages = sortByWindowsFilename(loadedImages, (img) => img.originalName || img.filename);
                              dispatch(setImages(sortedImages));
                            }
                            debugLog('frontend', 'frontend2DDelete', '[2DAnnotationPage] delete flow done', { imageId });
                          } catch (error: any) {
                            console.error(`[前端] 删除图片失败，图片ID: ${imageId}:`, error);
                            debugLog('frontend', 'frontend2DDelete', '[2DAnnotationPage] delete error', error?.message || String(error));
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
                    <h3>项目图片 ({images.length})</h3>
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
                  <VirtualThumbGrid
                    items={images}
                    getId={(image) => image.id}
                    selectedId={selectedPreviewImage?.id ?? null}
                    thumbSize={THUMB_SIZE}
                    thumbGap={THUMB_GAP}
                    onSelect={(image) => setSelectedPreviewImage(image)}
                    onTileMouseEnter={(image) => ensureThumbnailMasks(image.id)}
                    onVisibleItemsChange={setVisibleThumbImages}
                    renderTile={({ item: image }) => (
                      <>
                        <div className="thumbnail-image-layer">
                          <img
                            src={`${(toAbsoluteUrl(image.url) || image.url)}?v=${imageCacheBust}`}
                            alt={image.originalName || image.filename}
                            onError={() => {
                              console.error('❌ 图片加载失败:', image.url);
                            }}
                            onLoad={(e) => {
                              const imgEl = e.currentTarget;
                              // 只在尺寸确实需要更新时才更新状态，避免不必要的重新渲染
                              setThumbnailSizes((prev) => {
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
                          <span className="thumbnail-name">{image.originalName || image.filename}</span>
                        </div>
                      </>
                    )}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 模型参数弹窗已由 ModelConfigModal 内部托管 */}

    </div>
  );
};

export default AnnotationPage;