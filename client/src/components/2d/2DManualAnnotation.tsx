import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setCurrentImage } from '../../store/annotationSlice';
import type { Image, Mask, BoundingBox, Polygon } from '../../types';
import { annotationApi, authApi, projectApi } from '../../services/api';
import AnnotationCanvas from './AnnotationCanvas';
import { getStoredCurrentProject } from '../../utils/tabStorage';
import { toAbsoluteUrl } from '../../utils/urls';
import './2DManualAnnotation.css';
import { useAppAlert } from '../common/AppAlert';
import { useProjectSessionGuard } from '../../utils/projectSessionGuard';
import { assignMissingColorsForAnnotations, buildLabelColorMapFromSources } from '../common/annotationColorLogic';
import { SAM2_OBJECT_LABEL, SAM2_OBJECT_RESERVED_COLOR } from '../common/annotationColors';

const ManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images, annotations } = useSelector((state: any) => state.annotation);
  const appAlert = useAppAlert();
  const [selectedTool, setSelectedTool] = useState<'eraser' | 'mask' | 'point' | 'draw'>('mask');
  const [selectedMaskIds, setSelectedMaskIds] = useState<string[]>([]);
  const [mergeRequestNonce, setMergeRequestNonce] = useState(0);
  const [brushSize, setBrushSize] = useState(20);
  const [pointSpacingPx, setPointSpacingPx] = useState<number>(6);
  // 需求：每次进入人工标注页，默认显示“标注图层”
  // 图层类型：背景 / 标注(Mask+BBox) / 仅 Bounding Box
  const [activeLayer, setActiveLayer] = useState<'background' | 'annotation' | 'bbox'>('annotation');
  const [masks, setMasks] = useState<Mask[]>([]);
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
  const [polygons, setPolygons] = useState<Polygon[]>([]);
  type HistoryEntry = { masks: Mask[]; boundingBoxes: BoundingBox[]; polygons: Polygon[] };
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [showEraserDropdown, setShowEraserDropdown] = useState(false);
  const eraserWrapperRef = useRef<HTMLDivElement | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true); // 默认开启自动保存
  const lastKeyNavigateAtRef = useRef<number | null>(null); // 记录上一次键盘切图时间，用于限速
  const [projectLabelMappings, setProjectLabelMappings] = useState<Array<{ label: string; labelZh?: string; color: string; usageOrder?: number }>>([]);
  const projectId = getStoredCurrentProject<any>()?.id;
  const GLOBAL_MODEL_PARAMS_STORAGE_KEY = 'modelParams:globalDefault';
  useProjectSessionGuard(projectId ? Number(projectId) : null, !!projectId);
  const [singleAnnotating, setSingleAnnotating] = useState(false);
  /** 项目图片总数（数据库 project_images 聚合，与 Redux 分页列表长度解耦） */
  const [totalProjectImages, setTotalProjectImages] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const summary = await projectApi.getAnnotationSummary(Number(projectId));
        if (!cancelled && summary) setTotalProjectImages(Number(summary.totalImages) || 0);
      } catch {
        if (!cancelled) setTotalProjectImages(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 继承模型参数：用于合并/橡皮擦时的“轮廓点间距”
  useEffect(() => {
    if (!projectId) return;
    const perProjectKey = `modelParams:${projectId}`;
    try {
      const raw =
        localStorage.getItem(perProjectKey) ??
        localStorage.getItem(GLOBAL_MODEL_PARAMS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{ maxPolygonPoints: number }>;
      const v = Number(parsed?.maxPolygonPoints);
      if (Number.isFinite(v) && v > 0) setPointSpacingPx(Math.max(1, Math.min(30, v)));
    } catch (e) {
      // ignore
    }
  }, [projectId]);

  // 权限检查和图片检查
  useEffect(() => {
    const checkAuthAndImage = async () => {
      // 检查权限
      try {
        const authStatus = await authApi.checkAuth();
        if (!authStatus.authenticated) {
          navigate('/');
          return;
        }
        
        // 检查项目访问权限
        const savedProject = getStoredCurrentProject<any>();
        if (savedProject) {
          try {
            const project = savedProject;
            if (!authStatus.isAdmin) {
              // checkAuth() 已在 session 中返回 accessibleProjectIds，优先使用它，避免每次都回源查询所有可访问项目
              let hasAccess = false;
              const accessibleIds = (authStatus as any).accessibleProjectIds;
              if (Array.isArray(accessibleIds) && accessibleIds.length > 0) {
                hasAccess = accessibleIds.includes(project.id);
              } else {
                const accessibleProjects = await authApi.getAccessibleProjects();
                hasAccess = accessibleProjects.some((p) => p.id === project.id);
              }
              if (!hasAccess) {
                await appAlert.alert('您没有访问该项目的权限，请重新输入验证码');
                navigate('/');
                return;
              }
            }
          } catch (e) {
            console.error('解析项目失败', e);
          }
        }
      } catch (error) {
        console.error('权限检查失败', error);
        navigate('/');
        return;
      }
      
      // 检查是否有选中的图片
    const timer = setTimeout(() => {
      if (!currentImage) {
        // 如果没有选中图片，回到上一级标注页，而不是直接退回首页
        navigate('/annotate', { replace: true });
      }
    }, 200);
    
    return () => clearTimeout(timer);
    };
    
    checkAuthAndImage();
  }, [currentImage, navigate]);

  // 加载当前图片的标注（mask / bbox 等）
  const cachedAnnotationForCurrent = currentImage ? annotations?.[currentImage.id] : undefined;
  useEffect(() => {
    const loadAnnotation = async () => {
      if (!currentImage) {
        const emptyMasks: Mask[] = [];
        const emptyBBoxes: BoundingBox[] = [];
        const emptyPolygons: Polygon[] = [];
        setMasks(emptyMasks);
        setBoundingBoxes(emptyBBoxes);
        setPolygons(emptyPolygons);
        setHistory([{ masks: emptyMasks, boundingBoxes: emptyBBoxes, polygons: emptyPolygons }]);
        setHistoryIndex(0);
        return;
      }

      try {
        // 优先从 Redux 中读（如果之前已经加载过）
        const cached = cachedAnnotationForCurrent;
        if (cached) {
          const nextMasks = cached.masks || [];
          const nextBBoxes = cached.boundingBoxes || [];
          const nextPolygons = cached.polygons || [];
          setMasks(nextMasks);
          setBoundingBoxes(nextBBoxes);
          setPolygons(nextPolygons);
          setHistory([{ masks: nextMasks, boundingBoxes: nextBBoxes, polygons: nextPolygons }]);
          setHistoryIndex(0);
          return;
        }

        // 否则从后端拉取
        const resp = await annotationApi.getAnnotation(currentImage.id);
        const anno = resp?.annotation;

        if (anno) {
          const nextMasks = anno.masks || [];
          const nextBBoxes = anno.boundingBoxes || [];
          const nextPolygons = anno.polygons || [];
          setMasks(nextMasks);
          setBoundingBoxes(nextBBoxes);
          setPolygons(nextPolygons);
          setHistory([{ masks: nextMasks, boundingBoxes: nextBBoxes, polygons: nextPolygons }]);
          setHistoryIndex(0);
        } else {
          const emptyMasks: Mask[] = [];
          const emptyBBoxes: BoundingBox[] = [];
          const emptyPolygons: Polygon[] = [];
          setMasks(emptyMasks);
          setBoundingBoxes(emptyBBoxes);
          setPolygons(emptyPolygons);
          setHistory([{ masks: emptyMasks, boundingBoxes: emptyBBoxes, polygons: emptyPolygons }]);
          setHistoryIndex(0);
        }
      } catch (e) {
        console.error('[ManualAnnotation] 加载标注数据失败:', e);
        const emptyMasks: Mask[] = [];
        const emptyBBoxes: BoundingBox[] = [];
        const emptyPolygons: Polygon[] = [];
        setMasks(emptyMasks);
        setBoundingBoxes(emptyBBoxes);
        setPolygons(emptyPolygons);
        setHistory([{ masks: emptyMasks, boundingBoxes: emptyBBoxes, polygons: emptyPolygons }]);
        setHistoryIndex(0);
      }
    };

    loadAnnotation();
  }, [currentImage?.id, cachedAnnotationForCurrent]);

  const handleToolSelect = (tool: 'eraser' | 'mask' | 'point' | 'draw') => {
    setSelectedTool(tool);
    // 用户切换工具后，统一回到 Mask 图层，避免停留在背景/BBox 图层导致“工具无效”的误解。
    setActiveLayer('annotation');
  };

  // 点击外部时关闭橡皮擦笔刷下拉
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!showEraserDropdown) return;
      if (eraserWrapperRef.current && !eraserWrapperRef.current.contains(event.target as Node)) {
        setShowEraserDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showEraserDropdown]);

  const handleBack = () => {
    dispatch(setCurrentImage(null));
    navigate('/annotate', { replace: true });
  };

  const handleNavigateImage = async (direction: 'prev' | 'next') => {
    if (!currentImage || !images || images.length === 0) return;
    const currentIndex = images.findIndex((img: Image) => img.id === currentImage.id);
    if (currentIndex === -1) return;

    // 自动保存：在切换图片之前，优先保存当前标注
    if (autoSaveEnabled) {
      const ok = await handleSaveAnnotation({ silent: true });
      if (!ok) {
        // 自动保存失败则不继续切换，避免丢失标注
        return;
      }
    }

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

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

  // 键盘左右方向键切换上一张 / 下一张图片 + 撤销/重做
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果当前焦点在输入框 / 文本域 / 下拉框中，则不处理左右键，避免与重命名弹窗等表单输入冲突
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable)
      ) {
        return;
      }

      // 撤销 / 重做
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      if (isCtrlOrMeta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (isCtrlOrMeta && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();

        // 键盘切图限速：最多每 500ms 切一张，避免连续快速触发导致自动保存/加载竞态
        const now = Date.now();
        const last = lastKeyNavigateAtRef.current ?? 0;
        const MIN_INTERVAL = 500; // 毫秒，对应每秒最多 2 张
        if (now - last < MIN_INTERVAL) {
          return;
        }
        lastKeyNavigateAtRef.current = now;

        if (e.key === 'ArrowLeft') {
          handleNavigateImage('prev');
        } else {
          handleNavigateImage('next');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    currentImage,
    images,
    autoSaveEnabled,
    canUndo,
    canRedo,
    historyIndex,
    history.length,
    masks,
    boundingBoxes,
    polygons,
  ]);

  // 将当前图片中实际使用到的「标签-颜色」写入后端项目映射表。
  const persistProjectLabelMapsFromCurrentImage = async () => {
    try {
      const savedProject = getStoredCurrentProject<any>();
      if (!savedProject) return;
      const p = savedProject;
      const projectId = p && typeof p.id === 'number' ? p.id : null;
      if (!projectId) return;
      const entries = new Map<string, { label: string; color: string; usageOrder?: number }>();

      // 先放入当前项目已存在映射，避免“仅保存当前图片”时把别的图片标签覆盖掉
      projectLabelMappings.forEach((item) => {
        const label = String(item?.label || '').trim();
        const color = String(item?.color || '').trim();
        if (!label || !color) return;
        const key = label.toLowerCase().replace(/\s+/g, ' ');
        if (!entries.has(key)) {
          entries.set(key, { label, color, usageOrder: Number(item?.usageOrder || 0) });
        }
      });

      masks.forEach((mask) => {
        const label = (mask.label || '').trim();
        const color = mask.color;
        if (!label || !color) return;
        const key = label.toLowerCase().replace(/\s+/g, ' ');
        if (!entries.has(key)) entries.set(key, { label, color });
      });

      boundingBoxes.forEach((bbox) => {
        const label = (bbox.label || '').trim();
        const color = bbox.color;
        if (!label || !color) return;
        const key = label.toLowerCase().replace(/\s+/g, ' ');
        if (!entries.has(key)) entries.set(key, { label, color });
      });
      const zhByLabel = new Map<string, string>();
      projectLabelMappings.forEach((item) => {
        const label = String(item?.label || '').trim();
        const labelZh = String(item?.labelZh || '').trim();
        if (!label || !labelZh) return;
        const key = label.toLowerCase().replace(/\s+/g, ' ');
        if (!zhByLabel.has(key)) zhByLabel.set(key, labelZh);
      });

      const payload = Array.from(entries.values())
        .sort((a, b) => Number(a.usageOrder ?? 9999) - Number(b.usageOrder ?? 9999))
        .map((v, idx) => {
          const key = String(v.label || '').toLowerCase().replace(/\s+/g, ' ');
          return {
            label: v.label,
            labelZh: zhByLabel.get(key) || '',
            color: v.color,
            usageOrder: Number.isFinite(Number(v.usageOrder)) ? Number(v.usageOrder) : idx,
          };
        });
      await projectApi.saveLabelColors(projectId, payload);
      setProjectLabelMappings(
        payload.map((v) => ({
          label: String(v.label || ''),
          labelZh: String((v as any).labelZh || ''),
          color: String(v.color || ''),
          usageOrder: Number(v.usageOrder || 0),
        })),
      );
    } catch (err) {
      console.warn('[ManualAnnotation] 持久化项目级标签映射失败', err);
    }
  };

  const handleSaveAnnotation = async (options?: { silent?: boolean }): Promise<boolean> => {
    if (!currentImage) return false;
    const silent = options?.silent ?? false;
    try {
      await annotationApi.saveAnnotation(currentImage.id, {
        masks,
        boundingBoxes,
        polygons,
      });
      // 标注保存成功后，再把当前图片中实际使用到的“标签-颜色”写入项目级映射，
      // 这样新标签只会在保存之后才出现在其他图片的下拉框中。
      await persistProjectLabelMapsFromCurrentImage();
      if (!silent) {
        await appAlert.alert('标注已保存');
      }
      return true;
    } catch (e: any) {
      console.error('[ManualAnnotation] 保存标注失败:', e);
      if (!silent) {
        await appAlert.alert(e?.message || '保存标注失败');
      } else {
        void appAlert.alert(e?.message || '自动保存失败，请稍后重试手动保存');
      }
      return false;
    }
  };

  const getModelParamsForAutoAnnotate = () => {
    // 与 2DAnnotationPage 完全对齐：优先使用项目级参数，其次全局默认
    const pid = projectId ? String(projectId) : '';
    const perProjectKey = pid ? `modelParams:${pid}` : '';
    try {
      const raw = (perProjectKey && localStorage.getItem(perProjectKey)) || localStorage.getItem(GLOBAL_MODEL_PARAMS_STORAGE_KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        maxPolygonPoints?: number;
        sam2PointsPerSide?: number;
        sam2PredIouThresh?: number;
        sam2StabilityScoreThresh?: number;
        sam2BoxNmsThresh?: number;
        sam2MinMaskRegionArea?: number;
      };
      return {
        maxPolygonPoints:
          typeof parsed.maxPolygonPoints === 'number'
            ? Math.max(1, Math.min(30, parsed.maxPolygonPoints))
            : 6,
        sam2PointsPerSide:
          typeof parsed.sam2PointsPerSide === 'number' ? parsed.sam2PointsPerSide : 20,
        sam2PredIouThresh:
          typeof parsed.sam2PredIouThresh === 'number' ? parsed.sam2PredIouThresh : 0.88,
        sam2StabilityScoreThresh:
          typeof parsed.sam2StabilityScoreThresh === 'number'
            ? parsed.sam2StabilityScoreThresh
            : 0.95,
        sam2BoxNmsThresh:
          typeof parsed.sam2BoxNmsThresh === 'number' ? parsed.sam2BoxNmsThresh : 0.35,
        sam2MinMaskRegionArea:
          typeof parsed.sam2MinMaskRegionArea === 'number'
            ? parsed.sam2MinMaskRegionArea
            : 6000,
      };
    } catch {
      return undefined;
    }
  };

  const handleSingleAIAutoAnnotate = async () => {
    if (!currentImage) return;
    if (singleAnnotating) return;

    const ok = await appAlert.confirm(
      `确认开始对当前图片执行 AI 标注吗？\n\n图片：${currentImage.originalName || currentImage.filename}`,
      { title: '确认执行 AI 标注' },
    );
    if (!ok) return;

    try {
      setSingleAnnotating(true);

      const modelParams = getModelParamsForAutoAnnotate();
      const result = await annotationApi.autoAnnotate(currentImage.id, modelParams);
      const anno = result?.annotations || { masks: [], boundingBoxes: [] };

      // 确保颜色稳定：object 固定色，其它按项目映射+调色板补齐
      const seedMap = buildLabelColorMapFromSources({
        projectLabelMappings,
        masks,
        boundingBoxes,
      });
      seedMap.set(SAM2_OBJECT_LABEL, SAM2_OBJECT_RESERVED_COLOR);
      const colored = assignMissingColorsForAnnotations(
        { masks: anno.masks || [], boundingBoxes: anno.boundingBoxes || [] },
        seedMap,
      );

      await annotationApi.saveAnnotation(currentImage.id, {
        masks: colored.masks,
        boundingBoxes: colored.boundingBoxes,
        polygons,
      });

      setMasks(colored.masks);
      setBoundingBoxes(colored.boundingBoxes);
      pushHistory(colored.masks, colored.boundingBoxes, polygons);

      await persistProjectLabelMapsFromCurrentImage();
      await appAlert.alert('当前图片 AI 标注完成（结果已保存，可继续人工微调）');
    } catch (e: any) {
      console.error('[ManualAnnotation] 单张 AI 标注失败:', e);
      await appAlert.alert(e?.message || 'AI 标注失败，请稍后重试');
    } finally {
      setSingleAnnotating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadMappings = async () => {
      try {
        const savedProject = getStoredCurrentProject<any>();
        const projectId = savedProject && typeof savedProject.id === 'number' ? savedProject.id : null;
        if (!projectId) return;
        const mappings = await projectApi.getLabelColors(projectId);
        if (!cancelled) setProjectLabelMappings((mappings || []).map((m: any) => ({
          label: String(m?.label || ''),
          labelZh: String(m?.labelZh || ''),
          color: String(m?.color || ''),
          usageOrder: Number(m?.usageOrder || 0),
        })));
      } catch (_) {}
    };
    void loadMappings();
    return () => {
      cancelled = true;
    };
  }, [currentImage?.id]);

  // ------- 本地操作栈：撤销 / 重做 -------
  const pushHistory = (nextMasks: Mask[], nextBBoxes: BoundingBox[], nextPolygons: Polygon[]) => {
    const snapshot: HistoryEntry = {
      masks: nextMasks.map(m => ({ ...m, points: [...(m.points || [])] })),
      boundingBoxes: nextBBoxes.map(b => ({ ...b })),
      polygons: nextPolygons.map(p => ({ ...p, points: [...(p.points || [])] })),
    };
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, snapshot];
    });
    setHistoryIndex(prev => prev + 1);
  };

  const applyHistoryEntry = (entry: HistoryEntry) => {
    setMasks(entry.masks);
    setBoundingBoxes(entry.boundingBoxes);
    setPolygons(entry.polygons);
  };

  const handleUndo = () => {
    if (!canUndo) return;
    const nextIndex = historyIndex - 1;
    const entry = history[nextIndex];
    if (!entry) return;
    setHistoryIndex(nextIndex);
    applyHistoryEntry(entry);
  };

  const handleRedo = () => {
    if (!canRedo) return;
    const nextIndex = historyIndex + 1;
    const entry = history[nextIndex];
    if (!entry) return;
    setHistoryIndex(nextIndex);
    applyHistoryEntry(entry);
  };

  const getEffectiveMaskColor = (mask: Mask) => mask.color || 'rgba(255, 0, 0, 0.7)';
  const getEffectiveBboxColor = (bbox: BoundingBox) => bbox.color || 'rgba(0, 255, 0, 0.7)';

  // 统计当前标注中的“颜色 -> label”，用于右侧标签图例展示
  // 目标：你改某个颜色对应的 label 时，该颜色下所有对象的 label 一起被修改
  const colorLabelEntries: Array<[string, string]> = (() => {
    const map = new Map<string, string>(); // color -> label

    masks.forEach((mask) => {
      const color = getEffectiveMaskColor(mask);
      let label = (mask.label || '').trim();
      // 对于默认灰色且尚未命名的 Mask，用“未分配”占位，方便在右侧图例中看到
      if (!label) {
        if (color === '#7F7F7F') {
          label = '未分配';
        } else {
          return;
        }
      }
      if (!map.has(color)) {
        map.set(color, label);
      }
    });

    boundingBoxes.forEach((bbox) => {
      const color = getEffectiveBboxColor(bbox);
      let label = (bbox.label || '').trim();
      if (!label) {
        if (color === '#7F7F7F') {
          label = '未分配';
        } else {
          return;
        }
      }
      if (!map.has(color)) {
        map.set(color, label);
      }
    });

    return Array.from(map.entries());
  })();

  if (!currentImage) {
    return null;
  }

  const loadedIndex = images ? images.findIndex((img: Image) => img.id === currentImage.id) : -1;
  const counterNumerator = loadedIndex >= 0 ? loadedIndex + 1 : '…';
  const counterDenominator =
    totalProjectImages != null && totalProjectImages > 0 ? totalProjectImages : images?.length ?? 0;

  return (
    <div className="manual-annotation">
      {/* 顶部导航栏 */}
      <header className="annotation-header">
        <div className="header-left">
          <button className="back-button" onClick={handleBack}>
            ← 返回
          </button>
          <h1>人工标注</h1>
          <span className="current-image-name">
            {currentImage.originalName || currentImage.filename}
          </span>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="nav-arrow-button"
            onClick={() => handleNavigateImage('prev')}
            disabled={!images || images.length === 0 || images.findIndex((img: Image) => img.id === currentImage.id) <= 0}
            title="上一张（←）"
          >
            ←
          </button>
          <span className="image-counter" title="分母为数据库中该项目的图片总数；分子为当前在已加载列表中的序号">
            {counterNumerator} / {counterDenominator}
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
            title="下一张（→）"
          >
            →
          </button>
        </div>
      </header>

      {/* 主工作区域 */}
      <div className="annotation-main">
        {/* 左侧悬浮面板 - 选择整块 / 橡皮擦 / 点编辑 */}
        <div className="annotation-left-panel">
          <div className="tool-section">
            {/* 整块 Mask 选择工具 */}
            <button
              className={`select-card ${selectedTool === 'mask' ? 'active' : ''}`}
              onClick={() => {
                handleToolSelect('mask');
                setShowEraserDropdown(false);
              }}
              title="选择（整块 Mask：点击选中，长按框选，Delete 删除，R 改颜色和标签）"
            >
              <div className="select-icon-box">
                <span className="select-icon">🧊</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">选择</div>
              </div>
            </button>

            <div className={`eraser-wrapper ${showEraserDropdown ? 'open' : ''}`} ref={eraserWrapperRef}>
              <button
                className={`eraser-card ${selectedTool === 'eraser' ? 'active' : ''}`}
                onClick={() => {
                  handleToolSelect('eraser');
                  setShowEraserDropdown(prev => !prev);
                }}
                title="橡皮擦"
              >
                <div className="eraser-icon-box">
                  <span className="eraser-icon">🧹</span>
                </div>
                <div className="eraser-text-box">
                  <div className="eraser-title">橡皮擦</div>
                </div>
              </button>
              <div className="eraser-dropdown">
                <div className="brush-controls">
                  <div className="size-slider">
                    <input
                      type="range"
                      min={5}
                      max={80}
                      step={1}
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                    />
                    <span className="size-value">{brushSize}px</span>
                  </div>
                  <div className="brush-preview">
                    <div
                      className="brush-circle"
                      style={{
                        width: `${brushSize}px`,
                        height: `${brushSize}px`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <button
              className={`select-card ${selectedTool === 'point' ? 'active' : ''}`}
              onClick={() => {
                handleToolSelect('point');
                setShowEraserDropdown(false);
              }}
              title="点编辑（拖动/删除/插入 Mask 顶点微调）
              I 插入 Mask 顶点，delete 删除 Mask 顶点"
            >
              <div className="select-icon-box">
                <span className="select-icon">🎯</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">点编辑</div>
              </div>
            </button>

            <button
              className={`select-card ${selectedTool === 'draw' ? 'active' : ''}`}
              onClick={() => {
                handleToolSelect('draw');
                setShowEraserDropdown(false);
              }}
              title="新建 Mask（左键逐点点击，最后再点回第一个点以结束；默认灰色，之后可用“选择”+R 命名并上色）"
            >
              <div className="select-icon-box">
                <span className="select-icon">✏️</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">新建 Mask</div>
              </div>
            </button>

            <button
              type="button"
              className="select-card"
              onClick={handleSingleAIAutoAnnotate}
              disabled={singleAnnotating}
              title="对当前图片执行 AI 标注（结果会覆盖当前图片的 Mask/BBox，并保存到后端）"
            >
              <div className="select-icon-box">
                <span className="select-icon">🤖</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">{singleAnnotating ? 'AI标注中...' : 'AI标注'}</div>
              </div>
            </button>

            <button
              type="button"
              className="select-card"
              disabled={selectedTool !== 'mask' || selectedMaskIds.length < 2}
              onClick={() => setMergeRequestNonce((n) => n + 1)}
              title="合并mask：在“选择”模式下按住 Ctrl 多选多个 Mask，然后点击合并为一个"
            >
              <div className="select-icon-box">
                <span className="select-icon">🔗</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">合并mask</div>
              </div>
            </button>
          </div>
        </div>

        {/* 中间面板 - 标注画布 */}
        <div className="annotation-center-panel">
          <div className="canvas-area">
            <AnnotationCanvas
              imageUrl={toAbsoluteUrl(currentImage.url) || currentImage.url}
              activeLayer={activeLayer}
              masks={masks}
              boundingBoxes={boundingBoxes}
              polygons={polygons}
              toolMode={
                selectedTool === 'eraser'
                  ? 'eraser'
                  : selectedTool === 'mask'
                    ? 'mask-select'
                    : selectedTool === 'draw'
                      ? 'polygon'
                      : 'select'
              }
              brushSize={brushSize}
              pointSpacingPx={pointSpacingPx}
              mergeRequestNonce={mergeRequestNonce}
              onSelectedMaskIdsChange={(ids) => setSelectedMaskIds(ids)}
              onMergeUpdate={({ masks: mergedMasks, boundingBoxes: mergedBBoxes, polygons: mergedPolygons }) => {
                setMasks(mergedMasks);
                setBoundingBoxes(mergedBBoxes);
                setPolygons(mergedPolygons);
                pushHistory(mergedMasks, mergedBBoxes, mergedPolygons);
              }}
              onMaskUpdate={(updatedMasks) => {
                setMasks(updatedMasks);
                pushHistory(updatedMasks, boundingBoxes, polygons);
              }}
              onBoundingBoxUpdate={(updatedBBoxes) => {
                setBoundingBoxes(updatedBBoxes);
                pushHistory(masks, updatedBBoxes, polygons);
              }}
              onPolygonUpdate={(updatedPolygons) => {
                setPolygons(updatedPolygons);
                pushHistory(masks, boundingBoxes, updatedPolygons);
              }}
              projectLabelMappings={projectLabelMappings}
            />
          </div>
        </div>

        {/* 右侧面板 - 属性面板 */}
        <div className="annotation-right-panel">
          <div className="properties-panel">
            <h3>属性面板</h3>
            <div className="property-section">
              <h4>当前工具</h4>
              <div className="current-tool">
                {selectedTool === 'eraser' && '橡皮擦'}
                {selectedTool === 'mask' && '选择（整块 Mask：点击选中，长按框选；Delete 删除；R 或右键弹出改色改名；重命名弹窗中可用↑/↓或鼠标滚轮切换标签）'}
                {selectedTool === 'point' && '点编辑（拖动/删除"Delete"/插入"I"）'}
                {selectedTool === 'draw' && '新建 Mask：鼠标点击依次创建点，连成一圈后自动闭合生成新的 Mask。'}
              </div>
              <div className="tool-history-row">
                <button
                  type="button"
                  className="tool-history-btn"
                  onClick={handleUndo}
                  disabled={!canUndo}
                  title="撤销上一步 (Ctrl+Z)"
                >
                  ↶ 撤销
                </button>
                <button
                  type="button"
                  className="tool-history-btn"
                  onClick={handleRedo}
                  disabled={!canRedo}
                  title="重做 (Ctrl+Y / Ctrl+Shift+Z)"
                >
                  ↷ 重做
                </button>
              </div>
            </div>

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div
                  className={`layer-item ${activeLayer === 'background' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveLayer('background');
                  }}
                >
                  <span>背景图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
                <div
                  className={`layer-item ${activeLayer === 'annotation' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveLayer('annotation');
                  }}
                >
                  <span>Mask 图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
                <div
                  className={`layer-item ${activeLayer === 'bbox' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveLayer('bbox');
                  }}
                >
                  <span>Bounding Box 图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
              </div>
            </div>

            <div className="property-section">
              <h4>保存</h4>
              <div className="save-row">
                <label className="auto-save-toggle">
                  <input
                    type="checkbox"
                    checked={autoSaveEnabled}
                    onChange={(e) => setAutoSaveEnabled(e.target.checked)}
                  />
                  <span>自动保存</span>
                </label>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => handleSaveAnnotation()}
                >
                  保存标注（JSON）
                </button>
              </div>
            </div>
          </div>

          {/* 标签图例：从 properties-panel 内挪出，作为 annotation-right-panel 的直系子节点 */}
          {colorLabelEntries.length > 0 && (
            <div className="property-section label-legend-section">
              <h4>标签图例</h4>
              <div className="label-legend">
                {colorLabelEntries.map(([color, label]) => (
                  <div className="label-legend-item" key={color}>
                    <span
                      className="label-color-dot"
                      style={{ backgroundColor: color }}
                    />
                    <span
                      className="label-name"
                      title={`颜色: ${color}（当前: ${label}）`}
                    >
                      {label}
                    </span>
                  </div>
                ))}
              </div>
              <div className="label-legend-hint">
                当前显示的是“颜色-标签”对照关系，仅供查看；如需修改，请在左侧使用“选择”工具选中对象后按 R 键重命名。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ManualAnnotation;