import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { Image, Mask } from '../types';
import { setCurrentImage } from '../store/annotationSlice';
import { authApi, depthApi, meshApi, pose9dApi, annotationApi } from '../services/api';
import { getStoredCurrentProject } from '../tabStorage';
import { toAbsoluteUrl } from '../utils/urls';
import './ManualAnnotation.css';
import PointCloudPreview3D from './PointCloudPreview3D';
import InitialPoseFitOverlay from './InitialPoseFitOverlay';
import { getDiffDopeOverlay, makeDiffDopeOverlayKey } from '../diffdopeOverlayCache';
import { popPoseAutoOpen3D, setPoseAutoOpen3D } from '../poseAutoOpen3D';

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

type IntrinsicsJson = {
  width?: number;
  height?: number;
  fx?: number;
  fy?: number;
  // Principal point: some exporters use ppx/ppy, others use cx/cy.
  ppx?: number;
  ppy?: number;
  cx?: number;
  cy?: number;
  depth_scale?: number;
  depthScale?: number;
  depthscale?: number;
};

const PoseManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images } = useSelector((state: any) => state.annotation);
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
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate');
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
  const [transformRequestId, setTransformRequestId] = useState(0);

  // 右侧图层：
  // - RGB / 深度 / Mask：作为一组“2D Overlay”，组内可以叠加显示（RGB + 深度 + Mask）
  // - 点云图层：与整个 2D 组互斥（开点云 => 关 2D；开任一 2D => 关点云）
  const [showRgbLayer, setShowRgbLayer] = useState(true);
  const [showDepthLayer, setShowDepthLayer] = useState(false);
  const [showMaskLayer, setShowMaskLayer] = useState(false);
  const [showFitLayer, setShowFitLayer] = useState(false);
  const [showPointCloudLayer, setShowPointCloudLayer] = useState(false);
  // Mask 图层摘要文案已移除，因此不再维护 summary state（避免无效渲染/告警）
  // const [maskLayerSummary, setMaskLayerSummary] = useState<{ masks: number; bboxes: number } | null>(null);
  const [maskOverlayData, setMaskOverlayData] = useState<Mask[] | null>(null);
  const [meshFitOverlays, setMeshFitOverlays] = useState<
    Array<{
      meshId: number | null;
      maskId?: string | null;
      maskIndex: number;
      bestIoU: number;
      bestRotationDeg: { x: number; y: number; z: number };
      hullSvgPoints: string;
      label?: string | null;
    }>
  >([]);
  const [diffdopeFitOverlay, setDiffdopeFitOverlay] = useState<{
    meshId: number;
    imageId: number;
    label?: string | null;
    argmin?: number | null;
    pose44?: number[][] | null;
    timingSec?: number | null;
    overlayRgbPngB64?: string;
    overlayDepthPngB64?: string;
    lossPlotPngB64?: string;
    savedAt?: string;
  } | null>(null);
  // mask 拉取防串台：切图很快时，旧请求晚返回会覆盖新图片的 maskOverlay
  const maskFetchReqIdRef = useRef(0);
  const [depthList, setDepthList] = useState<DepthInfo[]>([]);
  const [selectedDepthId, setSelectedDepthId] = useState<number | null>(null);
  const [depthOpacity, setDepthOpacity] = useState(0.45);
  const depthBlendMode: 'normal' = 'normal';
  const [pointStride, setPointStride] = useState(2);
  // depth 拉取防串台：切图很快时，旧请求晚返回会覆盖新图片的 depthList
  const depthFetchReqIdRef = useRef(0);

  // intrinsics（相机内参）缓存：url -> 解析后的参数
  const intrinsicsCacheRef = useRef<
    Map<string, { fx: number; fy: number; cx: number; cy: number; width?: number; height?: number; depthScale?: number }>
  >(new Map());
  const [activeIntrinsics, setActiveIntrinsics] = useState<{
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width?: number;
    height?: number;
    depthScale?: number;
    url?: string;
    key?: string;
  } | null>(null);

  // 保证传给 PointCloudPreview3D 的 intrinsics 引用稳定，否则会触发其重建 three.js 场景（表现为 mesh 闪现后消失）
  const pointCloudIntrinsics = useMemo(() => {
    if (!activeIntrinsics) return undefined;
    return {
      fx: activeIntrinsics.fx,
      fy: activeIntrinsics.fy,
      cx: activeIntrinsics.cx,
      cy: activeIntrinsics.cy,
    };
  }, [activeIntrinsics?.fx, activeIntrinsics?.fy, activeIntrinsics?.cx, activeIntrinsics?.cy]);

  const selectedDepth = useMemo(() => {
    if (!selectedDepthId) return null;
    const sid = Number(selectedDepthId);
    return depthList.find((d) => Number((d as any).id) === sid) || null;
  }, [depthList, selectedDepthId]);

  // 当 selectedDepth 变化时，按 role（left/right/head）自动匹配 intrinsics_*（若存在）
  useEffect(() => {
    const depth = selectedDepth;
    if (!depth) {
      setActiveIntrinsics(null);
      return;
    }

    const role = depth.role || (depth.originalName || depth.filename || '').toLowerCase().includes('head')
      ? 'head'
      : (depth.originalName || depth.filename || '').toLowerCase().includes('left')
      ? 'left'
      : (depth.originalName || depth.filename || '').toLowerCase().includes('right')
      ? 'right'
      : null;

    const intr = depthList.find((d) => {
      const n = String(d.originalName || d.filename || '');
      const isJson = n.toLowerCase().endsWith('.json');
      const isIntr = d.modality === 'intrinsics' || /^intrinsics_/i.test(n);
      if (!isJson || !isIntr) return false;
      if (!role) return false;
      // 角色优先匹配：intrinsics_head.* 对应 role=head
      const r = (d.role || '').toLowerCase();
      if (r === role) return true;
      const nl = n.toLowerCase();
      if (role === 'head' && nl.includes('head')) return true;
      if (role === 'left' && nl.includes('left')) return true;
      if (role === 'right' && nl.includes('right')) return true;
      return false;
    });

    if (!intr?.url) {
      setActiveIntrinsics(null);
      return;
    }

    const intrUrlAbs = toAbsoluteUrl(intr.url) || intr.url;
    const cached = intrinsicsCacheRef.current.get(intrUrlAbs);
    if (cached) {
      setActiveIntrinsics({ ...cached, url: intrUrlAbs });
      return;
    }

    (async () => {
      try {
        const resp = await fetch(intrUrlAbs, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`加载 intrinsics 失败: ${resp.status}`);
        const js = (await resp.json()) as IntrinsicsJson;
        const fx = Number(js.fx);
        const fy = Number(js.fy);
        const cx = Number(js.ppx ?? js.cx);
        const cy = Number(js.ppy ?? js.cy);

        // 仅要求 finite：PointCloudPreview3D 内部也会对 fx/fy/cx/cy 做兜底处理（例如 fx<=0 会回退到 500）
        if (![fx, fy, cx, cy].every((v) => Number.isFinite(v))) {
          const keys = Object.keys(js || {}).slice(0, 20).join(',');
          throw new Error(
            `intrinsics JSON 缺少/非法：fx=${fx}, fy=${fy}, cx=${cx}, cy=${cy}（需要 fx/fy 和 principal point：ppx/ppy 或 cx/cy；keys=${keys}）`,
          );
        }
        const parsed = {
          fx,
          fy,
          cx,
          cy,
          width: js.width != null ? Number(js.width) : undefined,
          height: js.height != null ? Number(js.height) : undefined,
          depthScale: js.depth_scale != null ? Number(js.depth_scale) : js.depthScale != null ? Number(js.depthScale) : js.depthscale != null ? Number(js.depthscale) : undefined,
        };
        intrinsicsCacheRef.current.set(intrUrlAbs, parsed);
        setActiveIntrinsics({ ...parsed, url: intrUrlAbs });
      } catch (e) {
        console.warn('[PoseManualAnnotation] 加载/解析 intrinsics 失败，将回退到默认内参:', e, {
          role,
          intrUrlAbs,
        });
        setActiveIntrinsics(null);
      }
    })();
  }, [depthList, selectedDepth]);

  const projectId = getStoredCurrentProject<any>()?.id;

  // 切图保护：切换图片时临时禁用 auto-save，避免把上一张图的 pose 写进下一张图
  const isSwitchingImageRef = useRef(false);
  // 键盘左右键切图节流：一秒最多切换两次
  const lastArrowNavAtRef = useRef(0);
  useEffect(() => {
    if (!currentImage?.id) return;
    isSwitchingImageRef.current = true;
    // 切图时先清空深度选择，避免点云/深度叠加仍引用上一张图的 depth
    setSelectedDepthId(null);
    setDepthList([]);
    // 切图时清空 mask overlay 数据（开关状态保留，由后续 effect 自动为新图重新加载）
    setMaskOverlayData(null);
    // 切图时清空 mesh 拟合 overlay（避免叠到下一张）
    setMeshFitOverlays([]);
    // 下一帧再放开（等 state 清空 + 恢复流程跑起来）
    const t = window.setTimeout(() => {
      isSwitchingImageRef.current = false;
    }, 0);
    return () => window.clearTimeout(t);
  }, [currentImage?.id]);

  // 进入页面/切换图片/mesh 时：若开启拟合图层，则尝试从 localStorage 恢复拟合结果（由 PoseAnnotationPage 的“6D姿态推测”写入）
  useEffect(() => {
    if (!showFitLayer) return;
    if (!currentImage?.id) return;
    const pid = projectId ?? 'unknown';
    const explicitMid = (meshInScene as any)?.id ?? null;

    const readDiffDope = (mid: number | string) => {
      // Prefer in-memory cache (avoids localStorage quota issues)
      try {
        const keyMem = makeDiffDopeOverlayKey(pid as any, currentImage.id as any, mid as any);
        const hit = getDiffDopeOverlay(keyMem);
        if (hit?.debugImages?.overlayRgbPngB64) {
          return {
            meshId: Number(mid),
            imageId: Number(currentImage.id),
            label: hit?.label ?? null,
            argmin: hit?.argmin ?? null,
            pose44: hit?.pose44 ?? null,
            timingSec: hit?.timingSec ?? null,
            overlayRgbPngB64: hit?.debugImages?.overlayRgbPngB64 ?? '',
            overlayDepthPngB64: hit?.debugImages?.overlayDepthPngB64 ?? '',
            lossPlotPngB64: hit?.debugImages?.lossPlotPngB64 ?? '',
            savedAt: hit?.savedAt ?? null,
          };
        }
      } catch (_) {}

      const key = `diffdope:${pid}:${currentImage.id}:${mid}`;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const js = JSON.parse(raw);
        const dbg = js?.debugImages || {};
        const overlayRgb = typeof dbg?.overlayRgbPngB64 === 'string' ? dbg.overlayRgbPngB64 : '';
        if (!overlayRgb) return null;
        return {
          meshId: Number(mid),
          imageId: Number(currentImage.id),
          label: js?.label ?? null,
          argmin: js?.argmin ?? null,
          pose44: js?.pose44 ?? null,
          timingSec: js?.timingSec ?? null,
          overlayRgbPngB64: overlayRgb,
          overlayDepthPngB64: typeof dbg?.overlayDepthPngB64 === 'string' ? dbg.overlayDepthPngB64 : '',
          lossPlotPngB64: typeof dbg?.lossPlotPngB64 === 'string' ? dbg.lossPlotPngB64 : '',
          savedAt: js?.savedAt ?? null,
        };
      } catch (e) {
        console.warn('[PoseManualAnnotation] 解析 diffdope localStorage 失败:', e);
        return null;
      }
    };

    const readAllPoseFits = (): Array<any> => {
      const prefix = `posefit:${pid}:${currentImage.id}:`;
      const out: Array<any> = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith(prefix)) continue;
          const midStr = k.slice(prefix.length);
          if (!midStr) continue;
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const js = JSON.parse(raw);
          if (!js?.hullSvgPoints) continue;
          out.push({
            meshId: Number(midStr),
            maskId: js.maskId ?? null,
            maskIndex: Number(js.maskIndex ?? 0),
            bestIoU: Number(js.bestIoU ?? 0),
            bestRotationDeg: {
              x: Number(js.bestRotationDeg?.x ?? 0),
              y: Number(js.bestRotationDeg?.y ?? 0),
              z: Number(js.bestRotationDeg?.z ?? 0),
            },
            hullSvgPoints: String(js.hullSvgPoints),
            label: js?.label ?? null,
          });
        }
        return out;
      } catch (e) {
        console.warn('[PoseManualAnnotation] 扫描 posefit localStorage 失败:', e);
        return [];
      }
    };

    // Diff-DOPE：当前仍只显示“一个”（取选中 mesh；否则取第一条）
    if (explicitMid != null) {
      const dd = readDiffDope(explicitMid);
      setDiffdopeFitOverlay(dd || null);
    } else {
      try {
        const ddPrefix = `diffdope:${pid}:${currentImage.id}:`;
        let ddBest: any = null;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith(ddPrefix)) continue;
          const midStr = k.slice(ddPrefix.length);
          if (!midStr) continue;
          const one = readDiffDope(midStr);
          if (one) {
            ddBest = one;
            break;
          }
        }
        setDiffdopeFitOverlay(ddBest);
      } catch (e) {
        console.warn('[PoseManualAnnotation] 扫描 diffdope localStorage 失败:', e);
        setDiffdopeFitOverlay(null);
      }
    }

    // 拟合图层：显示所有 posefit（来自 localStorage）
    const all = readAllPoseFits();
    if (explicitMid != null) {
      all.sort((a, b) => {
        const aa = Number(a?.meshId ?? -1) === Number(explicitMid) ? 0 : 1;
        const bb = Number(b?.meshId ?? -1) === Number(explicitMid) ? 0 : 1;
        return aa - bb;
      });
    }
    setMeshFitOverlays(all);
  }, [showFitLayer, currentImage?.id, (meshInScene as any)?.id, projectId]);


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
          if (!row) return null;

          // 后端目前把完整 payload 存在 pose_json 里，这里需要自己解析
          let raw: any = row.pose ?? row.pose_json ?? row.poseJson;
          if (!raw) return null;

          try {
            if (typeof raw === 'string') {
              raw = JSON.parse(raw);
            }
          } catch (e) {
            return null;
          }

          // 兼容两种结构：
          // 1) 顶层就是 { positionMm, rotationDeg, scale, ... }
          // 2) 顶层是 { format, version, projectId, imageId, mesh, pose: { ... } }
          const poseContainer = raw?.pose && raw?.mesh ? raw.pose : raw;

          if (!poseContainer) return null;

          const position = poseContainer.position ?? poseContainer.positionMm ?? null;
          const rotationDeg = poseContainer.rotationDeg ?? null;
          const scaleNumber = poseContainer.scale;

          if (!position || !rotationDeg) return null;

          const s = Number(scaleNumber);
          const safeScale = Number.isFinite(s) && s > 0 ? s : 1;

          // 点云/编辑器统一使用“毫米(mm)”展示与编辑：
          // - 若后端存的是 positionMm：直接用
          // - 若后端存的是 position(米)：转成 mm
          const isMm = !poseContainer.position && !!poseContainer.positionMm;
          const toMm = (v: any) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return 0;
            return isMm ? n : n * 1000;
          };

          const t = {
            position: { x: toMm(position.x), y: toMm(position.y), z: toMm(position.z) },
            rotationDeg: {
              x: rotationDeg.x ?? 0,
              y: rotationDeg.y ?? 0,
              z: rotationDeg.z ?? 0,
            },
            scale: { x: safeScale, y: safeScale, z: safeScale },
          };

          return t;
        };
        toLoad.forEach((m) => {
          const row = poses.find((r) => Number(r.mesh_id) === Number(m.id));
          const t = extractPose(row);
          if (t) {
            nextTransforms[m.url] = t;
          }
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
          setTransformRequestId((id) => id + 1);
        } else {
          setTransformValues({
            position: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          });
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

        const mmToM = (v: any) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return 0;
          return n * 0.001;
        };

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
            // 点云/编辑器统一用毫米；为兼容历史解析，这里同时写入 position(米) 与 positionMm(毫米)
            position: t?.position ? { x: mmToM(t.position.x), y: mmToM(t.position.y), z: mmToM(t.position.z) } : { x: 0, y: 0, z: 0 },
            positionMm: t?.position ?? { x: 0, y: 0, z: 0 },
            rotationDeg: t?.rotationDeg ?? { x: 0, y: 0, z: 0 },
            // Scale is not adjustable in UI; keep 1.0 for now.
            scale: 1,
          },
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

  // When entering from PoseAnnotationPage (after "确定初始位姿" or "6D姿态推测"),
  // auto-open the PointCloudPreview3D canvas so the user can see the mesh in 3D space.
  useEffect(() => {
    if (!currentImage?.id) return;
    if (!projectId) return;
    const flag = popPoseAutoOpen3D();
    if (!flag) return;
    if (Number(flag.projectId) !== Number(projectId)) return;
    if (Number(flag.imageId) !== Number(currentImage.id)) return;

    // Re-store the flag until we actually managed to open point cloud,
    // otherwise a missing depth_raw/intrinsics would lose the user's intent.
    setPoseAutoOpen3D(flag);

    (async () => {
      try {
        const list = await depthApi.getDepth(projectId, currentImage.id);
        setDepthList(list);
        const firstRaw =
          list.find((d) => d.modality === 'depth_raw' || String(d.originalName || d.filename).toLowerCase().endsWith('.npy')) ||
          null;
        if (!firstRaw) return; // keep flag for later; user may upload depth_raw then re-enter

        setSelectedDepthId(Number((firstRaw as any).id));
        if (showRgbLayer) setShowRgbLayer(false);
        if (showDepthLayer) setShowDepthLayer(false);
        if (showMaskLayer) setShowMaskLayer(false);
        if (showFitLayer) setShowFitLayer(false);
        setShowPointCloudLayer(true);
      } catch (e) {
        console.warn('[PoseManualAnnotation] auto-open point cloud failed:', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImage?.id, projectId]);

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

  // 键盘 ← / → 切换图片（节流：500ms）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // 避免输入框聚焦时误触
      const t = event.target as any;
      const tag = (t?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;

      const now = Date.now();
      if (now - lastArrowNavAtRef.current < 500) return;
      lastArrowNavAtRef.current = now;

      event.preventDefault();
      handleNavigateImage(event.key === 'ArrowLeft' ? 'prev' : 'next');
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeyDown as any);
  }, [handleNavigateImage]);

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
          <div className="tool-section" style={{ display: 'flex', alignItems: 'center' }} />
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
                    style={{ position: 'absolute', inset: 0, margin: 'auto', zIndex: 10 }}
                  />
                )}

                {/* Diff-DOPE 可视化 Overlay：渲染结果叠到原图上（用于验收 6D 姿态是否对齐） */}
                {showFitLayer && diffdopeFitOverlay?.overlayRgbPngB64 && (
                  <img
                    src={`data:image/png;base64,${diffdopeFitOverlay.overlayRgbPngB64}`}
                    alt="diffdope overlay"
                    className="annotation-image"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      margin: 'auto',
                      zIndex: 28,
                      opacity: 0.95,
                      pointerEvents: 'none',
                    }}
                  />
                )}

                {/* Mesh 拟合结果 Overlay（server 返回的 hull，多边形近似 mesh 投影轮廓） */}
                {showFitLayer && meshFitOverlays.length > 0 && (
                  <svg
                    style={{
                      position: 'absolute',
                      inset: 0,
                      margin: 'auto',
                      pointerEvents: 'none',
                      zIndex: 30,
                      width: '100%',
                      height: '100%',
                    }}
                    viewBox={`0 0 ${currentImage.width || 1280} ${currentImage.height || 720}`}
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {meshFitOverlays.map((o, idx) => (
                      <polygon
                        // eslint-disable-next-line react/no-array-index-key
                        key={`${o.meshId ?? 'unknown'}-${idx}`}
                        points={o.hullSvgPoints}
                        fill="#60a5fa"
                        fillOpacity={0.22}
                        stroke="#60a5fa"
                        strokeWidth={2}
                      />
                    ))}
                  </svg>
                )}

                <InitialPoseFitOverlay
                  enabled={showFitLayer}
                  suppress={!!diffdopeFitOverlay?.overlayRgbPngB64 || meshFitOverlays.length > 0}
                  projectId={projectId}
                  image={currentImage ? { id: currentImage.id, width: currentImage.width, height: currentImage.height } : null}
                  selectedMeshId={Number((meshInScene as any)?.id ?? 0) || null}
                  activeIntrinsics={
                    activeIntrinsics
                      ? { fx: activeIntrinsics.fx, fy: activeIntrinsics.fy, cx: activeIntrinsics.cx, cy: activeIntrinsics.cy }
                      : null
                  }
                />

                {/* Diff-DOPE 文本信息（左上角） */}
                {showFitLayer && diffdopeFitOverlay?.overlayRgbPngB64 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 10,
                      zIndex: 31,
                      padding: '0.35rem 0.55rem',
                      borderRadius: 10,
                      background: 'rgba(15,23,42,0.55)',
                      border: '1px solid rgba(148,163,184,0.25)',
                      color: '#e2e8f0',
                      fontSize: '0.82rem',
                      pointerEvents: 'none',
                      backdropFilter: 'blur(6px)',
                      maxWidth: 520,
                      lineHeight: 1.25,
                    }}
                  >
                    {`Diff-DOPE: meshId=${diffdopeFitOverlay.meshId}${
                      diffdopeFitOverlay.label ? ` label=${diffdopeFitOverlay.label}` : ''
                    }${diffdopeFitOverlay.argmin != null ? ` argmin=${diffdopeFitOverlay.argmin}` : ''}${
                      typeof diffdopeFitOverlay.timingSec === 'number' ? ` time=${diffdopeFitOverlay.timingSec.toFixed(2)}s` : ''
                    }`}
                  </div>
                )}

                {/* 2D Mask 只读 Overlay：overlay 不强制依赖 RGB 开关（RGB 关掉时也可单独显示 mask） */}
                {showMaskLayer && maskOverlayData && maskOverlayData.length > 0 && (
                  <svg
                    style={{
                      position: 'absolute',
                      inset: 0,
                      margin: 'auto',
                      pointerEvents: 'none',
                      zIndex: 40,
                      width: '100%',
                      height: '100%',
                    }}
                    viewBox={`0 0 ${currentImage.width || 1280} ${currentImage.height || 720}`}
                    preserveAspectRatio="xMidYMid meet"
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
                        zIndex: 20,
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
                      zIndex: 20,
                    }}
                  >
                    已选择深度原始数据（.npy），当前版本暂不支持直接可视化预览。
                  </div>
                )}

                {showPointCloudLayer && (
                  <div style={{ position: 'absolute', inset: 0 }}>
                    {selectedDepth && selectedDepth.modality === 'depth_raw' ? (
                      activeIntrinsics ? (
                        <>
                          <PointCloudPreview3D
                            npyUrl={toAbsoluteUrl(selectedDepth.url) || null}
                            // depth_raw 的单位换算：若 intrinsics_*.json 提供 depth_scale，则按其换算
                            // 典型：深度是“毫米单位整数”，depth_scale=0.001 => 转成米
                            // 点云场景统一使用“毫米(mm)”作为长度单位（更符合深度原始数据的直觉）
                            // depthScale 仍按“米/单位”传入，PointCloudPreview3D 内部会在 unit=mm 时再乘 1000
                            depthScale={typeof activeIntrinsics?.depthScale === 'number' && Number.isFinite(activeIntrinsics.depthScale) && activeIntrinsics.depthScale > 0 ? activeIntrinsics.depthScale : 0.001}
                            stride={pointStride}
                            intrinsics={pointCloudIntrinsics}
                            unit="mm"
                            meshes={meshesInScene}
                            selectedMesh={meshInScene}
                            meshTransformsByUrl={meshTransformsByUrl}
                            onSelectMeshUrl={handleSelectMeshByUrl}
                            onMeshBaseInfo={(_meshUrl, _base) => {
                              // dimensions/scale are not adjustable in UI; base info is unused for now
                            }}
                            transformMode={transformMode}
                            onTransformModeChange={setTransformMode}
                            onTransformValuesChange={(meshUrl, vals) => {
                            const nextVals = vals;

                            // 关键：用 meshUrl 定位要写回的对象，避免快速切换选中时把 A 的 transform 写到 B 上导致“重叠/复位”
                            if (meshInScene?.url === meshUrl) {
                              const same =
                                nextVals.position.x === transformValues.position.x &&
                                nextVals.position.y === transformValues.position.y &&
                                nextVals.position.z === transformValues.position.z &&
                                nextVals.rotationDeg.x === transformValues.rotationDeg.x &&
                                nextVals.rotationDeg.y === transformValues.rotationDeg.y &&
                                nextVals.rotationDeg.z === transformValues.rotationDeg.z &&
                                nextVals.scale.x === transformValues.scale.x &&
                                nextVals.scale.y === transformValues.scale.y &&
                                nextVals.scale.z === transformValues.scale.z;
                              if (!same) setTransformValues(nextVals);
                            }

                            const cur = meshTransformsByUrl[meshUrl];
                            const sameMesh =
                              cur &&
                              cur.position.x === nextVals.position.x &&
                              cur.position.y === nextVals.position.y &&
                              cur.position.z === nextVals.position.z &&
                              cur.rotationDeg.x === nextVals.rotationDeg.x &&
                              cur.rotationDeg.y === nextVals.rotationDeg.y &&
                              cur.rotationDeg.z === nextVals.rotationDeg.z &&
                              cur.scale.x === nextVals.scale.x &&
                              cur.scale.y === nextVals.scale.y &&
                              cur.scale.z === nextVals.scale.z;
                            if (!sameMesh) {
                              setMeshTransformsByUrl((prev) => ({ ...prev, [meshUrl]: nextVals }));
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
                            color: '#d97706',
                            fontSize: '0.9rem',
                            pointerEvents: 'none',
                            padding: '1rem',
                            textAlign: 'center',
                          }}
                        >
                          当前已选择深度原始数据（depth_raw_*.npy），但未找到对应相机内参
                          intrinsics_*.json（如 intrinsics_head.json）。请先在左上角“深度数据”区域上传相机内参文件。
                        </div>
                      )
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
                </div>
                <div style={{ marginTop: '0.35rem', fontSize: '0.8rem', color: '#6c757d' }}>
                  快捷键：W 移动，E 旋转
                </div>

                {/* Unity Detail 面板：Position / Rotation / Scale */}
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.82rem', color: '#495057', fontWeight: 600, marginBottom: '0.35rem' }}>
                    Transform（数值）
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#6c757d', marginBottom: '0.25rem' }}>Position（mm）</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
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
                          placeholder="X"
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
                          placeholder="Y"
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
                          placeholder="Z"
                        />
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#6c757d', marginBottom: '0.25rem' }}>Rotation</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
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
                          placeholder="X"
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
                          placeholder="Y"
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
                          placeholder="Z"
                        />
                      </div>
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

                {/* 拟合图层：显示后端拟合的 mesh 投影轮廓（来自 localStorage 或后续实时写入） */}
                <div
                  className={`layer-item ${showFitLayer ? 'active' : ''}`}
                  onClick={() => {
                    const next = !showFitLayer;
                    if (next && showPointCloudLayer) {
                      setShowPointCloudLayer(false);
                    }
                    setShowFitLayer(next);
                    if (!next) {
                      setMeshFitOverlays([]);
                    }
                  }}
                  title="拟合图层（Mesh 投影轮廓）"
                >
                  <span>拟合图层</span>
                  <span className="layer-visible">{showFitLayer ? '👁️' : '🚫'}</span>
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

                    // 四个图层视为同一组：点云与 RGB/Depth/Mask 互斥
                    if (!next) {
                      setShowPointCloudLayer(false);
                      return;
                    }

                    try {
                      if (!projectId) {
                        alert('当前未找到项目信息，无法加载点云数据');
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

                      if (!firstRaw) {
                        // 当前图片本身就没有可用于点云的数据：保持点云图层为关闭状态，并给出更友好的提示
                        setShowPointCloudLayer(false);
                        alert('当前图片暂无可用的点云数据（未上传对应的深度/点云文件），暂时无法显示点云视图。');
                        return;
                      }

                      // 有可用的 depth_raw，再真正切换到点云视图，并关闭其他 2D 图层
                      setSelectedDepthId(Number((firstRaw as any).id));
                      if (showRgbLayer) setShowRgbLayer(false);
                      if (showDepthLayer) setShowDepthLayer(false);
                      if (showMaskLayer) setShowMaskLayer(false);
                      if (showFitLayer) setShowFitLayer(false);
                      setShowPointCloudLayer(true);
                    } catch (e) {
                      console.error('[PoseManualAnnotation] 加载深度列表失败（点云）:', e);
                      alert('加载点云数据失败，请稍后重试');
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

                </div>
              )}

              {showPointCloudLayer && (
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.85rem', color: '#495057', fontWeight: 600, marginBottom: '0.35rem' }}>
                    点云参数（临时）
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#6c757d', marginBottom: '0.25rem' }}>
                    stride 越大越省性能；深度单位以 intrinsics_*.json 中的 depth_scale 为准。
                  </div>
                  <div style={{ fontSize: '0.8rem', color: activeIntrinsics ? '#16a34a' : '#d97706', marginBottom: '0.35rem' }}>
                    {activeIntrinsics ? (
                      <>
                        当前相机内参：
                        fx={activeIntrinsics.fx.toFixed(2)}, fy={activeIntrinsics.fy.toFixed(2)}, cx=
                        {activeIntrinsics.cx.toFixed(2)}, cy={activeIntrinsics.cy.toFixed(2)}
                        {typeof activeIntrinsics.depthScale === 'number'
                          ? `，depth_scale=${activeIntrinsics.depthScale}`
                          : ''}
                      </>
                    ) : (
                      <>未检测到对应相机内参（intrinsics_*.json），点云将无法显示。</>
                    )}
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

    </div>
  );
};

export default PoseManualAnnotation;

