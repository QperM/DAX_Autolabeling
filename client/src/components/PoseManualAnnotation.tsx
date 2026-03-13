import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image, Mask } from '../types';
import { setCurrentImage } from '../store/annotationSlice';
import { authApi, depthApi, meshApi, pose9dApi, annotationApi } from '../services/api';
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
  const [meshesInScene, setMeshesInScene] = useState<MeshInfo[]>([]); // 场景中的多 Mesh
  const [meshInScene, setMeshInScene] = useState<MeshInfo | null>(null); // 当前选中 Mesh（TransformControls 绑定对象）
  const [meshTransformsByUrl, setMeshTransformsByUrl] = useState<
    Record<
      string,
      {
        position: { x: number; y: number; z: number };
        rotationDeg: { x: number; y: number; z: number };
        scale: { x: number; y: number; z: number };
      }
    >
  >({});
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
  const [meshBounds, setMeshBounds] = useState<{
    originalSize: { x: number; y: number; z: number };
    sceneSize: { x: number; y: number; z: number };
    fitScale: number;
  } | null>(null);
  // 每个 mesh 的 base 信息（用于“按图片批量保存”时拿原始 bounding/fitScale）
  const [meshBaseByUrl, setMeshBaseByUrl] = useState<
    Record<string, { originalSize: { x: number; y: number; z: number }; fitScale: number }>
  >({});
  const [transformRequestId, setTransformRequestId] = useState(0);
  // 只保留一个整体 Scale（等比缩放）
  const [scaleDraft, setScaleDraft] = useState<string>('1');
  const [isEditingScale, setIsEditingScale] = useState(false);

  // 右侧图层：
  // - RGB / 深度 / Mask：作为一组“2D Overlay”，组内可以叠加显示（RGB + 深度 + Mask）
  // - 点云图层：与整个 2D 组互斥（开点云 => 关 2D；开任一 2D => 关点云）
  const [showRgbLayer, setShowRgbLayer] = useState(true);
  const [showDepthLayer, setShowDepthLayer] = useState(false);
  const [showMaskLayer, setShowMaskLayer] = useState(false);
  const [showPointCloudLayer, setShowPointCloudLayer] = useState(false);
  // Mask 图层摘要文案已移除，因此不再维护 summary state（避免无效渲染/告警）
  // const [maskLayerSummary, setMaskLayerSummary] = useState<{ masks: number; bboxes: number } | null>(null);
  const [maskOverlayData, setMaskOverlayData] = useState<Mask[] | null>(null);
  // mask 拉取防串台：切图很快时，旧请求晚返回会覆盖新图片的 maskOverlay
  const maskFetchReqIdRef = useRef(0);
  const [depthList, setDepthList] = useState<DepthInfo[]>([]);
  const [selectedDepthId, setSelectedDepthId] = useState<number | null>(null);
  const [depthOpacity, setDepthOpacity] = useState(0.45);
  const [depthBlendMode, setDepthBlendMode] = useState<'multiply' | 'normal' | 'screen'>('multiply');
  const [pointStride, setPointStride] = useState(2);
  const [pointDepthScale, setPointDepthScale] = useState(1.0);
  // depth 拉取防串台：切图很快时，旧请求晚返回会覆盖新图片的 depthList
  const depthFetchReqIdRef = useRef(0);

  const selectedDepth = useMemo(() => {
    if (!selectedDepthId) return null;
    const sid = Number(selectedDepthId);
    return depthList.find((d) => Number((d as any).id) === sid) || null;
  }, [depthList, selectedDepthId]);

  const projectId = getStoredCurrentProject<any>()?.id;

  // 切图保护：切换图片时临时禁用 auto-save，避免把上一张图的 pose 写进下一张图
  const isSwitchingImageRef = useRef(false);
  useEffect(() => {
    if (!currentImage?.id) return;
    isSwitchingImageRef.current = true;
    // 切图时先清空深度选择，避免点云/深度叠加仍引用上一张图的 depth
    setSelectedDepthId(null);
    setDepthList([]);
    // 切图时清空 mask overlay 数据（开关状态保留，由后续 effect 自动为新图重新加载）
    setMaskOverlayData(null);
    // 下一帧再放开（等 state 清空 + 恢复流程跑起来）
    const t = window.setTimeout(() => {
      isSwitchingImageRef.current = false;
    }, 0);
    return () => window.clearTimeout(t);
  }, [currentImage?.id]);

  // 切图时：若 Mask 图层开启，则自动加载新图片的 2D mask overlay（避免一直显示第一张图）
  useEffect(() => {
    if (!currentImage?.id) return;
    if (!showMaskLayer) return;
    (async () => {
      const reqId = ++maskFetchReqIdRef.current;
      try {
        const resp = await annotationApi.getAnnotation(currentImage.id);
        const anno = resp?.annotation;
        if (reqId !== maskFetchReqIdRef.current) return;
        const masks = anno?.masks || [];
        setMaskOverlayData(masks);
      } catch (e) {
        if (reqId !== maskFetchReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 切图时加载 2D Mask 标注失败:', e);
        setMaskOverlayData(null);
      }
    })();
  }, [currentImage?.id, showMaskLayer]);

  // 切图时：若 深度图层开启，则自动加载新图片的 depth 列表并选中 depth_png（避免切图后深度消失）
  useEffect(() => {
    if (!currentImage?.id) return;
    if (!projectId) return;
    if (!showDepthLayer) return;
    (async () => {
      const reqId = ++depthFetchReqIdRef.current;
      try {
        const list = await depthApi.getDepth(projectId, currentImage.id);
        if (reqId !== depthFetchReqIdRef.current) return;
        setDepthList(list);
        const firstPng = list.find(
          (d) =>
            d.modality === 'depth_png' || String(d.originalName || d.filename).toLowerCase().endsWith('.png'),
        );
        setSelectedDepthId(firstPng ? Number((firstPng as any).id) : list[0] ? Number((list[0] as any).id) : null);
      } catch (e) {
        if (reqId !== depthFetchReqIdRef.current) return;
        console.warn('[PoseManualAnnotation] 切图时加载深度列表失败:', e);
        setDepthList([]);
        setSelectedDepthId(null);
      }
    })();
  }, [currentImage?.id, projectId, showDepthLayer]);

  // 切图时：若点云图层开启，则为新图片自动切到其 depth_raw（.npy），否则点云无法更新
  useEffect(() => {
    if (!currentImage?.id) return;
    if (!projectId) return;
    if (!showPointCloudLayer) return;
    (async () => {
      try {
        const reqId = ++depthFetchReqIdRef.current;
        const list = await depthApi.getDepth(projectId, currentImage.id);
        if (reqId !== depthFetchReqIdRef.current) return; // 已切到更新的图片请求，忽略旧结果
        setDepthList(list);
        const firstRaw = list.find(
          (d) =>
            d.modality === 'depth_raw' || String(d.originalName || d.filename).toLowerCase().endsWith('.npy'),
        );
        if (firstRaw) {
          setSelectedDepthId(Number((firstRaw as any).id));
        } else {
          // 新图没有 depth_raw，就关闭点云层，避免继续显示上一张图的点云
          setShowPointCloudLayer(false);
          setSelectedDepthId(null);
        }
      } catch (e) {
        console.warn('[PoseManualAnnotation] 切图时加载 depth_raw 失败，将关闭点云层:', e);
        setShowPointCloudLayer(false);
        setSelectedDepthId(null);
      }
    })();
  }, [currentImage?.id, projectId, showPointCloudLayer]);

  // 当点云图层关闭时，清空场景中的 Mesh
  useEffect(() => {
    if (!showPointCloudLayer) {
      setMeshesInScene([]);
      setMeshInScene(null);
      setMeshTransformsByUrl({});
      setMeshBounds(null);
      setTransformValues({
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
      setScaleDraft('1');
      setIsEditingScale(false);
    }
  }, [showPointCloudLayer]);

  // 自动恢复：打开点云后，读取该图片在数据库中的 9D Pose 列表，恢复多 Mesh
  useEffect(() => {
    if (!showPointCloudLayer) return;
    if (!projectId) return;
    if (!currentImage) return;

    (async () => {
      try {
        const list = meshes.length > 0 ? meshes : await meshApi.getMeshes(projectId);
        if (meshes.length === 0) setMeshes(list);
        // 拉取该 image 下所有 pose
        const resp = await pose9dApi.listPose9D(currentImage.id);
        const poses: any[] = resp?.poses || [];
        const meshIds = new Set<number>();
        poses.forEach((p) => {
          const mid = p?.mesh_id ?? p?.meshId ?? p?.mesh_id;
          if (mid != null && Number.isFinite(Number(mid))) meshIds.add(Number(mid));
        });
        const toLoad = list.filter((m) => m.id != null && meshIds.has(Number(m.id)));

        // 构建每个 mesh 的 transform（key=mesh.url）
        const nextTransforms: Record<string, any> = {};
        const extractPose = (row: any) => {
          const p = row?.pose;
          if (!p) return null;
          // 兼容：直接存 pose 或存 payload（含 pose 字段）
          const poseObj = p?.pose && p?.mesh ? p.pose : p;
          if (!poseObj?.position || !poseObj?.rotationDeg) return null;
          const s = Number(poseObj.scale) || 1;
          return {
            position: poseObj.position,
            rotationDeg: poseObj.rotationDeg,
            scale: { x: s, y: s, z: s },
          };
        };
        toLoad.forEach((m) => {
          const row = poses.find((r) => Number(r.mesh_id) === Number(m.id));
          const t = extractPose(row);
          if (t) nextTransforms[m.url] = t;
        });

        // 切换图片时先清空，避免残留
        setMeshesInScene(toLoad);
        setMeshTransformsByUrl(nextTransforms);

        // 默认选中最新的一条 pose 的 mesh（若存在）
        const firstMeshId = poses?.[0]?.mesh_id;
        const selected = firstMeshId != null ? toLoad.find((m) => m.id === Number(firstMeshId)) : (toLoad[0] || null);
        setMeshInScene(selected || null);

        // 同步 UI 为选中 mesh 的 transform（若有）
        const t = selected ? nextTransforms[selected.url] : null;
        if (t) {
          setTransformValues(t);
          setScaleDraft(String(t.scale.x));
          setTransformRequestId((id) => id + 1);
        } else {
          setTransformValues({
            position: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          });
          setScaleDraft('1');
          setTransformRequestId((id) => id + 1);
        }
      } catch (e) {
        console.warn('[PoseManualAnnotation] 自动恢复 9D Pose 列表失败:', e);
        // 无记录时应当不显示任何 mesh
        setMeshesInScene([]);
        setMeshInScene(null);
        setMeshTransformsByUrl({});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPointCloudLayer, projectId, currentImage?.id]);

  // 场景 -> UI：同步 scale 数值到输入框（不打断用户正在输入）
  useEffect(() => {
    if (isEditingScale) return;
    const sx = transformValues.scale.x;
    const sy = transformValues.scale.y;
    const sz = transformValues.scale.z;
    // 只展示整体 scale：优先取平均值（理论上应始终相等）
    const s = (sx + sy + sz) / 3;
    // 避免展示过长的小数
    const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '1');
    setScaleDraft(fmt(s));
  }, [transformValues.scale.x, transformValues.scale.y, transformValues.scale.z, isEditingScale]);

  const applyScaleDraft = () => {
    const parsed = Number(scaleDraft);
    // 输入阶段允许 0 / 0. / 空等中间态；应用阶段做校验
    const v = Number.isFinite(parsed) ? parsed : NaN;
    const safe = !Number.isFinite(v) || v <= 0 ? 1 : v;

    const next = { ...transformValues, scale: { x: safe, y: safe, z: safe } };
    setTransformValues(next);
    setScaleDraft(String(safe));
    setTransformRequestId((id) => id + 1);
  };

  const fmtMm = (metersLike: number) => {
    // 约定默认单位为 mm：目前 PointCloudPreview3D 里返回的 bounds 数值大多是“米量级”
    const mm = metersLike * 1000;
    if (!Number.isFinite(mm)) return '';
    // 1 位小数，不显示 .0
    return String(Math.round(mm * 10) / 10).replace(/\.0$/, '');
  };

  const computeDimsMmFor = (meshUrl: string, scaleMul: number) => {
    const base = meshBaseByUrl[meshUrl] || null;
    const fallback = meshInScene?.url === meshUrl ? meshBounds : null;
    const originalSize = base?.originalSize || fallback?.originalSize || null;
    if (!originalSize) return null;
    // 注意：入库保存“原始 bounding（未乘 scale）” + “scale 倍率（相对 fitScale）”
    const s = Math.max(1e-6, scaleMul || 1);
    return {
      x: originalSize.x * 1000,
      y: originalSize.y * 1000,
      z: originalSize.z * 1000,
      scale: s,
    };
  };

  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true); // 默认开启自动保存

  const handleSelectMeshByUrl = useCallback((meshUrl: string | null) => {
    if (!meshUrl) {
      setMeshInScene(null);
      return;
    }
    const hit = meshesInScene.find((m) => m.url === meshUrl) || null;
    if (hit) {
      setMeshInScene(hit);
      const t = meshTransformsByUrl[hit.url];
      if (t) {
        setTransformValues(t);
        setScaleDraft(String(t.scale.x));
        setTransformRequestId((id) => id + 1);
      }
    }
  }, [meshesInScene, meshTransformsByUrl]);

  const handleSavePose9D = async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    const list = (meshesInScene || []).filter(Boolean);
    if (list.length === 0) {
      if (!silent) alert('请先加载 Mesh（先在下方缩略图中点击一个 Mesh，使其被选中）');
      return;
    }

    const pid = projectId ?? 'unknown';
    const imgId = currentImage.id;

    // 按“图片维度”保存：把场景里所有 mesh 的 9D Pose 都入库
    await Promise.all(
      list.map(async (m) => {
        const t = meshTransformsByUrl[m.url] || (meshInScene?.url === m.url ? transformValues : null);
        const scaleMul = t?.scale?.x ?? 1;
        const dims = computeDimsMmFor(m.url, scaleMul);

        const payload = {
          format: 'pose9d',
          version: 1,
          projectId: projectId ?? null,
          imageId: currentImage.id,
          mesh: {
            id: (m as any)?.id ?? null,
            filename: m.filename,
            originalName: m.originalName,
            url: m.url,
          },
          pose: {
            position: t?.position ?? { x: 0, y: 0, z: 0 },
            rotationDeg: t?.rotationDeg ?? { x: 0, y: 0, z: 0 },
            scale: dims?.scale ?? Math.max(1e-6, scaleMul || 1),
          },
          dimensionsMm: dims ? { x: dims.x, y: dims.y, z: dims.z } : null,
          savedAt: new Date().toISOString(),
        };

        const mid = (m as any)?.id ?? 'unknown';
        const poseStorageKey = `pose9d:${pid}:${imgId}:${mid}`;
        localStorage.setItem(poseStorageKey, JSON.stringify(payload));

        try {
          await pose9dApi.savePose9D(currentImage.id, {
            meshId: (m as any)?.id ?? null,
            pose9d: payload,
          });
        } catch (e: any) {
          console.warn('[PoseManualAnnotation] 9D Pose 入库失败（已写入本地）:', { meshId: (m as any)?.id, e });
        }
      }),
    );
  };

  const clearPose9D = () => {
    console.log('[PoseManualAnnotation] clearPose9D: imageId =', currentImage.id, 'meshInScene =', meshInScene);
    const pid = projectId ?? 'unknown';
    const imgId = currentImage.id;
    const mid = (meshInScene as any)?.id ?? 'unknown';
    const poseStorageKey = `pose9d:${pid}:${imgId}:${mid}`;
    localStorage.removeItem(poseStorageKey);
    (async () => {
      try {
        await pose9dApi.deletePose9D(currentImage.id, (meshInScene as any)?.id ?? null);
      } catch (e) {
        console.warn('[PoseManualAnnotation] 删除后端 9D Pose 失败（已删除本地）:', e);
      }
    })();
    setMeshInScene(null);
    setMeshesInScene((prev) => prev.filter((m) => m.id !== (meshInScene as any)?.id));
    setMeshBounds(null);
    setTransformValues({
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    setScaleDraft('1');
    setTransformRequestId((id) => id + 1);
  };

  // 键盘 Delete 删除当前 Mesh（并清空 9D Pose）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete') return;
      // 避免输入框聚焦时误删
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (!showPointCloudLayer) return;
      if (!meshInScene) return;
      console.log('[PoseManualAnnotation] Delete key pressed, clearing current Mesh pose. imageId =', currentImage.id, 'meshId =', (meshInScene as any)?.id);
      event.preventDefault();
      clearPose9D();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showPointCloudLayer, meshInScene, projectId, currentImage?.id]);

  // 自动保存：当开启自动保存且 mesh/transform 变化时，静默保存 9D Pose
  useEffect(() => {
    if (!autoSaveEnabled) return;
    if (!meshInScene) return;
    if (!showPointCloudLayer) return;
    // 避免初始还没加载完 bounds 时空保存
    if (!meshBounds) return;
    if (isSwitchingImageRef.current) return;
    handleSavePose9D();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSaveEnabled, meshInScene, transformValues.position, transformValues.rotationDeg, transformValues.scale, meshBounds, showPointCloudLayer]);

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

                {/* 2D Mask 只读 Overlay：overlay 不强制依赖 RGB 开关（RGB 关掉时也可单独显示 mask） */}
                {showMaskLayer && maskOverlayData && maskOverlayData.length > 0 && (
                  <svg
                    style={{
                      position: 'absolute',
                      inset: 0,
                      margin: 'auto',
                      pointerEvents: 'none',
                    }}
                    width={currentImage.width || 1280}
                    height={currentImage.height || 720}
                    viewBox={`0 0 ${currentImage.width || 1280} ${currentImage.height || 720}`}
                  >
                    {maskOverlayData.map((m) => {
                      if (!m.points || m.points.length < 6) return null;
                      // SVG polygon points format: "x,y x,y ..." (NOT "x y x y")
                      const d = m.points
                        .reduce<string[]>((acc, _v, idx, arr) => {
                          if (idx % 2 !== 0) return acc;
                          const x = Number(arr[idx]);
                          const y = Number(arr[idx + 1]);
                          if (!Number.isFinite(x) || !Number.isFinite(y)) return acc;
                          acc.push(`${x},${y}`);
                          return acc;
                        }, [])
                        .join(' ');
                      const color = m.color || '#22c55e';
                      const opacity = typeof m.opacity === 'number' ? m.opacity : 0.35;
                      return (
                        <polygon
                          key={m.id}
                          points={d}
                          fill={color}
                          fillOpacity={opacity}
                          stroke={color}
                          strokeWidth={1}
                        />
                      );
                    })}
                  </svg>
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
                          meshes={meshesInScene}
                          selectedMesh={meshInScene}
                          meshTransformsByUrl={meshTransformsByUrl}
                          onSelectMeshUrl={handleSelectMeshByUrl}
                          onMeshBaseInfo={(meshUrl, base) => {
                            setMeshBaseByUrl((prev) => {
                              const cur = prev[meshUrl];
                              if (
                                cur &&
                                cur.fitScale === base.fitScale &&
                                cur.originalSize.x === base.originalSize.x &&
                                cur.originalSize.y === base.originalSize.y &&
                                cur.originalSize.z === base.originalSize.z
                              ) {
                                return prev;
                              }
                              return { ...prev, [meshUrl]: base };
                            });
                          }}
                          transformMode={transformMode}
                          onTransformModeChange={setTransformMode}
                          onTransformValuesChange={(meshUrl, vals) => {
                            // 关键：用 meshUrl 定位要写回的对象，避免快速切换选中时把 A 的 transform 写到 B 上导致“重叠/复位”
                            if (meshInScene?.url === meshUrl) {
                              const same =
                                vals.position.x === transformValues.position.x &&
                                vals.position.y === transformValues.position.y &&
                                vals.position.z === transformValues.position.z &&
                                vals.rotationDeg.x === transformValues.rotationDeg.x &&
                                vals.rotationDeg.y === transformValues.rotationDeg.y &&
                                vals.rotationDeg.z === transformValues.rotationDeg.z &&
                                vals.scale.x === transformValues.scale.x &&
                                vals.scale.y === transformValues.scale.y &&
                                vals.scale.z === transformValues.scale.z;
                              if (!same) setTransformValues(vals);
                            }

                            const cur = meshTransformsByUrl[meshUrl];
                            const sameMesh =
                              cur &&
                              cur.position.x === vals.position.x &&
                              cur.position.y === vals.position.y &&
                              cur.position.z === vals.position.z &&
                              cur.rotationDeg.x === vals.rotationDeg.x &&
                              cur.rotationDeg.y === vals.rotationDeg.y &&
                              cur.rotationDeg.z === vals.rotationDeg.z &&
                              cur.scale.x === vals.scale.x &&
                              cur.scale.y === vals.scale.y &&
                              cur.scale.z === vals.scale.z;
                            if (!sameMesh) {
                              setMeshTransformsByUrl((prev) => ({ ...prev, [meshUrl]: vals }));
                            }
                          }}
                          onMeshBoundsChange={(info) => {
                            setMeshBounds(info);
                          }}
                          transformRequest={{
                            id: transformRequestId,
                            meshUrl: meshInScene?.url || '',
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

                    <div style={{ fontSize: '0.8rem', color: '#6c757d', marginTop: '0.15rem' }}>Scale</div>
                    <input
                      type="number"
                      step="0.01"
                      value={scaleDraft}
                      onChange={(e) => {
                        setIsEditingScale(true);
                        setScaleDraft(e.target.value);
                      }}
                      onFocus={() => setIsEditingScale(true)}
                      onBlur={() => {
                        applyScaleDraft();
                        setIsEditingScale(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyScaleDraft();
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 8, border: '1px solid #d0d7e2' }}
                      title="Scale（整体等比缩放）"
                    />

                    {/* 尺寸（mm）放在最下面一行 */}
                    <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: '0.4rem', alignItems: 'center' }}>
                      <div style={{ fontSize: '0.8rem', color: '#6c757d', textAlign: 'left', justifySelf: 'start' }}>尺寸（mm）</div>
                    <input
                        type="text"
                        readOnly
                        value={meshBounds ? fmtMm(meshBounds.originalSize.x * Math.max(1e-6, transformValues.scale.x || 1)) : ''}
                        placeholder="长 (X)"
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.5rem',
                          borderRadius: 8,
                          border: '1px solid #d0d7e2',
                          background: '#f8fafc',
                          color: '#111',
                        }}
                        title="长（X，mm）"
                      />
                      <input
                        type="text"
                        readOnly
                        value={meshBounds ? fmtMm(meshBounds.originalSize.y * Math.max(1e-6, transformValues.scale.x || 1)) : ''}
                        placeholder="宽 (Y)"
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.5rem',
                          borderRadius: 8,
                          border: '1px solid #d0d7e2',
                          background: '#f8fafc',
                          color: '#111',
                        }}
                        title="宽（Y，mm）"
                    />
                    <input
                        type="text"
                        readOnly
                        value={meshBounds ? fmtMm(meshBounds.originalSize.z * Math.max(1e-6, transformValues.scale.x || 1)) : ''}
                        placeholder="高 (Z)"
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.5rem',
                          borderRadius: 8,
                          border: '1px solid #d0d7e2',
                          background: '#f8fafc',
                          color: '#111',
                        }}
                        title="高（Z，mm）"
                    />
                    </div>
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
                    // 开任一 2D 图层时，关闭点云
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
                    setShowRgbLayer(next);
                  }}
                  title="RGB 图层"
                >
                  <span>RGB 图层</span>
                  <span className="layer-visible">{showRgbLayer ? '👁️' : '🚫'}</span>
                </div>

                {/* Mask 图层（占位 + Overlay 显示 2D Mask） */}
                <div
                  className={`layer-item ${showMaskLayer ? 'active' : ''}`}
                  onClick={() => {
                    const next = !showMaskLayer;
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
                    setShowMaskLayer(next);
                    if (next) {
                      // 打开 Mask 图层时，从 2D 标注接口获取当前图片的 Mask / BBox 概览
                      (async () => {
                        const reqId = ++maskFetchReqIdRef.current;
                        try {
                          const resp = await annotationApi.getAnnotation(currentImage.id);
                          const anno = resp?.annotation;
                          const masks = anno?.masks || [];
                          if (reqId !== maskFetchReqIdRef.current) return;
                          setMaskOverlayData(masks);
                        } catch (e) {
                          if (reqId !== maskFetchReqIdRef.current) return;
                          console.warn('[PoseManualAnnotation] 加载 2D Mask 标注失败:', e);
                          setMaskOverlayData(null);
                        }
                      })();
                    }
                  }}
                  title="Mask 图层（占位）"
                >
                  <span>Mask 图层</span>
                  <span className="layer-visible">{showMaskLayer ? '👁️' : '🚫'}</span>
                </div>

                {/* 深度图层 */}
                <div
                  className={`layer-item ${showDepthLayer ? 'active' : ''}`}
                  onClick={async () => {
                    const next = !showDepthLayer;
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
                    setShowDepthLayer(next);
                    if (next) {
                      try {
                        if (!projectId) {
                          alert('当前未找到项目信息，无法加载深度列表');
                          return;
                        }
                        const reqId = ++depthFetchReqIdRef.current;
                        const list = await depthApi.getDepth(projectId, currentImage.id);
                        if (reqId !== depthFetchReqIdRef.current) return;
                        setDepthList(list);
                        if (list.length > 0) {
                          const firstPng = list.find(
                            (d) =>
                              d.modality === 'depth_png' ||
                              String(d.originalName || d.filename).toLowerCase().endsWith('.png'),
                          );
                          setSelectedDepthId(Number(((firstPng || list[0]) as any).id));
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

                    // 开启点云时，关闭 RGB / 深度 / Mask（保持两组互斥）
                    if (showRgbLayer) setShowRgbLayer(false);
                    if (showDepthLayer) setShowDepthLayer(false);
                    if (showMaskLayer) setShowMaskLayer(false);

                    try {
                      if (!projectId) {
                        alert('当前未找到项目信息，无法加载深度列表');
                        return;
                      }
                      // 尽量复用已有 depthList；没有则拉取一次
                      const list =
                        depthList.length > 0
                          ? depthList
                          : await (async () => {
                              const reqId = ++depthFetchReqIdRef.current;
                              const fetched = await depthApi.getDepth(projectId, currentImage.id);
                              if (reqId !== depthFetchReqIdRef.current) return [];
                              return fetched;
                            })();
                      if (depthList.length === 0) setDepthList(list);

                      const firstRaw = list.find(
                        (d) =>
                          d.modality === 'depth_raw' ||
                          String(d.originalName || d.filename).toLowerCase().endsWith('.npy'),
                      );
                      if (firstRaw) {
                        setSelectedDepthId(Number((firstRaw as any).id));
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

              {/* Mask 图层摘要文案已移除 */}
            </div>

            {/* 保存（9D Pose） */}
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
                  onClick={async () => {
                    try {
                      await handleSavePose9D({ silent: true });
                      alert('保存成功');
                    } catch (e: any) {
                      console.error('[PoseManualAnnotation] 手动保存失败:', e);
                      alert(e?.message || '保存失败');
                    }
                  }}
                >
                  保存标注（JSON）
                </button>
              </div>
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
                    onClick={async () => {
                      if (!showPointCloudLayer) {
                        alert('请先激活点云图层');
                        return;
                      }
                      console.log('[PoseManualAnnotation] 选中 Mesh 缩略图，准备加载到场景:', {
                        imageId: currentImage.id,
                        meshId: m.id,
                        meshFilename: m.filename,
                      });
                      // 加载到场景（支持多 Mesh）：加入列表并选中
                      setMeshesInScene((prev) => {
                        if (prev.some((x) => x.id === m.id)) return prev;
                        return [m, ...prev];
                      });
                      setMeshInScene(m);

                      // 选中 Mesh 时，尝试恢复该 Mesh 的 9D Pose（后端优先，本地兜底）
                      try {
                        const resp = await pose9dApi.getPose9D(currentImage.id, m.id ?? null);
                        const saved = resp?.pose9d || null;
                        if (saved?.pose) {
                          console.log('[PoseManualAnnotation] 找到该 Mesh 已保存的 9D Pose，将恢复变换:', {
                            imageId: currentImage.id,
                            meshId: m.id,
                            pose: saved.pose,
                          });
                          const s = Number(saved.pose.scale) || 1;
                          const next = {
                            position: saved.pose.position || { x: 0, y: 0, z: 0 },
                            rotationDeg: saved.pose.rotationDeg || { x: 0, y: 0, z: 0 },
                            scale: { x: s, y: s, z: s },
                          };
                          setTransformValues(next);
                          setScaleDraft(String(next.scale.x));
                          setTransformRequestId((id) => id + 1);
                          setMeshTransformsByUrl((prev) => ({ ...prev, [m.url]: next }));
                        }
                        if (!saved?.pose) {
                          console.log('[PoseManualAnnotation] 该 Mesh 暂无已保存的 9D Pose，将使用默认 Transform', {
                            imageId: currentImage.id,
                            meshId: m.id,
                          });
                        }
                      } catch (e) {
                        console.warn('[PoseManualAnnotation] 加载 Mesh 对应的 9D Pose 失败，将使用默认 Transform:', e);
                      }

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

