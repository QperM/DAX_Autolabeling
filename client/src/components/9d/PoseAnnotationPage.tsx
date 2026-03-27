import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setCurrentImage, setError, setImages, setLoading } from '../../store/annotationSlice';
import { authApi, depthApi, imageApi, meshApi, pose6dApi, pose9dApi, projectApi } from '../../services/api';
import type { Image } from '../../types';
import { clearStoredCurrentProject, getStoredCurrentProject } from '../../utils/tabStorage';
import { toAbsoluteUrl } from '../../utils/urls';
import MeshUploader from './MeshUploader';
import DepthUploader from './DepthUploader';
// @ts-ignore: MeshPreview3D is a TSX React component resolved by bundler
import MeshPreview3D from './MeshPreview3D';
// @ts-ignore: MeshThumbnail is a TSX React component resolved by bundler
import MeshThumbnail from './MeshThumbnail';
import { PoseAnnotationsZipExportButton } from './PoseAnnotationsZipExport';
import MeshLabelMappingModal from './MeshLabelMappingModal';
import './PoseAnnotationPage.css';
import PoseDiffDopeParamModal, { type DiffDopeParams } from './PoseDiffDopeParamModal';
import PoseImagePreviewPanel from './PoseImagePreviewPanel';
import BatchDepthCompletionButton from './BatchDepthCompletionButton';
import { ProgressPopupModal, type ProgressPopupBar } from '../common/ProgressPopupModal';
import { useAppAlert } from '../common/AppAlert';
import { useProjectSessionGuard } from '../../utils/projectSessionGuard';

const DEFAULT_DIFFDOPE_PARAMS: DiffDopeParams = {
  batchSize: 8,
  depthSource: 'raw',
  useInitialPose: false,
  onlySingleMesh: false,
  targetMeshId: null,
  maxAllowedFinalLoss: 100,
  /** --- 第一轮（粗对齐）：仅 Mask + RGB，无 depth loss --- */
  stage1Iters: 60,
  stage1UseMask: true,
  stage1UseRgb: true,
  stage1WeightMask: 1,
  stage1WeightRgb: 0.7,
  stage1EarlyStopLoss: 5,
  stage1BaseLr: 20,
  stage1LrDecay: 0.1,
  /** --- 第二轮（精修）：Mask / Depth / RGB 可选；LR 与权重均独立于第一轮 --- */
  stage2Iters: 320,
  stage2UseMask: true,
  stage2UseDepth: true,
  stage2UseRgb: true,
  stage2WeightMask: 1,
  stage2WeightDepth: 1,
  stage2WeightRgb: 1,
  stage2EarlyStopLoss: 8,
  stage2BaseLr: 8,
  stage2LrDecay: 0.05,
};

const GLOBAL_DIFFDOPE_PARAMS_STORAGE_KEY = 'diffDopeParams:globalDefault';

const readGlobalDefaultDiffDopeParams = (): DiffDopeParams => {
  try {
    const raw = localStorage.getItem(GLOBAL_DIFFDOPE_PARAMS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DIFFDOPE_PARAMS };
    const parsed = JSON.parse(raw) as Partial<DiffDopeParams>;
    return { ...DEFAULT_DIFFDOPE_PARAMS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_DIFFDOPE_PARAMS };
  }
};

const PoseAnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { images, loading, error } = useSelector((state: any) => state.annotation);
  const appAlert = useAppAlert();

  const [currentProject, setCurrentProject] = useState<any>(null);
  useProjectSessionGuard(currentProject?.id ? Number(currentProject.id) : null, !!currentProject?.id);
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
  const [meshPreviewTextureEnabled, setMeshPreviewTextureEnabled] = useState(true);
  const [meshPreviewDims, setMeshPreviewDims] = useState<{ x: number; y: number; z: number } | null>(null);
  const [projectLabelOptions, setProjectLabelOptions] = useState<Array<{ label: string; color: string }>>([]);
  const [estimating6d, setEstimating6d] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    running: boolean;
    total: number;
    current: number;
    success: number;
    failed: number;
    timeout: number;
  } | null>(null);
  const [showDiffDopeParamModal, setShowDiffDopeParamModal] = useState(false);
  const [showMeshLabelMappingModal, setShowMeshLabelMappingModal] = useState(false);
  const [repairingDepth, setRepairingDepth] = useState(false);
  const [depthRepairPopupDismissed, setDepthRepairPopupDismissed] = useState(false);
  const [depthRepairProgress, setDepthRepairProgress] = useState<{
    totalImages: number;
    processedImages: number;
    doneImages: number;
    failedImages: number;
  }>({
    totalImages: 0,
    processedImages: 0,
    doneImages: 0,
    failedImages: 0,
  });
  const [diffDopeParams, setDiffDopeParams] = useState<DiffDopeParams>(() => ({ ...DEFAULT_DIFFDOPE_PARAMS }));
  const [defaultDiffDopeParams, setDefaultDiffDopeParams] = useState<DiffDopeParams>(() =>
    readGlobalDefaultDiffDopeParams(),
  );
  const [hasInitialPoseForSelectedImage, setHasInitialPoseForSelectedImage] = useState<boolean | null>(null);
  const [singlePoseProgress, setSinglePoseProgress] = useState(0);
  const [singlePoseProgressText, setSinglePoseProgressText] = useState('正在计算中…');
  // 从后端项目映射表加载 label 列表（供 Mesh Label 对照表复用）
  useEffect(() => {
    if (!currentProject?.id) return;
    let cancelled = false;
    (async () => {
    try {
        const rows = await projectApi.getLabelColors(Number(currentProject.id));
        if (cancelled) return;
      const pairs = (rows || [])
        .map((it: any) => ({ label: String(it?.label || '').trim(), color: String(it?.color || '').trim() }))
        .filter((p: { label: string; color: string }) => p.label && p.color);
      pairs.sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
      setProjectLabelOptions(pairs);
    } catch (e) {
      console.warn('[PoseAnnotationPage] 读取 labelColorMap 失败:', e);
      setProjectLabelOptions([]);
    }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);

  const handlePreviewMeshNavigate = (direction: 'prev' | 'next') => {
    if (!selectedPreviewMesh?.id) return;
    const idx = projectMeshes.findIndex((m) => m.id === selectedPreviewMesh.id);
    if (idx < 0) return;
    const nextIdx = direction === 'prev' ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= projectMeshes.length) return;
    setSelectedPreviewMesh(projectMeshes[nextIdx] as any);
  };

  useEffect(() => {
    setMeshPreviewDims(null);
  }, [selectedPreviewMesh?.id]);

  // MeshPreview3D 的 bbox 尺寸单位来自模型导出（Blender 默认 m）。
  // 这里为了全局统一显示 cm：m -> cm。
  const fmtCmFromMeters = (v: number) => {
    if (!Number.isFinite(v)) return '-';
    const cm = v * 100;
    const n = Math.round(cm * 100) / 100; // 保留两位小数
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
              await appAlert.alert('您没有访问该项目的权限，请重新输入验证码');
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

  // 加载项目 Mesh 列表（底部 Mesh 区、Mesh Label 对照表、导出等均依赖；不依赖是否切到 Mesh 标签）
  useEffect(() => {
    if (!currentProject?.id) return;
    if (!authReady || !hasProjectAccess) return;

    (async () => {
      try {
        const meshes = await meshApi.getMeshes(currentProject.id);
        setProjectMeshes(meshes || []);
      } catch (e) {
        console.warn('[PoseAnnotationPage] 加载项目 Mesh 列表失败:', e);
      }
    })();
  }, [currentProject?.id, authReady, hasProjectAccess]);

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
  const THUMB_GAP = 16; // 与 2D 缩略图区（2DAnnotationPage / Shared）gap 风格一致
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

  const handleEstimate6D = async () => {
    if (!selectedPreviewImage?.id || !currentProject?.id || estimating6d) return;
    const confirmSingle = await appAlert.confirm(
      `确认开始对当前图片执行 AI 6D 姿态标注吗？\n\n图片：${selectedPreviewImage.originalName || selectedPreviewImage.filename}`,
      { title: '确认执行 AI 6D 标注' },
    );
    if (!confirmSingle) return;
    try {
      setEstimating6d(true);
      setSinglePoseProgress(5);
      setSinglePoseProgressText('整图执行中（后端逐 mask 两阶段优化）…');
      // Ensure the modal renders before we await the API and before any later alert blocks repaint.
      await new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return resolve();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const runOne = async (imageId: number | string) => {
        const body = buildDiffdopeEstimateBody();
        return await Promise.race([
          pose6dApi.diffdopeEstimate(imageId, {
            projectId: currentProject.id,
            onlyUniqueMasks: false,
            returnDebugImages: true,
            ...body,
          }),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('IMAGE_TIMEOUT_5MIN')), 5 * 60 * 1000)),
        ]);
      };
      let pollCancelled = false;
      const pollProgress = async () => {
        if (pollCancelled) return;
        try {
          const pResp: any = await pose6dApi.diffdopeProgress(selectedPreviewImage.id);
          const p = pResp?.progress;
          if (!p || pollCancelled) return;
          const total = Number(p?.total || 0);
          const completed = Number(p?.completed || 0);
          if (total > 0) {
            // 单张进度条保留 5% 起步，95% 映射后端完成度，收尾到 100% 由请求完成时设置。
            const percent = Math.max(5, Math.min(99, 5 + Math.round((completed / total) * 94)));
            setSinglePoseProgress(percent);
          }
          const msg = String(p?.message || '');
          if (msg) setSinglePoseProgressText(msg);
        } catch (_) {
          // polling 失败不打断主流程
        }
      };
      await pollProgress();
      const pollTimer = window.setInterval(() => {
        void pollProgress();
      }, 500);

      let resp: any;
      try {
        resp = await runOne(selectedPreviewImage.id);
      } finally {
        pollCancelled = true;
        window.clearInterval(pollTimer);
      }
      const results = Array.isArray(resp?.results) ? resp.results : [];
      const matchedPairs = results.length;
      setSinglePoseProgress(100);
      setSinglePoseProgressText('完成');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
      await appAlert.alert(`已完成标注，本次匹配 ${matchedPairs} 组 mask 和 mesh。`);
    } catch (e: any) {
      setSinglePoseProgress(100);
      setSinglePoseProgressText('完成');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
      await appAlert.alert('已完成标注，本次匹配 0 组 mask 和 mesh。');
    } finally {
      setEstimating6d(false);
      setSinglePoseProgress(0);
      setSinglePoseProgressText('正在计算中…');
    }
  };

  const handleBatchEstimate6D = async () => {
    if (!currentProject?.id || estimating6d) return;
    if (!images.length) {
      await appAlert.alert('当前项目没有可处理的图片。');
      return;
    }
    const confirmBatch = await appAlert.confirm(
      `确认开始批量 AI 6D 标注吗？\n\n将按顺序处理 ${images.length} 张图片。`,
      { title: '确认批量 AI 6D 标注' },
    );
    if (!confirmBatch) return;
    try {
      setEstimating6d(true);
      setBatchProgress({
        running: true,
        total: images.length,
        current: 0,
        success: 0,
        failed: 0,
        timeout: 0,
      });
      const runOne = async (imageId: number | string) => {
        const body = buildDiffdopeEstimateBody();
        return await Promise.race([
          pose6dApi.diffdopeEstimate(imageId, {
            projectId: currentProject.id,
            onlyUniqueMasks: false,
            returnDebugImages: true,
            ...body,
          }),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('IMAGE_TIMEOUT_5MIN')), 5 * 60 * 1000)),
        ]);
      };
      const refreshImages = async () => {
        try {
          const loadedImages = await imageApi.getImages(currentProject.id);
          dispatch(setImages(loadedImages));
          setImageCacheBust((v) => (v + 1) % 1_000_000);
        } catch (_) {}
      };

      let imageSuccess = 0;
      let imageTimeout = 0;
      let imageFailed = 0;

      for (const img of images) {
        setSelectedPreviewImage(img);
        try {
          const resp: any = await runOne(img.id);
          const results = Array.isArray(resp?.results) ? resp.results : [];
          const failures = Array.isArray(resp?.failures) ? resp.failures : [];
          if (results.length > 0 && failures.length === 0) imageSuccess += 1;
          else imageFailed += 1;
          setBatchProgress({
            running: true,
            total: images.length,
            current: imageSuccess + imageFailed + imageTimeout,
            success: imageSuccess,
            failed: imageFailed,
            timeout: imageTimeout,
          });
        } catch (e: any) {
          const msg = String(e?.message || '');
          if (msg.includes('IMAGE_TIMEOUT_5MIN') || e?.code === 'ECONNABORTED') {
            imageTimeout += 1;
            setBatchProgress({
              running: true,
              total: images.length,
              current: imageSuccess + imageFailed + imageTimeout,
              success: imageSuccess,
              failed: imageFailed,
              timeout: imageTimeout,
            });
            await refreshImages();
            continue;
          }
          imageFailed += 1;
          setBatchProgress({
            running: true,
            total: images.length,
            current: imageSuccess + imageFailed + imageTimeout,
            success: imageSuccess,
            failed: imageFailed,
            timeout: imageTimeout,
          });
        }
      }

      setBatchProgress({
        running: false,
        total: images.length,
        current: images.length,
        success: imageSuccess,
        failed: imageFailed,
        timeout: imageTimeout,
      });

      // 确保弹层完成到 100% 并完成过渡再弹出 alert（alert 会阻塞渲染）
      // ProgressPopupModal 的进度条有 CSS transition（0.2s），80ms 有时来不及。
      await new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return resolve();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));

      await appAlert.alert(
        [
          `标注结束，已标注 ${imageSuccess} 张。`,
        ].join(''),
      );
      setBatchProgress(null);
    } finally {
      setEstimating6d(false);
    }
  };

  const handleBatchRepairDepth = async () => {
    if (!currentProject?.id || repairingDepth) return;
    const confirmRepair = await appAlert.confirm(
      `确认开始批量补全深度信息吗？\n\n将按顺序处理 ${images.length} 张图片。`,
      { title: '确认批量补全深度' },
    );
    if (!confirmRepair) return;
    let cancelled = false;
    let intervalId: number | null = null;
    try {
      setRepairingDepth(true);
      setDepthRepairPopupDismissed(false);
      const projectId = currentProject.id;
      const sinceMs = Date.now();
      const total = images.length;

      setDepthRepairProgress({
        totalImages: total,
        processedImages: 0,
        doneImages: 0,
        failedImages: 0,
      });

      const pollOnce = async () => {
        try {
          const st = await depthApi.getBatchRepairStatus(projectId, sinceMs);
          if (cancelled) return;
          setDepthRepairProgress({
            totalImages: Number(st?.totalImages || 0),
            processedImages: Number(st?.processedImages || 0),
            doneImages: Number(st?.doneImages || 0),
            failedImages: Number(st?.failedImages || 0),
          });
        } catch (_) {
          // polling 失败不影响任务主流程
        }
      };

      // 任务开始后立即取一次，随后按固定频率轮询 DB 统计
      await pollOnce();
      intervalId = window.setInterval(pollOnce, 1200);

      const result: any = await depthApi.batchRepairDepth(projectId);

      cancelled = true;
      window.clearInterval(intervalId);

      const totalFromResp = Number(result?.totalImages || 0);
      const repairedImages = Number(result?.repairedImages ?? 0);
      const skipped = Number(result?.skipped || 0);
      const failed = Number(result?.failed || 0);

      // 尽量对齐“完成态”展示；即使 repairedImages != total，也不会影响进度条结束。
      setDepthRepairProgress((prev) => ({
        ...prev,
        totalImages: totalFromResp || prev.totalImages || total,
        processedImages: totalFromResp || prev.totalImages || total,
        doneImages: repairedImages,
        failedImages: failed,
      }));

      // 确保弹层完成到 100% 并完成过渡再弹出 alert（alert 会阻塞渲染）
      await new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return resolve();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));

      const totalForAlert = totalFromResp || total;
      const rolesSucceeded = Number(result?.upserted || 0);
      const details = Array.isArray(result?.failedDetails) ? result.failedDetails.filter(Boolean) : [];
      await appAlert.alert(
        [
          `批量补全深度信息完成：项目共 ${totalForAlert} 张图`,
          `其中完成写入的图像：${repairedImages} 张（至少有一条深度条目成功）`,
          `深度条目成功次数（按 camera / role）：${rolesSucceeded} 次`,
          `跳过条目：${skipped} 次（无深度文件、路径无效或缺文件等）`,
          `失败：${failed} 次`,
          details.length ? `\n失败详情：\n- ${details.slice(0, 12).join('\n- ')}${details.length > 12 ? '\n…' : ''}` : '',
        ].join('\n'),
      );
    } catch (e: any) {
      await appAlert.alert(e?.response?.data?.message || e?.message || '批量补全深度信息失败');
    } finally {
      setRepairingDepth(false);
      cancelled = true;
      if (intervalId != null) window.clearInterval(intervalId);
    }
  };

  useEffect(() => {
    if (!currentProject?.id) return;
    const key = `diffDopeParams:${currentProject.id}`;
    let stored: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(key);
      if (raw) stored = JSON.parse(raw) as Record<string, unknown>;
    } catch (_) {
      stored = {};
    }
    // 始终以 DEFAULT 为底再叠保存项，避免：① 代码新增字段丢失；② 切换项目时仍沿用上一项目的 state
    setDiffDopeParams(() => {
      const merged = { ...defaultDiffDopeParams, ...stored } as any;
      const gate = Number(merged.maxAllowedFinalLoss);
      merged.maxAllowedFinalLoss = Number.isFinite(gate) ? Math.min(200, Math.max(10, gate)) : defaultDiffDopeParams.maxAllowedFinalLoss;
      const s1lr = Number(merged.stage1BaseLr);
      merged.stage1BaseLr = Number.isFinite(s1lr) ? Math.min(200, Math.max(0.01, s1lr)) : defaultDiffDopeParams.stage1BaseLr;
      const s1decay = Number(merged.stage1LrDecay);
      merged.stage1LrDecay = Number.isFinite(s1decay) ? Math.min(1, Math.max(0.001, s1decay)) : defaultDiffDopeParams.stage1LrDecay;
      const s2lr = Number(merged.stage2BaseLr);
      merged.stage2BaseLr = Number.isFinite(s2lr) ? Math.min(200, Math.max(0.01, s2lr)) : defaultDiffDopeParams.stage2BaseLr;
      const s2decay = Number(merged.stage2LrDecay);
      merged.stage2LrDecay = Number.isFinite(s2decay) ? Math.min(1, Math.max(0.001, s2decay)) : defaultDiffDopeParams.stage2LrDecay;
      if (typeof stored.stage2UseRgb !== 'boolean' && stored.useRgbLoss === true) {
        merged.stage2UseRgb = true;
      }
      delete merged.useRgbLoss;
      merged.stage1UseMask = merged.stage1UseMask !== false;
      merged.stage1UseRgb = merged.stage1UseRgb !== false;
      merged.stage2UseMask = merged.stage2UseMask !== false;
      merged.stage2UseDepth = merged.stage2UseDepth !== false;
      merged.stage2UseRgb = !!merged.stage2UseRgb;
      let w2rgb = Number(merged.stage2WeightRgb);
      if (!Number.isFinite(w2rgb) && Number.isFinite(Number((merged as any).weightRgb))) {
        w2rgb = Number((merged as any).weightRgb);
      }
      merged.stage2WeightRgb = Number.isFinite(w2rgb)
        ? Math.min(2, Math.max(0, w2rgb))
        : defaultDiffDopeParams.stage2WeightRgb;
      delete (merged as any).weightRgb;
      const w1m = Number(merged.stage1WeightMask);
      merged.stage1WeightMask = Number.isFinite(w1m) ? Math.min(2, Math.max(0, w1m)) : defaultDiffDopeParams.stage1WeightMask;
      const w1r = Number(merged.stage1WeightRgb);
      merged.stage1WeightRgb = Number.isFinite(w1r) ? Math.min(2, Math.max(0, w1r)) : defaultDiffDopeParams.stage1WeightRgb;
      const w2m = Number(merged.stage2WeightMask);
      merged.stage2WeightMask = Number.isFinite(w2m) ? Math.min(2, Math.max(0, w2m)) : defaultDiffDopeParams.stage2WeightMask;
      const w2d = Number(merged.stage2WeightDepth);
      merged.stage2WeightDepth = Number.isFinite(w2d) ? Math.min(2, Math.max(0, w2d)) : defaultDiffDopeParams.stage2WeightDepth;
      if ([merged.stage1UseMask, merged.stage1UseRgb].filter(Boolean).length === 0) {
        merged.stage1UseMask = true;
        merged.stage1UseRgb = true;
      }
      if ([merged.stage2UseMask, merged.stage2UseDepth, merged.stage2UseRgb].filter(Boolean).length === 0) {
        merged.stage2UseMask = true;
        merged.stage2UseDepth = true;
      }
      delete (merged as any).diffDopeDebug;
      merged.useInitialPose = merged.useInitialPose === true;
      merged.onlySingleMesh = merged.onlySingleMesh === true;
      const tid = merged.targetMeshId;
      merged.targetMeshId = merged.onlySingleMesh ? (Number.isFinite(Number(tid)) && Number(tid) > 0 ? Number(tid) : null) : null;
      merged.depthSource = merged.depthSource === 'fix' ? 'fix' : 'raw';
      return merged;
    });
  }, [currentProject?.id, defaultDiffDopeParams]);

  // 当打开“调整拟合参数”弹窗时，探测当前选中图片是否存在人工初始位姿。
  // 若不存在，则禁用“使用初始位姿（若存在）”选项（避免用户误以为开启会产生效果）。
  useEffect(() => {
    if (!showDiffDopeParamModal) return;
    if (!selectedPreviewImage?.id) return;

    let cancelled = false;
    setHasInitialPoseForSelectedImage(null);

    (async () => {
      try {
        const resp = await pose9dApi.listPose9D(selectedPreviewImage.id);
        const poses = Array.isArray(resp?.poses) ? resp.poses : [];
        const ok = poses.some((p: any) => Array.isArray(p?.initialPose?.pose44));
        if (!cancelled) setHasInitialPoseForSelectedImage(ok);
      } catch (e) {
        if (!cancelled) setHasInitialPoseForSelectedImage(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showDiffDopeParamModal, selectedPreviewImage?.id]);

  // 若禁用条件触发，顺手把 useInitialPose 关闭，确保最终请求语义一致。
  useEffect(() => {
    if (!showDiffDopeParamModal) return;
    if (hasInitialPoseForSelectedImage !== false) return;
    if (!(diffDopeParams as any).useInitialPose) return;
    setDiffDopeParams((p) => ({ ...p, useInitialPose: false }));
  }, [showDiffDopeParamModal, hasInitialPoseForSelectedImage, diffDopeParams]);

  const buildDiffdopeEstimateBody = useCallback(() => {
    const p = diffDopeParams as Record<string, unknown>;
    return { ...p };
  }, [diffDopeParams]);

  return (
    <div className="annotation-page pose-annotation-page">
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
              <div className="welcome-content pose-welcome-content">
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
                    <DepthUploader
                      projectId={currentProject?.id}
                      disabled={!isAdmin}
                      title={!isAdmin ? '当前账号为标注用户，不能上传 Depth / 点云数据。如需新增，请联系管理员。' : undefined}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MeshUploader
                      projectId={currentProject?.id}
                      disabled={!isAdmin}
                      title={!isAdmin ? '当前账号为标注用户，不能上传 Mesh / 资产。如需新增，请联系管理员。' : undefined}
                      onUploadComplete={async (meshes) => {
                        if (!meshes || meshes.length === 0) return;
                        // 上传返回可能是“临时聚合结果”，为确保 assetDirUrl/assets 完整，
                        // 这里统一回读一次后端 Mesh 列表作为预览与缩略图的数据源。
                        try {
                          if (currentProject?.id) {
                            const latest = await meshApi.getMeshes(currentProject.id);
                            setProjectMeshes(latest || []);
                          }
                        } catch (e) {
                          console.warn('[PoseAnnotationPage] 上传后刷新 Mesh 列表失败，回退使用本地结果:', e);
                          setProjectMeshes((prev) => [...meshes, ...prev]);
                        }
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
                        className="ai-model-config-btn"
                        onClick={() => setShowDiffDopeParamModal(true)}
                        title="调整拟合参数"
                      >
                        调整拟合参数
                      </button>
                      <button
                        type="button"
                        className="ai-annotation-btn"
                        onClick={handleBatchEstimate6D}
                      disabled={!isAdmin || estimating6d || images.length === 0}
                        title={
                          !isAdmin
                            ? '普通用户已禁用：批量AI标注需要管理员权限'
                            : '按图片顺序执行 AI 6D 标注；单张超时 5 分钟后跳过并继续下一张'
                        }
                      >
                        {estimating6d ? '🤖 批量AI标注进行中...' : '🤖 批量AI标注'}
                      </button>
                      <BatchDepthCompletionButton
                        running={repairingDepth}
                        disabled={!isAdmin || !currentProject?.id || estimating6d || images.length === 0}
                        onClick={handleBatchRepairDepth}
                        title={
                          !isAdmin
                            ? '普通用户已禁用：批量补全深度信息需要管理员权限'
                            : '按图片顺序批量补全深度信息（调用 depthrepair-service，产物写入项目 depth 目录）'
                        }
                      />
                      <ProgressPopupModal
                        open={!!batchProgress}
                        title={batchProgress?.running ? '批量AI标注进度' : '批量AI标注结果'}
                        closable={!batchProgress?.running}
                        onClose={() => setBatchProgress(null)}
                        bars={[
                          {
                            key: 'pose-batch',
                            title: '批量进度',
                            percent:
                              batchProgress?.total
                                ? (batchProgress.current / Math.max(1, batchProgress.total)) * 100
                                : 0,
                            currentText:
                              batchProgress && batchProgress.total > 0
                                ? `当前：${batchProgress.current}/${batchProgress.total}`
                                : undefined,
                          } satisfies ProgressPopupBar,
                        ]}
                        summary={
                          batchProgress ? (
                            <>
                              成功 {batchProgress.success} / 失败 {batchProgress.failed} / 超时 {batchProgress.timeout}
                            </>
                          ) : undefined
                        }
                      />
                      <ProgressPopupModal
                        open={repairingDepth && !depthRepairPopupDismissed}
                        title="批量补全深度信息"
                        closable={!repairingDepth}
                        onClose={() => setDepthRepairPopupDismissed(true)}
                        bars={[
                          {
                            key: 'depth-repair-batch',
                            title: '写入进度',
                            percent:
                              depthRepairProgress.totalImages > 0
                                ? (depthRepairProgress.processedImages / depthRepairProgress.totalImages) * 100
                                : 0,
                            currentText:
                              depthRepairProgress.totalImages > 0
                                ? `已处理：${depthRepairProgress.processedImages}/${depthRepairProgress.totalImages}（完成:${depthRepairProgress.doneImages} 失败:${depthRepairProgress.failedImages}）`
                                : '正在处理并写入 Depth / Intrinsics…',
                          } satisfies ProgressPopupBar,
                        ]}
                      />
                      <ProgressPopupModal
                        open={estimating6d && !batchProgress && !repairingDepth}
                        title="AI 6D姿态标注"
                        bars={[
                          {
                            key: 'pose-single',
                            title: '计算进度',
                            percent: singlePoseProgress,
                        currentText: singlePoseProgressText,
                          } satisfies ProgressPopupBar,
                        ]}
                      />
                      <div className="import-export-buttons">
                        <button
                          type="button"
                          className="label-mapping-btn"
                          onClick={() => {
                            if (!currentProject) {
                              void appAlert.alert('请先选择项目');
                              return;
                            }
                            setShowMeshLabelMappingModal(true);
                          }}
                          disabled={!isAdmin || !currentProject}
                          title={!isAdmin ? '普通用户已禁用：Mesh Label 对照表需要管理员权限' : '查看 / 编辑各 Mesh 的 SKU Label（缩略图与底部网格一致）'}
                        >
                          🏷️ Mesh Label 对照表
                        </button>
                        <PoseAnnotationsZipExportButton
                          className="ai-annotation-btn export-btn"
                          project={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
                          images={images}
                          meshes={projectMeshes}
                          isAdmin={isAdmin}
                        />
                      </div>
                    </div>
                  </div>

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
                          <div>长（x）：{fmtCmFromMeters(meshPreviewDims.x)} cm</div>
                          <div>高（y）：{fmtCmFromMeters(meshPreviewDims.y)} cm</div>
                          <div>宽（z）：{fmtCmFromMeters(meshPreviewDims.z)} cm</div>
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

                      <button
                        type="button"
                        className="secondary-button"
                        style={{ background: '#dc2626', borderColor: '#b91c1c', color: '#fff' }}
                        onClick={async () => {
                          if (!selectedPreviewMesh?.id) return;
                          const ok = await appAlert.confirm(
                            `确定删除 Mesh：${selectedPreviewMesh.originalName || selectedPreviewMesh.filename} ？`,
                            { title: '确认删除' },
                          );
                          if (!ok) return;
                          try {
                            await meshApi.deleteMesh(selectedPreviewMesh.id);
                            setProjectMeshes((prev) => prev.filter((m) => m.id !== selectedPreviewMesh.id));
                            setSelectedPreviewMesh(null);
                          } catch (e: any) {
                            console.error('[PoseAnnotationPage] 删除 Mesh 失败:', e);
                            await appAlert.alert(e?.message || '删除 Mesh 失败');
                          }
                        }}
                        title="删除该 Mesh（会同时删除其 9D Pose 记录）"
                      >
                        删除 Mesh
                      </button>

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
              ) : (
                <PoseImagePreviewPanel
                  selectedPreviewImage={selectedPreviewImage}
                  images={images}
                  imageCacheBust={imageCacheBust}
                  estimating6d={estimating6d}
                  onClose={() => setSelectedPreviewImage(null)}
                  onNavigate={handlePreviewNavigate}
                  onEstimate6D={handleEstimate6D}
                  onStartManualAnnotation={() => {
                    if (!selectedPreviewImage) return;
                    dispatch(setCurrentImage(selectedPreviewImage));
                    navigate('/pose/manual-annotation');
                  }}
                />
              )}
            </div>

            {/* 下方：沿用图片列表区域占位（后续可用于选择对应的 RGB/Depth） */}
            {currentProject && images.length > 0 && (
              <div className="welcome-bottom">
                <div className="uploaded-images-preview">
                  <div className="preview-header uploaded-preview-header">
                    <h3>
                      {bottomViewMode === 'images'
                        ? `项目图片(${images.length})`
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

      <PoseDiffDopeParamModal
        open={showDiffDopeParamModal}
        onClose={() => setShowDiffDopeParamModal(false)}
        diffDopeParams={diffDopeParams}
        setDiffDopeParams={setDiffDopeParams}
        defaultDiffDopeParams={defaultDiffDopeParams}
        currentProjectId={currentProject?.id ?? null}
        hasInitialPoseForSelectedImage={hasInitialPoseForSelectedImage}
        projectMeshes={projectMeshes}
        isAdmin={isAdmin}
        onSaveAsDefault={async (next) => {
          localStorage.setItem(GLOBAL_DIFFDOPE_PARAMS_STORAGE_KEY, JSON.stringify(next));
          setDefaultDiffDopeParams({ ...DEFAULT_DIFFDOPE_PARAMS, ...next });
          await appAlert.alert('已将当前拟合参数保存为“全局默认值”');
        }}
      />
      {/* 旧的内联弹窗代码已清理：由 PoseDiffDopeParamModal 组件承担 */}

      <MeshLabelMappingModal
        open={showMeshLabelMappingModal}
        onClose={() => setShowMeshLabelMappingModal(false)}
        projectId={currentProject?.id}
        meshes={projectMeshes}
        projectLabelOptions={projectLabelOptions}
        onMeshesUpdated={(next) => {
          setProjectMeshes(next);
          setSelectedPreviewMesh((prev) => {
            if (!prev?.id) return prev;
            const hit = next.find((m) => m.id === prev.id);
            return hit ? (hit as any) : prev;
          });
        }}
      />

    </div>
  );
};

export default PoseAnnotationPage;

