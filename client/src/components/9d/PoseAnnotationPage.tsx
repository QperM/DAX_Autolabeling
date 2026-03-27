import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setCurrentImage, setError, setImages, setLoading } from '../../store/annotationSlice';
import { authApi, depthApi, imageApi, meshApi, pose6dApi, pose9dApi, projectApi } from '../../services/api';
import type { Image } from '../../types';
import { clearStoredCurrentProject, getStoredCurrentProject } from '../../utils/tabStorage';
import MeshLabelMappingModal from './MeshLabelMappingModal';
import './PoseAnnotationPage.css';
import PoseDiffDopeParamModal, { type DiffDopeParams } from './PoseDiffDopeParamModal';
import PoseImagePreviewPanel from './PoseImagePreviewPanel';
import PoseDepthInspectorPanel, { type DepthEntry } from './PoseDepthInspectorPanel';
import PoseMeshPreviewPanel from './PoseMeshPreviewPanel';
import PoseBottomAssetBrowser from './PoseBottomAssetBrowser';
import PoseWorkspaceControls from './PoseWorkspaceControls';
import { useAppAlert } from '../common/AppAlert';
import { useProjectSessionGuard } from '../../utils/projectSessionGuard';
import { debugLog } from '../../utils/debugSettings';
import { compareWindowsFilename, sortByWindowsFilename } from '../../utils/windowsFilenameSort';

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

type DepthListItem = {
  id: number | null;
  filename: string;
  size?: number;
  url: string;
  role?: string;
  modality?: string;
  uploadTime?: string;
  imageId?: number | null;
  cameraId?: number | null;
  depthRawFixUrl?: string | null;
  depthPngFixUrl?: string | null;
};

type CameraItem = {
  id: number;
  projectId: number;
  role: string;
  intrinsics: any;
  intrinsicsFileSize?: number | null;
  updatedAt?: string | null;
};

type DepthGroupEntry = {
  depthId: number;
  kind: 'depth_png' | 'depth_raw' | 'depth_png_fix' | 'depth_raw_fix';
  filename: string;
  role?: string;
  imageId?: number | null;
};

const isDepthDataRow = (d: { filename?: string | null; modality?: string | null }) => {
  const modality = String(d?.modality || '').trim().toLowerCase();
  if (modality === 'intrinsics') return false;
  if (modality.startsWith('depth')) return true;
  const filename = String(d?.filename || '').trim().toLowerCase();
  if (!filename) return false;
  if (filename.startsWith('rgb_') || filename.includes('/rgb_') || filename.includes('\\rgb_')) return false;
  return filename.startsWith('depth_') || filename.startsWith('depthraw_') || filename.startsWith('depthfix_');
};

type DepthGroupView = {
  key: string;
  entries: (DepthGroupEntry & DepthEntry)[];
};

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
  const [bottomViewMode, setBottomViewMode] = useState<'images' | 'meshes' | 'intrinsics' | 'depth'>('images');
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
  const [depthRows, setDepthRows] = useState<DepthListItem[]>([]);
  const [cameraRows, setCameraRows] = useState<CameraItem[]>([]);
  const [depthRowsLoading, setDepthRowsLoading] = useState(false);
  const [deletingDepthId, setDeletingDepthId] = useState<number | null>(null);
  const [deletingCameraId, setDeletingCameraId] = useState<number | null>(null);
  const [selectedDepthId, setSelectedDepthId] = useState<number | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<number | null>(null);
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

  const handleDeleteSelectedMesh = useCallback(async () => {
    if (!isAdmin) {
      await appAlert.alert('仅管理员可删除 Mesh。');
      return;
    }
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
  }, [isAdmin, selectedPreviewMesh, appAlert]);

  useEffect(() => {
    setMeshPreviewDims(null);
  }, [selectedPreviewMesh?.id]);

  const handleMeshPreviewBoundsChange = useCallback((size: { x: number; y: number; z: number } | null) => {
    setMeshPreviewDims(size);
  }, []);

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
        const sortedImages = sortByWindowsFilename(loadedImages, (img) => img.originalName || img.filename);
        dispatch(setImages(sortedImages));
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
        setProjectMeshes(sortByWindowsFilename(meshes || [], (m: any) => m.originalName || m.filename));
      } catch (e) {
        console.warn('[PoseAnnotationPage] 加载项目 Mesh 列表失败:', e);
      }
    })();
  }, [currentProject?.id, authReady, hasProjectAccess]);

  const refreshDepthAndCameras = useCallback(async () => {
    if (!currentProject?.id) return;
    setDepthRowsLoading(true);
    try {
      const [depth, cameras] = await Promise.all([
        depthApi.getDepth(currentProject.id),
        depthApi.getCameras(currentProject.id),
      ]);
      setDepthRows(Array.isArray(depth) ? depth : []);
      setCameraRows(Array.isArray(cameras) ? cameras : []);
    } catch (e) {
      console.warn('[PoseAnnotationPage] 加载 depth/cameras 失败:', e);
      setDepthRows([]);
      setCameraRows([]);
    } finally {
      setDepthRowsLoading(false);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject?.id) return;
    if (!authReady || !hasProjectAccess) return;
    void refreshDepthAndCameras();
  }, [currentProject?.id, authReady, hasProjectAccess, refreshDepthAndCameras]);

  useEffect(() => {
    // project 或图片列表变动时更新一次即可，避免每次 render 都触发图片重新请求
    setImageCacheBust((v) => (v + 1) % 1_000_000);
  }, [currentProject?.id, images.length, bottomViewMode]);

  useEffect(() => {
    // 切换底部视图时，清理另一个模式的选中态，避免右上预览混乱
    if (bottomViewMode === 'images') {
      setSelectedPreviewMesh(null);
      setSelectedDepthId(null);
      setSelectedCameraId(null);
    } else if (bottomViewMode === 'meshes') {
      setSelectedPreviewImage(null);
      setSelectedDepthId(null);
      setSelectedCameraId(null);
    } else {
      setSelectedPreviewImage(null);
      setSelectedPreviewMesh(null);
    }
  }, [bottomViewMode]);

  useEffect(() => {
    // 进入深度视图时自动选中一条深度记录，便于右侧立即展示详情
    if (bottomViewMode !== 'depth') return;
    if (selectedDepthId != null) return;
    const all = depthRows.filter((d) => isDepthDataRow(d) && d.id != null);
    if (all.length === 0) return;
    let pick = all[0];
    if (selectedPreviewImage?.id) {
      const bound = all.find((d) => d.imageId === selectedPreviewImage.id);
      if (bound) pick = bound;
    }
    setSelectedDepthId(pick?.id != null ? Number(pick.id) : null);
  }, [selectedPreviewImage?.id, bottomViewMode, depthRows, selectedDepthId]);

  const THUMB_SIZE = 125;
  const THUMB_GAP = 16; // 与 2D 缩略图区（2DAnnotationPage / Shared）gap 风格一致

  const projectIntrinsicsRows = useMemo(() => {
    return (cameraRows || []).slice().sort((a, b) => compareWindowsFilename(a.role || '', b.role || ''));
  }, [cameraRows]);


  const depthGroups = useMemo<DepthGroupView[]>(() => {
    const all = (depthRows || []).filter((d) => isDepthDataRow(d));
    const map = new Map<string, DepthGroupEntry[]>();
    const keyOf = (name: string) => {
      const base = String(name || '')
        .replace(/\\/g, '/')
        .split('/')
        .pop() || String(name || '');
      const noExt = base.replace(/\.[^.]+$/, '');
      return noExt.replace(/^(depth_raw_fix_|depth_fix_|depth_raw_|depth_|rgb_)+/i, '');
    };
    const baseOfUrl = (u?: string | null) => {
      if (!u) return '';
      const plain = String(u).split('?')[0];
      return plain.replace(/\\/g, '/').split('/').pop() || '';
    };
    const seen = new Set<string>();
    const push = (key: string, entry: DepthGroupEntry) => {
      const dedupeKey = `${key}|${entry.kind}|${entry.filename}|${entry.imageId ?? 'na'}|${entry.role || ''}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    };
    for (const f of all) {
      const k = keyOf(f.filename || '');
      const mapId = Number(f.id || 0);
      if (!mapId || Number.isNaN(mapId)) continue;
      if (f.modality === 'depth_png') {
        push(k, { depthId: mapId, kind: 'depth_png', filename: f.filename, role: f.role, imageId: f.imageId ?? null });
      } else if (f.modality === 'depth_raw') {
        push(k, { depthId: mapId, kind: 'depth_raw', filename: f.filename, role: f.role, imageId: f.imageId ?? null });
      }
      const pngFix = baseOfUrl(f.depthPngFixUrl || null);
      if (pngFix) push(k, { depthId: mapId, kind: 'depth_png_fix', filename: pngFix, role: f.role, imageId: f.imageId ?? null });
      const rawFix = baseOfUrl(f.depthRawFixUrl || null);
      if (rawFix) push(k, { depthId: mapId, kind: 'depth_raw_fix', filename: rawFix, role: f.role, imageId: f.imageId ?? null });
    }
    const order = (m?: string) => {
      if (m === 'depth_png') return 1;
      if (m === 'depth_png_fix') return 2;
      if (m === 'depth_raw') return 3;
      if (m === 'depth_raw_fix') return 4;
      return 9;
    };
    return Array.from(map.entries())
      .map(([key, entries]) => ({
        key,
        entries: entries
          .slice()
          .sort((a, b) => order(a.kind) - order(b.kind) || compareWindowsFilename(a.filename, b.filename)),
      }))
      .sort((a, b) => compareWindowsFilename(a.key, b.key));
  }, [depthRows]);

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

  const displayedDepthRows = useMemo(() => depthGroups.flatMap((g) => g.entries), [depthGroups]);

  const selectedDepthRow = useMemo(() => {
    if (!selectedDepthId) return null;
    return depthRows.find((d) => Number(d.id || 0) === Number(selectedDepthId)) || null;
  }, [displayedDepthRows, selectedDepthId]);

  const selectedRgbImage = useMemo(() => {
    if (!selectedDepthRow?.imageId) return null;
    return images.find((img: Image) => img.id === Number(selectedDepthRow.imageId)) || null;
  }, [selectedDepthRow?.imageId, images]);

  const selectedDepthGroup = useMemo(() => {
    if (!selectedDepthId) return null;
    return depthGroups.find((g) => g.entries.some((e) => Number(e.depthId) === Number(selectedDepthId))) || null;
  }, [depthGroups, selectedDepthId]);

  const selectedCameraRow = useMemo(() => {
    if (!selectedCameraId) return null;
    return projectIntrinsicsRows.find((c) => Number(c.id) === Number(selectedCameraId)) || null;
  }, [projectIntrinsicsRows, selectedCameraId]);

  useEffect(() => {
    if (bottomViewMode !== 'intrinsics') return;
    if (selectedCameraId != null) return;
    if (projectIntrinsicsRows.length === 0) return;
    setSelectedCameraId(projectIntrinsicsRows[0].id);
  }, [bottomViewMode, selectedCameraId, projectIntrinsicsRows]);

  const handleDeleteSelectedDepth = useCallback(async () => {
    if (!selectedDepthRow?.id) return;
    const ok = await appAlert.confirm(`确定删除深度文件：${selectedDepthRow.filename} ？`, { title: '确认删除深度' });
    if (!ok) return;
    try {
      setDeletingDepthId(Number(selectedDepthRow.id));
      await depthApi.deleteDepthMap(Number(selectedDepthRow.id));
      setSelectedDepthId(null);
      await refreshDepthAndCameras();
    } catch (e: any) {
      await appAlert.alert(e?.response?.data?.message || e?.message || '删除深度失败');
    } finally {
      setDeletingDepthId(null);
    }
  }, [selectedDepthRow, appAlert, refreshDepthAndCameras]);

  const handleDeleteDepthEntry = useCallback(
    async (entry: DepthGroupEntry) => {
      const ok = await appAlert.confirm(`确定删除文件：${entry.filename} ？`, { title: '确认删除深度文件' });
      if (!ok) return;
      try {
        setDeletingDepthId(Number(entry.depthId));
        await depthApi.deleteDepthFile(entry.depthId, entry.kind);
        setSelectedDepthId(null);
        await refreshDepthAndCameras();
      } catch (e: any) {
        await appAlert.alert(e?.response?.data?.message || e?.message || '删除深度文件失败');
      } finally {
        setDeletingDepthId(null);
      }
    },
    [appAlert, refreshDepthAndCameras],
  );

  const handleDeleteSelectedCamera = useCallback(async () => {
    if (!selectedCameraRow?.id) return;
    const ok = await appAlert.confirm(`确定删除相机内参：role=${selectedCameraRow.role} ？`, { title: '确认删除内参' });
    if (!ok) return;
    try {
      setDeletingCameraId(Number(selectedCameraRow.id));
      await depthApi.deleteCamera(Number(selectedCameraRow.id));
      setSelectedCameraId(null);
      await refreshDepthAndCameras();
    } catch (e: any) {
      await appAlert.alert(e?.response?.data?.message || e?.message || '删除相机内参失败');
    } finally {
      setDeletingCameraId(null);
    }
  }, [selectedCameraRow, appAlert, refreshDepthAndCameras]);

  const handleEstimate6D = async () => {
    if (!selectedPreviewImage?.id || !currentProject?.id || estimating6d) return;
    const confirmSingle = await appAlert.confirm(
      `确认开始对当前图片执行 AI 6D 姿态标注吗？\n\n图片：${selectedPreviewImage.originalName || selectedPreviewImage.filename}`,
      { title: '确认执行 AI 6D 标注' },
    );
    if (!confirmSingle) return;
    try {
      setEstimating6d(true);
      setSinglePoseProgress(1);
      setSinglePoseProgressText('任务已提交，正在进入队列…');
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
          const qResp: any = await pose6dApi.diffdopeQueueStatus();
          const q = qResp?.status;
          if (q?.active && q?.state === 'queued') {
            const pos = Number(q?.queuePosition || 0);
            debugLog('frontend', 'frontendDiffdopeQueue', '[PoseAnnotationPage] queue status', { state: 'queued', pos });
            setSinglePoseProgress(Math.min(4, Math.max(1, pos > 0 ? 5 - pos : 1)));
            setSinglePoseProgressText(pos > 0 ? `排队中：当前第 ${pos} 位` : '排队中，等待可用计算槽位…');
            return;
          }
          if (q?.active && q?.state === 'running') {
            debugLog('frontend', 'frontendDiffdopeQueue', '[PoseAnnotationPage] queue status', { state: 'running' });
          }
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
      const failures = Array.isArray(resp?.failures) ? resp.failures : [];
      const matchedPairs = results.length;
      setSinglePoseProgress(100);
      setSinglePoseProgressText('完成');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
      if (!resp?.success || matchedPairs <= 0) {
        const detail = failures.length > 0 ? String(failures[0]) : String(resp?.message || '本次未生成可用的拟合结果（可能 objectsCount=0）');
        await appAlert.alert(`AI 6D 标注失败：${detail}`);
      } else {
        await appAlert.alert(`已完成标注，本次匹配 ${matchedPairs} 组 mask 和 mesh。`);
      }
    } catch (e: any) {
      setSinglePoseProgress(100);
      setSinglePoseProgressText('完成');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
      const msg = String(e?.response?.data?.message || e?.message || '本次未生成可用的拟合结果（可能 objectsCount=0）');
      await appAlert.alert(`AI 6D 标注失败：${msg}`);
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
          const sortedImages = sortByWindowsFilename(loadedImages, (img) => img.originalName || img.filename);
          dispatch(setImages(sortedImages));
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
      await refreshDepthAndCameras();
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
              <PoseWorkspaceControls
                currentProject={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
                isAdmin={isAdmin}
                images={images}
                estimating6d={estimating6d}
                repairingDepth={repairingDepth}
                batchProgress={batchProgress}
                depthRepairPopupDismissed={depthRepairPopupDismissed}
                depthRepairProgress={depthRepairProgress}
                singlePoseProgress={singlePoseProgress}
                singlePoseProgressText={singlePoseProgressText}
                projectMeshes={projectMeshes}
                onDepthUploadComplete={() => {
                  void refreshDepthAndCameras();
                }}
                onMeshUploadComplete={async (meshes) => {
                  if (!meshes || meshes.length === 0) return;
                  try {
                    if (currentProject?.id) {
                      const latest = await meshApi.getMeshes(currentProject.id);
                      setProjectMeshes(latest || []);
                    }
                  } catch (e) {
                    console.warn('[PoseAnnotationPage] 上传后刷新 Mesh 列表失败，回退使用本地结果:', e);
                    setProjectMeshes((prev) => [...meshes, ...prev]);
                  }
                  if (bottomViewMode !== 'meshes') setBottomViewMode('meshes');
                }}
                onOpenDiffDopeParams={() => setShowDiffDopeParamModal(true)}
                onBatchEstimate6D={handleBatchEstimate6D}
                onBatchRepairDepth={handleBatchRepairDepth}
                onCloseBatchProgress={() => setBatchProgress(null)}
                onDismissDepthRepairPopup={() => setDepthRepairPopupDismissed(true)}
                onOpenMeshLabelMapping={() => {
                  if (!currentProject) {
                    void appAlert.alert('请先选择项目');
                    return;
                  }
                  setShowMeshLabelMappingModal(true);
                }}
              />
            </div>

            {/* 右上：预览区 */}
            <div className="welcome-right-top">
              {bottomViewMode === 'meshes' ? (
                <PoseMeshPreviewPanel
                  selectedPreviewMesh={selectedPreviewMesh}
                  projectMeshes={projectMeshes}
                  meshPreviewTextureEnabled={meshPreviewTextureEnabled}
                  meshPreviewDims={meshPreviewDims}
                  isAdmin={isAdmin}
                  onClose={() => setSelectedPreviewMesh(null)}
                  onNavigate={handlePreviewMeshNavigate}
                  onToggleTexture={() => setMeshPreviewTextureEnabled((v) => !v)}
                  onMeshBoundsChange={handleMeshPreviewBoundsChange}
                  onDeleteMesh={handleDeleteSelectedMesh}
                />
              ) : bottomViewMode === 'depth' || bottomViewMode === 'intrinsics' ? (
                <PoseDepthInspectorPanel
                  mode={bottomViewMode}
                  selectedImageName={selectedPreviewImage?.originalName || selectedPreviewImage?.filename || null}
                  selectedRgbOriginalName={selectedRgbImage?.originalName || selectedRgbImage?.filename || null}
                  selectedDepth={selectedDepthRow}
                  selectedCamera={selectedCameraRow}
                  selectedDepthEntries={selectedDepthGroup?.entries || []}
                  loading={depthRowsLoading}
                  deleting={deletingDepthId != null || deletingCameraId != null}
                  canDelete={isAdmin}
                  onDeleteDepth={handleDeleteSelectedDepth}
                  onDeleteDepthEntry={handleDeleteDepthEntry}
                  onDeleteCamera={handleDeleteSelectedCamera}
                />
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
            <PoseBottomAssetBrowser
              currentProject={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
              bottomViewMode={bottomViewMode}
              setBottomViewMode={setBottomViewMode}
              images={images}
              imageCacheBust={imageCacheBust}
              THUMB_SIZE={THUMB_SIZE}
              THUMB_GAP={THUMB_GAP}
              projectMeshes={projectMeshes}
              projectIntrinsicsRows={projectIntrinsicsRows}
              depthGroups={depthGroups}
              displayedDepthRowsCount={displayedDepthRows.length}
              selectedPreviewImage={selectedPreviewImage}
              selectedPreviewMesh={selectedPreviewMesh}
              selectedCameraId={selectedCameraId}
              selectedDepthId={selectedDepthId}
              onSelectPreviewImage={setSelectedPreviewImage}
              onSelectPreviewMesh={setSelectedPreviewMesh}
              onSelectCamera={setSelectedCameraId}
              onSelectDepthGroup={setSelectedDepthId}
            />

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

