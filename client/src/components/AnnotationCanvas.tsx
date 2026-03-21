import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Stage, Layer, Image, Line, Rect, Circle } from 'react-konva';
import useImage from 'use-image';
import type { Mask, BoundingBox, Polygon } from '../types';
import { getStoredCurrentProject } from '../tabStorage';

interface AnnotationCanvasProps {
  imageUrl: string;
  masks: Mask[];
  boundingBoxes: BoundingBox[];
  polygons: Polygon[];
  activeLayer?: 'background' | 'annotation' | 'bbox';
  toolMode: 'select' | 'mask-select' | 'eraser' | 'polygon' | 'bbox';
  brushSize: number;
  onMaskUpdate: (updatedMasks: Mask[]) => void;
  onBoundingBoxUpdate?: (updatedBBoxes: BoundingBox[]) => void;
  onPolygonUpdate: (updatedPolygons: Polygon[]) => void;
}

const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  imageUrl,
  masks,
  boundingBoxes,
  polygons,
  activeLayer = 'annotation',
  toolMode,
  brushSize,
  onMaskUpdate,
  onBoundingBoxUpdate,
  onPolygonUpdate
}) => {
  const [image] = useImage(imageUrl);
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [imageScale, setImageScale] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false); // 新建 Mask 绘制状态
  const [isErasing, setIsErasing] = useState(false); // 橡皮擦状态（整段笔划）
  const [currentPoints, setCurrentPoints] = useState<number[]>([]);
  const [eraserCenter, setEraserCenter] = useState<{ x: number; y: number } | null>(null);
  const [eraserStroke, setEraserStroke] = useState<{ x: number; y: number }[]>([]); // 当前一次擦除笔划（图片坐标系）
  const [selectedPoint, setSelectedPoint] = useState<{ maskId: string; pointIndex: number } | null>(null);
  const [selectedMaskIds, setSelectedMaskIds] = useState<string[]>([]);
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [boxSelectStart, setBoxSelectStart] = useState<{ x: number; y: number } | null>(null);
  const [boxSelectRect, setBoxSelectRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameModalPosition, setRenameModalPosition] = useState<{ x: number; y: number } | null>(null);
  const [renameInputValue, setRenameInputValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [pendingRenameMaskId, setPendingRenameMaskId] = useState<string | null>(null);
  const [renameTargetMaskIds, setRenameTargetMaskIds] = useState<string[]>([]);

  // 基于与“重命名”一致的 IoU 规则，为一组 mask 找到一一对应的 bbox 下标
  const getMatchedBoundingBoxIndicesByMaskIds = (maskIds: string[]): Set<number> => {
    const selectedMaskIdSet = new Set(maskIds);
    const selectedMasks = masks.filter((m) => selectedMaskIdSet.has(m.id));
    const maskBoxById = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
    selectedMasks.forEach((m) => {
      if (!m.points || m.points.length < 2) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < m.points.length; i += 2) {
        const x = Number(m.points[i]);
        const y = Number(m.points[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) return;
      maskBoxById.set(m.id, { x1: minX, y1: minY, x2: maxX, y2: maxY });
    });

    const iou = (a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) => {
      const ix1 = Math.max(a.x1, b.x1);
      const iy1 = Math.max(a.y1, b.y1);
      const ix2 = Math.min(a.x2, b.x2);
      const iy2 = Math.min(a.y2, b.y2);
      const iw = ix2 - ix1;
      const ih = iy2 - iy1;
      if (iw <= 0 || ih <= 0) return 0;
      const inter = iw * ih;
      const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
      const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
      const union = areaA + areaB - inter;
      if (union <= 0) return 0;
      return inter / union;
    };

    const candidates = selectedMasks
      .map((m) => {
        const mb = maskBoxById.get(m.id);
        if (!mb) return null;
        let bestIdx = -1;
        let bestIoU = 0;
        for (let i = 0; i < boundingBoxes.length; i++) {
          const bb = boundingBoxes[i];
          const bbBox = { x1: bb.x, y1: bb.y, x2: bb.x + bb.width, y2: bb.y + bb.height };
          const s = iou(mb, bbBox);
          if (s > bestIoU) {
            bestIoU = s;
            bestIdx = i;
          }
        }
        return { bestIdx, bestIoU };
      })
      .filter(Boolean) as Array<{ bestIdx: number; bestIoU: number }>;

    candidates.sort((a, b) => b.bestIoU - a.bestIoU);

    const usedBboxIdx = new Set<number>();
    const selectedBboxIdx = new Set<number>();
    const MIN_IOU = 0.01;
    for (const c of candidates) {
      if (c.bestIdx < 0) continue;
      if (c.bestIoU < MIN_IOU) continue;
      if (usedBboxIdx.has(c.bestIdx)) continue;
      usedBboxIdx.add(c.bestIdx);
      selectedBboxIdx.add(c.bestIdx);
    }
    return selectedBboxIdx;
  };

  // 键盘快捷键（点编辑模式）：Delete 删除点，I 插入新点
  useEffect(() => {
    if (toolMode !== 'select') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果当前有重命名弹窗在显示，或者焦点在输入框/下拉框中，则不处理全局快捷键
      if (showRenameModal) return;
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

      if (!selectedPoint) return;
      const { maskId, pointIndex } = selectedPoint;

      // 删除当前点
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const updatedMasks = masks.map(mask => {
          if (mask.id !== maskId) return mask;
          if (!mask.points || mask.points.length <= 6) {
            // 至少保留三角形
            return mask;
          }
          const newPoints = [...mask.points];
          // 删除该点的 x,y
          newPoints.splice(pointIndex * 2, 2);
          return {
            ...mask,
            points: newPoints,
          };
        });
        onMaskUpdate(updatedMasks);
        setSelectedPoint(null);
      }

      // 插入新点（在当前点和下一个点之间插值）
      if (e.key === 'i' || e.key === 'I') {
        const updatedMasks = masks.map(mask => {
          if (mask.id !== maskId) return mask;
          const pts = mask.points;
          if (!pts || pts.length < 6) return mask;

          const count = pts.length / 2;
          const currentIdx = pointIndex;
          const nextIdx = (currentIdx + 1) % count;

          const cx = pts[currentIdx * 2];
          const cy = pts[currentIdx * 2 + 1];
          const nx = pts[nextIdx * 2];
          const ny = pts[nextIdx * 2 + 1];

          const mx = (cx + nx) / 2;
          const my = (cy + ny) / 2;

          const newPoints = [...pts];
          newPoints.splice((currentIdx + 1) * 2, 0, mx, my);

          return {
            ...mask,
            points: newPoints,
          };
        });
        onMaskUpdate(updatedMasks);
        // 选中新插入的点（当前点之后）
        setSelectedPoint({ maskId, pointIndex: pointIndex + 1 });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolMode, selectedPoint, masks, onMaskUpdate]);

  // 键盘快捷键（整块 Mask 选择模式）：Delete 删除整块 Mask，R 按项目级 label-color 规则改颜色并改名（支持多选）
  useEffect(() => {
    if (toolMode !== 'mask-select') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 有重命名弹窗时或正在输入时，不再处理 Delete / R 等全局快捷键，避免与输入冲突
      if (showRenameModal) return;
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

      if (!selectedMaskIds || selectedMaskIds.length === 0) return;

      // 删除整块 Mask
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (onBoundingBoxUpdate) {
          const selectedBboxIdx = getMatchedBoundingBoxIndicesByMaskIds(selectedMaskIds);
          if (selectedBboxIdx.size > 0) {
            const updatedBBoxes = boundingBoxes.filter((_, idx) => !selectedBboxIdx.has(idx));
            onBoundingBoxUpdate(updatedBBoxes);
          }
        }
        const updatedMasks = masks.filter(mask => !selectedMaskIds.includes(mask.id));
        onMaskUpdate(updatedMasks);
        setSelectedMaskIds([]);
        return;
      }

      // 更换颜色并修改标签名（对所有选中的 Mask 生效）
      if (e.key === 'r' || e.key === 'R') {
        // 阻止默认输入行为，避免按 R 时字符落到输入框里
        e.preventDefault();
        e.stopPropagation();
        const targets = masks.filter(mask => selectedMaskIds.includes(mask.id));
        if (targets.length === 0) return;

        // 计算第一个选中mask的中心位置（舞台坐标）
        const firstMask = targets[0];
        if (firstMask.points && firstMask.points.length >= 2) {
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;

          for (let i = 0; i < firstMask.points.length; i += 2) {
            const sx = firstMask.points[i] * imageScale;
            const sy = firstMask.points[i + 1] * imageScale;
            if (sx < minX) minX = sx;
            if (sx > maxX) maxX = sx;
            if (sy < minY) minY = sy;
            if (sy > maxY) maxY = sy;
          }

          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;

          // 获取Stage元素的位置，转换为页面坐标
          const stage = stageRef.current?.getStage();
          if (stage) {
            const container = stage.container();
            const rect = container.getBoundingClientRect();
            const pageX = rect.left + centerX;
            const pageY = rect.top + centerY;

            setRenameModalPosition({ x: pageX, y: pageY });
            setRenameInputValue(targets[0].label || '');
            setRenameTargetMaskIds([...selectedMaskIds]);
            setShowRenameModal(true);
          }
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolMode, selectedMaskIds, masks, onMaskUpdate, onBoundingBoxUpdate, boundingBoxes, imageScale]);

  // 处理R键改名弹窗的确认
  const handleRenameConfirm = () => {
    if (!renameTargetMaskIds || renameTargetMaskIds.length === 0) {
      setShowRenameModal(false);
      setRenameTargetMaskIds([]);
      return;
    }

    const targets = masks.filter(mask => renameTargetMaskIds.includes(mask.id));
    if (targets.length === 0) {
      setShowRenameModal(false);
      setRenameTargetMaskIds([]);
      return;
    }

    const trimmed = renameInputValue.trim();

    const COLOR_PALETTE = [
      '#1F77B4', // 亮蓝
      '#FF7F0E', // 橙色
      '#2CA02C', // 绿色
      '#D62728', // 红色
      '#9467BD', // 紫色
      '#8C564B', // 棕色
      '#E377C2', // 粉色
      '#7F7F7F', // 中性灰
      '#17BECF', // 青色
      '#BCBD22', // 橄榄绿
      '#FF9896', // 浅红
      '#98DF8A', // 浅绿
      '#AEC7E8', // 浅蓝
      '#C49C94', // 浅棕
      '#F7B6D2', // 浅粉
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

    // 1. 读取当前标签页的当前项目
    let projectId: number | null = null;
    try {
      const savedProject = getStoredCurrentProject<any>();
      if (savedProject) {
        const p = savedProject;
        if (p && typeof p.id === 'number') {
          projectId = p.id;
        }
      }
    } catch (err) {
      console.warn('[AnnotationCanvas] 解析 currentProject 失败，用默认颜色逻辑', err);
    }

    // label -> color 映射按项目级存储在 localStorage。
    // 注意：这里仅从 localStorage 读取映射，用于决定颜色；
    // 真正的持久化写入放在「保存标注（JSON）」时统一处理，
    // 这样 R 改名产生的“新标签”在未保存前不会污染整个项目的下拉列表。
    const loadProjectLabelColorMap = (pid: number | null): Map<string, string> => {
      const map = new Map<string, string>();
      if (pid) {
      const key = `labelColorMap:${pid}`;
      try {
        const raw = localStorage.getItem(key);
          if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
            Object.entries(obj).forEach(([label, color]) => {
              if (label && color) {
                map.set(label, color);
              }
            });
          }
      } catch (err) {
        console.warn('[AnnotationCanvas] 读取 labelColorMap 失败', err);
        }
      }

      // 额外：从当前图像中已有的 Mask / BBox 补全 label -> color 到内存 map（不回写到 localStorage）
      masks.forEach((mask) => {
        const label = (mask.label || '').trim();
        const color = mask.color;
        if (!label || !color) return;
        if (!map.has(label)) {
          map.set(label, color);
      }
      });

      boundingBoxes.forEach((bbox) => {
        const label = (bbox.label || '').trim();
        const color = bbox.color;
        if (!label || !color) return;
        if (!map.has(label)) {
          map.set(label, color);
        }
      });

      return map;
    };

    const labelColorMap = loadProjectLabelColorMap(projectId);

    // 2. 根据新的 label 决定颜色
    let targetColor: string | undefined;

    if (trimmed.length > 0) {
      // 有新 label：如果项目里已有这个 label，则复用旧颜色；否则分配未使用颜色
      if (labelColorMap.has(trimmed)) {
        targetColor = labelColorMap.get(trimmed)!;
      } else {
        const usedColors = new Set(labelColorMap.values());
        let assigned: string | undefined;
        for (const c of COLOR_PALETTE) {
          if (!usedColors.has(c)) {
            assigned = c;
            break;
          }
        }
        // 调色板都用完了就循环使用
        targetColor = assigned || COLOR_PALETTE[usedColors.size % COLOR_PALETTE.length];

        // 记录新 label 的颜色（仅在当前内存映射中，用于本次会话的颜色分配）
        labelColorMap.set(trimmed, targetColor);
      }
    } else {
      // 没填新 label，仅希望调整颜色：对每个选中 mask 按现有 label 查映射，否则保持原色
      const firstLabel = (targets[0].label || '').trim();
      if (firstLabel && labelColorMap.has(firstLabel)) {
        targetColor = labelColorMap.get(firstLabel)!;
      } else {
        targetColor = targets[0].color || COLOR_PALETTE[0];
      }
    }

    // 3. 先计算要应用到 Mask 的更新结果
    const updatedMasks = masks.map(mask => {
      if (!renameTargetMaskIds.includes(mask.id)) return mask;

      const nextLabel = trimmed.length > 0 ? trimmed : (mask.label || '');

      return {
        ...mask,
        color: targetColor,
        label: nextLabel,
      };
    });

    // 3.1 同步重命名对应的 BoundingBox（如果有 onBoundingBoxUpdate）
    // 关联策略（期望一一对应，且当前数据结构没有显式关联字段）：
    // - 对每个被选中的 mask，计算其几何包围盒（image 坐标系）
    // - 与所有 bbox 计算 IoU，选择 IoU 最大的那个作为“对应 bbox”
    // - 多选时尽量避免多个 mask 指向同一个 bbox（贪心去重）
    if (onBoundingBoxUpdate) {
      const selectedBboxIdx = getMatchedBoundingBoxIndicesByMaskIds(renameTargetMaskIds);
      if (selectedBboxIdx.size > 0) {
        const updatedBBoxes = boundingBoxes.map((bb, idx) => {
          if (!selectedBboxIdx.has(idx)) return bb;
          return {
            ...bb,
            label: trimmed.length > 0 ? trimmed : bb.label,
            color: targetColor,
          };
        });
        onBoundingBoxUpdate(updatedBBoxes);
      }

      // 注意：这里不再做“相交就全部更新”，确保一一对应
      // （若用户确实需要严格绑定关系，建议后续在数据结构里加入 maskId/bboxId 显式关联字段）
    }

    // 4. 仅更新画布当前状态（不在这里做项目级 label 映射持久化）
    onMaskUpdate(updatedMasks);
    setShowRenameModal(false);
    setRenameModalPosition(null);
    setRenameTargetMaskIds([]);
  };

  // 处理R键改名弹窗的取消
  const handleRenameCancel = () => {
    setShowRenameModal(false);
    setRenameModalPosition(null);
    setRenameTargetMaskIds([]);
  };

  // 弹窗打开时自动聚焦输入框
  useEffect(() => {
    if (showRenameModal && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [showRenameModal]);

  // 处理ESC键关闭弹窗
  useEffect(() => {
    if (!showRenameModal) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowRenameModal(false);
        setRenameModalPosition(null);
      } else if (e.key === 'Enter') {
        handleRenameConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showRenameModal, renameInputValue, renameTargetMaskIds, masks, onMaskUpdate]);

  // 切换到其他工具时，清空整块选中状态
  useEffect(() => {
    if (toolMode !== 'mask-select' && selectedMaskIds.length > 0) {
      setSelectedMaskIds([]);
    }
  }, [toolMode, selectedMaskIds]);

  // 图片切换时，重置所有交互状态和缩放
  useEffect(() => {
    // 先重置 imageScale，避免使用旧图片的缩放值
    setImageScale(1);
    setStageSize({ width: 800, height: 600 });
    
    setSelectedMaskIds([]);
    setSelectedPoint(null);
    setIsBoxSelecting(false);
    setBoxSelectRect(null);
    setBoxSelectStart(null);
    setIsErasing(false);
    setEraserCenter(null);
    setEraserStroke([]);
    setIsDrawing(false);
    setCurrentPoints([]);
    setPendingRenameMaskId(null);
    setShowRenameModal(false);
    setRenameModalPosition(null);
    setRenameTargetMaskIds([]);
  }, [imageUrl]);

  // “新建 Mask”闭合结束后：等待父组件把 masks 更新进来，再自动弹出重命名小弹窗
  useEffect(() => {
    if (!pendingRenameMaskId) return;
    const target = masks.find(m => m.id === pendingRenameMaskId);
    if (!target) return;

    // 自动选中新建的 mask，复用“选择工具”的 R 键弹窗逻辑
    setSelectedMaskIds([pendingRenameMaskId]);
    setRenameInputValue(target.label || '');
    setRenameTargetMaskIds([pendingRenameMaskId]);

    // 如果位置没有算出来（兜底），用 mask 的包围盒中心推算一个页面坐标
    if (!renameModalPosition && target.points && target.points.length >= 2) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < target.points.length; i += 2) {
        const sx = target.points[i] * imageScale;
        const sy = target.points[i + 1] * imageScale;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const stage = stageRef.current?.getStage();
      if (stage) {
        const container = stage.container();
        const rect = container.getBoundingClientRect();
        setRenameModalPosition({ x: rect.left + centerX, y: rect.top + centerY });
      }
    }

    setShowRenameModal(true);
    setPendingRenameMaskId(null);
  }, [pendingRenameMaskId, masks, imageScale, renameModalPosition]);

  // 离开“新建 Mask”工具时，清空当前绘制的多边形
  useEffect(() => {
    if (toolMode !== 'polygon') {
      setIsDrawing(false);
      setCurrentPoints([]);
    }
  }, [toolMode]);

  // 计算图像尺寸和位置
  useEffect(() => {
    // 当图片 URL 变化时，先重置尺寸，避免使用旧图片的尺寸
    if (!image) {
      setImageScale(1);
      setStageSize({ width: 800, height: 600 });
      return;
    }

    // 使用 requestAnimationFrame 确保容器尺寸已更新
    const updateSize = () => {
      // 使用 containerRef 获取外层容器，而不是 stageRef.container()（Konva 内部容器可能尺寸不对）
      const container = containerRef.current;
      if (!container) {
        // 如果 containerRef 还没准备好，延迟重试
        setTimeout(updateSize, 50);
        return;
      }

      // 获取容器的父元素（canvas-area），它才是真正的可用空间容器
      const parentContainer = container.parentElement;
      if (!parentContainer) {
        setTimeout(updateSize, 50);
        return;
      }

      // 使用父容器（canvas-area）的尺寸，减去一些边距
      const maxWidth = parentContainer.clientWidth - 40;
      const maxHeight = parentContainer.clientHeight - 40;
      
      // 确保容器尺寸有效
      if (maxWidth <= 0 || maxHeight <= 0) {
        console.warn('[AnnotationCanvas] 容器尺寸无效，延迟重试');
        setTimeout(updateSize, 100);
        return;
      }

      // 确保图片尺寸有效
      if (!image.width || !image.height || image.width <= 0 || image.height <= 0) {
        console.warn('[AnnotationCanvas] 图片尺寸无效:', image.width, image.height);
        return;
      }
      
      // 默认图片尺寸：1280*720，如果容器足够大，直接使用原始尺寸（不缩放）
      const DEFAULT_WIDTH = 1280;
      const DEFAULT_HEIGHT = 720;
      const isDefaultSize = image.width === DEFAULT_WIDTH && image.height === DEFAULT_HEIGHT;
      
      let scale: number;
      if (isDefaultSize && maxWidth >= DEFAULT_WIDTH && maxHeight >= DEFAULT_HEIGHT) {
        // 默认尺寸且容器足够大，不缩放
        scale = 1;
        console.log('[AnnotationCanvas] 使用默认尺寸 1280*720，容器足够大，不缩放 (scale = 1)');
      } else {
        // 其他情况：计算缩放比例
        scale = Math.min(
          maxWidth / image.width,
          maxHeight / image.height
        );
        // 如果计算出的 scale >= 1，说明容器足够大，也不缩放
        if (scale >= 1) {
          scale = 1;
        }
      }
      
      setImageScale(scale);
      setStageSize({
        width: image.width * scale,
        height: image.height * scale
      });
    };

    // 使用 requestAnimationFrame 确保 DOM 已更新
    requestAnimationFrame(() => {
      updateSize();
    });
  }, [image, imageUrl]);

  /**
   * 使用方案 A：基于离屏 canvas 的真正橡皮擦
   * 思路：
   * 1. 将单个 Mask 的多边形 raster 到一张小尺寸的二值图上
   * 2. 用 destination-out 绘制橡皮擦笔划（若干圆）挖空区域
   * 3. 从剩余的 mask 图像重新提取轮廓，并抽样成有限点数
   */
  const applyEraserStroke = () => {
    if (!image || !imageScale || brushSize <= 0 || eraserStroke.length === 0) return;

    const srcWidth = image.width;
    const srcHeight = image.height;
    if (!srcWidth || !srcHeight) return;

    const MAX_CANVAS_SIZE = 512; // 控制性能的上限
    const scaleFactor = Math.min(
      1,
      MAX_CANVAS_SIZE / srcWidth,
      MAX_CANVAS_SIZE / srcHeight
    );

    const canvasWidth = Math.max(16, Math.round(srcWidth * scaleFactor));
    const canvasHeight = Math.max(16, Math.round(srcHeight * scaleFactor));

    const updatedMasks: Mask[] = [];

    const brushRadiusImage = brushSize;
    const brushRadiusCanvas = brushRadiusImage * scaleFactor;

    const strokeCanvas = eraserStroke.map(p => ({
      x: p.x * scaleFactor,
      y: p.y * scaleFactor,
    }));

    const maxPolygonPoints = 400; // 前端安全上限（具体精细度由后端/弹窗单独控制）

    const buildMaskFromBinary = (binary: Uint8ClampedArray) => {
      // 使用 Moore-Neighbor 边界跟踪从二值图中提取一条主轮廓
      const w = canvasWidth;
      const h = canvasHeight;
      const alphaAt = (x: number, y: number) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return 0;
        const idx = (y * w + x) * 4 + 3;
        return binary[idx];
      };

      // 找到任意一个前景像素作为起点
      let startX = -1;
      let startY = -1;
      outer: for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (alphaAt(x, y) > 0) {
            startX = x;
            startY = y;
            break outer;
          }
        }
      }

      if (startX === -1 || startY === -1) {
        return [] as { x: number; y: number }[]; // 整个 Mask 被擦掉
      }

      // Moore-Neighbor 边界跟踪
      const contour: { x: number; y: number }[] = [];
      let cx = startX;
      let cy = startY;
      let prevDir = 7; // 上一次移动方向（0~7，对应 8 邻域）

      const dirOffsets = [
        { dx: 1, dy: 0 },
        { dx: 1, dy: 1 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: -1, dy: -1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: -1 },
      ];

      const maxSteps = w * h * 4; // 防御性上限，避免极端情况下死循环
      let steps = 0;

      do {
        contour.push({ x: cx + 0.5, y: cy + 0.5 });
        // 从前一方向的左邻开始查找（逆时针方向）
        let foundNext = false;
        for (let i = 0; i < 8; i++) {
          const dir = (prevDir + 7 + i) % 8;
          const nx = cx + dirOffsets[dir].dx;
          const ny = cy + dirOffsets[dir].dy;
          if (alphaAt(nx, ny) > 0) {
            cx = nx;
            cy = ny;
            prevDir = dir;
            foundNext = true;
            break;
          }
        }
        if (!foundNext) {
          break;
        }
        steps++;
      } while (!(cx === startX && cy === startY) && steps < maxSteps);

      if (contour.length === 0) return contour;

      // 抽样，控制点数上限
      const step = Math.max(1, Math.floor(contour.length / maxPolygonPoints));
      const sampled: { x: number; y: number }[] = [];
      for (let i = 0; i < contour.length; i += step) {
        sampled.push(contour[i]);
      }
      return sampled;
    };

    masks.forEach(mask => {
      if (!mask.points || mask.points.length < 6) return;

      // 快速 bbox 过滤，判断这次笔划是否有必要作用在该 mask 上
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < mask.points.length; i += 2) {
        const x = mask.points[i];
        const y = mask.points[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      const radiusMargin = brushRadiusImage * 1.2;
      let intersectsStroke = false;
      for (const p of eraserStroke) {
        if (
          p.x >= minX - radiusMargin &&
          p.x <= maxX + radiusMargin &&
          p.y >= minY - radiusMargin &&
          p.y <= maxY + radiusMargin
        ) {
          intersectsStroke = true;
          break;
        }
      }
      if (!intersectsStroke) {
        updatedMasks.push(mask);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        updatedMasks.push(mask);
        return;
      }

      // 1. 绘制原始 mask 多边形为实心区域
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.save();
      ctx.scale(scaleFactor, scaleFactor);
      ctx.beginPath();
      ctx.moveTo(mask.points[0], mask.points[1]);
      for (let i = 2; i < mask.points.length; i += 2) {
        ctx.lineTo(mask.points[i], mask.points[i + 1]);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // 2. destination-out 方式绘制橡皮擦笔划（在 canvas 坐标系）
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      for (const p of strokeCanvas) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, brushRadiusCanvas, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // 3. 从剩余图像中提取新的轮廓
      const imgData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      const contour = buildMaskFromBinary(imgData.data);
      if (contour.length === 0) {
        // 整个 mask 被擦掉，直接丢弃
        return;
      }

      const newPoints: number[] = [];
      for (const p of contour) {
        const imgX = p.x / scaleFactor;
        const imgY = p.y / scaleFactor;
        newPoints.push(imgX, imgY);
      }

      updatedMasks.push({
        ...mask,
        points: newPoints,
      });
    });

    onMaskUpdate(updatedMasks);
  };

  // 将页面坐标转换为舞台坐标（允许在图片外部区域产生负值或超出 stageSize）
  const clientToStagePos = (clientX: number, clientY: number) => {
    const stage = stageRef.current?.getStage?.();
    if (!stage) return null;
    const container = stage.container();
    const rect = container.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  // 处理鼠标事件（主要用于橡皮擦 / 新建 Mask 等需要严格在图片区域内的工具）
  const handleMouseDown = (e: any) => {
    // “整块 Mask 选择”改为在更大区域（canvas-area）监听，由独立逻辑处理
    if (toolMode === 'mask-select') return;

    const stage = e.target.getStage?.() ?? stageRef.current?.getStage?.();
    const pos = stage?.getPointerPosition?.();

    if (!pos) return;

    if (toolMode === 'polygon') {
      // 仅响应鼠标左键，用于“新建 Mask”逐点点击
      if (e.evt && e.evt.button !== 0) return;

      if (!isDrawing) {
        // 开始新建 Mask，记录第一个点（舞台坐标）
        setIsDrawing(true);
        setCurrentPoints([pos.x, pos.y]);
      } else {
        const pts = currentPoints;
        if (pts.length >= 2) {
          const firstX = pts[0];
          const firstY = pts[1];
          const dx = pos.x - firstX;
          const dy = pos.y - firstY;
          const distSq = dx * dx + dy * dy;
          const thresholdPx = 10; // 与第一个点距离小于 10px 视为“闭合”

          if (distSq <= thresholdPx * thresholdPx && pts.length >= 6 && imageScale > 0) {
            // 闭合多边形 => 生成新的 Mask（points 使用图片坐标系）
            const imagePoints = pts.map((v) => v / imageScale);
            const newMask: Mask = {
              id: `mask-${Date.now()}`,
              points: imagePoints,
              label: '',
              // 默认使用灰色，后续通过“选择”+R 命名后会按项目级规则重新上色
              color: '#7F7F7F',
              opacity: 0.7,
            };

            onMaskUpdate([...masks, newMask]);

            // 计算新 mask 的中心位置（页面坐标），用于自动弹出重命名弹窗
            try {
              let minX = Infinity;
              let maxX = -Infinity;
              let minY = Infinity;
              let maxY = -Infinity;
              for (let i = 0; i < pts.length; i += 2) {
                const sx = pts[i];
                const sy = pts[i + 1];
                if (sx < minX) minX = sx;
                if (sx > maxX) maxX = sx;
                if (sy < minY) minY = sy;
                if (sy > maxY) maxY = sy;
              }
              const centerX = (minX + maxX) / 2;
              const centerY = (minY + maxY) / 2;
              const stage = stageRef.current?.getStage();
              if (stage) {
                const container = stage.container();
                const rect = container.getBoundingClientRect();
                setRenameModalPosition({ x: rect.left + centerX, y: rect.top + centerY });
              }
            } catch (err) {
              console.warn('[AnnotationCanvas] 计算新建 Mask 重命名弹窗位置失败', err);
            }

            // 等父组件把新 mask 渲染出来后再弹窗（避免 masks 还是旧值导致找不到目标）
            setPendingRenameMaskId(newMask.id);
            setIsDrawing(false);
            setCurrentPoints([]);
            return;
          }
        }

        // 继续追加新的顶点（舞台坐标）
        setCurrentPoints(prev => [...prev, pos.x, pos.y]);
      }
    } else if (toolMode === 'eraser') {
      // 橡皮擦：一次按下-拖动-松开视为一段“笔划”，结束时整体重建轮廓
      setIsErasing(true);
      setEraserCenter(pos);
      const imgX = pos.x / imageScale;
      const imgY = pos.y / imageScale;
      setEraserStroke([{ x: imgX, y: imgY }]);
    }
  };

  const handleMouseMove = (e: any) => {
    // “整块 Mask 选择”模式下的框选移动改由容器级事件处理
    if (toolMode === 'mask-select') return;

    const stage = e.target.getStage?.() ?? stageRef.current?.getStage?.();
    const pos = stage?.getPointerPosition?.();

    if (toolMode === 'eraser' && isErasing) {
      if (!pos) return;
      setEraserCenter(pos);
      const imgX = pos.x / imageScale;
      const imgY = pos.y / imageScale;
      setEraserStroke(prev => {
        const last = prev[prev.length - 1];
        if (!last) return [{ x: imgX, y: imgY }];
        const dx = imgX - last.x;
        const dy = imgY - last.y;
        // 简单抽样：移动足够距离再记录一个点，避免数组过大
        if (dx * dx + dy * dy < (brushSize * 0.25) * (brushSize * 0.25)) {
          return prev;
        }
        return [...prev, { x: imgX, y: imgY }];
      });
    }
  };

  const handleMouseUp = () => {
    // “整块 Mask 选择”模式下的框选结束改由容器级事件处理
    if (toolMode === 'mask-select') return;

    if (toolMode === 'eraser' && isErasing) {
      setIsErasing(false);
      setEraserCenter(null);
      applyEraserStroke();
      setEraserStroke([]);
    }
  };

  /**
   * “整块 Mask 选择”模式下的框选：
   * - 起点/终点均允许落在图片之外，只要在 canvas 区域内即可
   * - 不改变原有的图片缩放与 Mask 交集判定逻辑
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (toolMode !== 'mask-select') return;

    const handleContainerMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // 只处理左键
      const pos = clientToStagePos(e.clientX, e.clientY);
      if (!pos) return;
      setIsBoxSelecting(true);
      setBoxSelectStart(pos);
      setBoxSelectRect({ x: pos.x, y: pos.y, width: 0, height: 0 });
    };

    const handleContainerMouseMove = (e: MouseEvent) => {
      if (!isBoxSelecting || !boxSelectStart) return;
      const pos = clientToStagePos(e.clientX, e.clientY);
      if (!pos) return;
      const x1 = boxSelectStart.x;
      const y1 = boxSelectStart.y;
      const x2 = pos.x;
      const y2 = pos.y;
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      setBoxSelectRect({ x, y, width, height });
  };

    const handleContainerMouseUp = (e: MouseEvent) => {
      if (!isBoxSelecting || !boxSelectRect || !boxSelectStart) return;
      const pos = clientToStagePos(e.clientX, e.clientY);

      setIsBoxSelecting(false);

      const dragDistance = Math.max(boxSelectRect.width, boxSelectRect.height);
      // 拖拽距离太小，当作单击处理（Windows 体验：按住左键不动≈单击）
      if (dragDistance < 5) {
        if (pos) {
          // 点击空白处清空选择；
          // 若点击位置同时落在多个 Mask 的包围盒内，优先选择“面积更小”的 Mask（更贴近用户想点的前景目标）
          let clickedId: string | null = null;
          let smallestArea = Infinity;

          masks.forEach((mask) => {
            if (!mask.points || mask.points.length < 2) return;

            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;

            for (let i = 0; i < mask.points.length; i += 2) {
              const sx = mask.points[i] * imageScale;
              const sy = mask.points[i + 1] * imageScale;
              if (sx < minX) minX = sx;
              if (sx > maxX) maxX = sx;
              if (sy < minY) minY = sy;
              if (sy > maxY) maxY = sy;
            }

            if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) {
              const area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
              if (area < smallestArea) {
                smallestArea = area;
              clickedId = mask.id;
            }
          }
          });

          setSelectedMaskIds(clickedId ? [clickedId] : []);
        }
        setBoxSelectRect(null);
        setBoxSelectStart(null);
        return;
      }

      const rectX1 = boxSelectRect.x;
      const rectY1 = boxSelectRect.y;
      const rectX2 = boxSelectRect.x + boxSelectRect.width;
      const rectY2 = boxSelectRect.y + boxSelectRect.height;

      const newlySelectedIds: string[] = [];

      masks.forEach(mask => {
        if (!mask.points || mask.points.length < 2) return;

        // 计算该 Mask 在舞台坐标系中的包围盒
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        for (let i = 0; i < mask.points.length; i += 2) {
          const sx = mask.points[i] * imageScale;
          const sy = mask.points[i + 1] * imageScale;
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }

        const bx1 = minX;
        const by1 = minY;
        const bx2 = maxX;
        const by2 = maxY;

        const ix1 = Math.max(rectX1, bx1);
        const iy1 = Math.max(rectY1, by1);
        const ix2 = Math.min(rectX2, bx2);
        const iy2 = Math.min(rectY2, by2);

        const iw = ix2 - ix1;
        const ih = iy2 - iy1;

        if (iw > 0 && ih > 0) {
          newlySelectedIds.push(mask.id);
        }
      });

      setSelectedMaskIds(newlySelectedIds);

      setBoxSelectRect(null);
      setBoxSelectStart(null);
    };

    container.addEventListener('mousedown', handleContainerMouseDown);
    container.addEventListener('mousemove', handleContainerMouseMove);
    // mouseup 可能发生在外层（例如拖出容器又放开），这里绑定在 window 上更稳妥
    window.addEventListener('mouseup', handleContainerMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleContainerMouseDown);
      container.removeEventListener('mousemove', handleContainerMouseMove);
      window.removeEventListener('mouseup', handleContainerMouseUp);
    };
  }, [toolMode, isBoxSelecting, boxSelectStart, boxSelectRect, masks, imageScale]);

  // 渲染Mask
  const renderMasks = () => {
    if (activeLayer === 'bbox' || activeLayer === 'background') return null;
    return masks.map(mask => {
      const isSelected =
        toolMode === 'mask-select' && selectedMaskIds.includes(mask.id);
      const baseColor = mask.color || '#ff0000';
      const fillColor = mask.color || 'rgba(255, 0, 0, 0.5)';

      return (
        <Line
          key={mask.id}
          points={mask.points.map((value) =>
            // 统一按 imageScale 进行缩放，保证与图片缩放比例一致
            value * imageScale
          )}
          fill={isSelected ? fillColor : fillColor}
          stroke={isSelected ? '#FFD54F' : baseColor}
          strokeWidth={isSelected ? 4 : 2}
          closed={true}
          opacity={isSelected ? 0.9 : mask.opacity || 0.7}
        />
      );
    });
  };

  // 渲染 Mask 顶点控制点（仅在 select 模式下显示）
  const renderMaskControlPoints = () => {
    if (toolMode !== 'select') return null;

    const handlePointDrag = (maskId: string, pointIndex: number, x: number, y: number) => {
      if (imageScale === 0) return;

      const originalX = x / imageScale;
      const originalY = y / imageScale;

      const updatedMasks = masks.map(mask => {
        if (mask.id !== maskId) return mask;
        const newPoints = [...mask.points];
        newPoints[pointIndex * 2] = originalX;
        newPoints[pointIndex * 2 + 1] = originalY;
        return {
          ...mask,
          points: newPoints,
        };
      });

      onMaskUpdate(updatedMasks);
    };

    const baseRadius = 5;

    return masks.flatMap(mask => {
      const circles: React.ReactElement[] = [];
      for (let i = 0; i < mask.points.length; i += 2) {
        const x = mask.points[i] * imageScale;
        const y = mask.points[i + 1] * imageScale;
        const idx = i / 2;
        const key = `${mask.id}-pt-${idx}`;
        const isSelected =
          selectedPoint && selectedPoint.maskId === mask.id && selectedPoint.pointIndex === idx;

        circles.push(
          <Circle
            key={key}
            x={x}
            y={y}
            radius={isSelected ? baseRadius + 2 : baseRadius}
            fill={isSelected ? '#667eea' : '#ffffff'}
            stroke={isSelected ? '#667eea' : (mask.color || '#ff0000')}
            strokeWidth={isSelected ? 3 : 2}
            draggable
            onDragEnd={(e) => {
              const node = e.target;
              handlePointDrag(mask.id, idx, node.x(), node.y());
            }}
            onClick={(e) => {
              e.cancelBubble = true;
              setSelectedPoint({ maskId: mask.id, pointIndex: idx });
            }}
          />
        );
      }
      return circles;
    });
  };

  // 渲染“新建 Mask”模式下当前正在点击的点（放大显示，类似点编辑）
  const renderDrawingControlPoints = () => {
    if (toolMode !== 'polygon' || currentPoints.length === 0) return null;

    const baseRadius = 5;
    const circles: React.ReactElement[] = [];

    for (let i = 0; i < currentPoints.length; i += 2) {
      const x = currentPoints[i];
      const y = currentPoints[i + 1];
      const idx = i / 2;
      const key = `drawing-pt-${idx}`;

      const isFirst = idx === 0;
      const isLast = idx === currentPoints.length / 2 - 1;

      circles.push(
        <Circle
          key={key}
          x={x}
          y={y}
          radius={isFirst || isLast ? baseRadius + 2 : baseRadius}
          fill={isFirst ? '#667eea' : '#ffffff'}
          stroke={isFirst ? '#667eea' : '#4c6fff'}
          strokeWidth={isFirst || isLast ? 3 : 2}
          listening={false}
        />
      );
    }

    return circles;
  };

  // 渲染边界框
  const renderBoundingBoxes = () => {
    if (activeLayer === 'annotation' || activeLayer === 'background') return null;
    return boundingBoxes.map(bbox => (
      <Rect
        key={bbox.id}
        x={bbox.x * imageScale}
        y={bbox.y * imageScale}
        width={bbox.width * imageScale}
        height={bbox.height * imageScale}
        stroke={bbox.color || '#00ff00'}
        strokeWidth={2}
        fill="transparent"
      />
    ));
  };

  // 渲染多边形
  const renderPolygons = () => {
    return polygons.map(polygon => (
      <Line
        key={polygon.id}
        points={polygon.points.map((value) => value * imageScale)}
        fill={polygon.color ? `${polygon.color}40` : 'rgba(0, 0, 255, 0.25)'}
        stroke={polygon.color || '#0000ff'}
        strokeWidth={2}
        closed={true}
        draggable={true}
        onDragEnd={(e: any) => {
          // 处理多边形拖动
          const updatedPolygons = polygons.map(p => 
            p.id === polygon.id 
              ? { ...p, points: p.points.map((point, index) => 
                  index % 2 === 0 ? point + e.target.x() : point + e.target.y()
                )}
              : p
          );
          onPolygonUpdate(updatedPolygons);
        }}
      />
    ));
  };

  // 渲染R键改名弹窗
  const renderRenameModal = () => {
    if (!showRenameModal || !renameModalPosition) return null;

    // 从 localStorage 读取当前项目下已有的 label -> color 映射，并结合当前图像的 Mask / BBox 自动补全，
    // 用于下拉选择，避免忽略掉例如“object”等已经存在于图上的标签。
    let existingLabels: Array<{ label: string; color: string }> = [];
    let currentColor: string | undefined;
    try {
      const savedProject = getStoredCurrentProject<any>();
      if (savedProject) {
        const p = savedProject;
        const projectId = p && typeof p.id === 'number' ? p.id : null;
        const map = new Map<string, string>();

        if (projectId) {
          const key = `labelColorMap:${projectId}`;
          const raw = localStorage.getItem(key);
          if (raw) {
            const obj = JSON.parse(raw) as Record<string, string>;
            Object.entries(obj).forEach(([label, color]) => {
              if (label && color) {
                map.set(label, color);
              }
            });
          }
        }

        // 补全：把当前图像上的 Mask / BBox 中已有的 label->color 也加进来（仅在 map 中还没有该 label 时）
        // 注意：这个补全逻辑是为了处理"图上已有但 labelColorMap 中还没有"的情况（例如 AI 自动标注生成的）
        // 但导入后，labelColorMap 应该已经包含了所有标签，所以这个补全主要是兜底
        masks.forEach((mask) => {
          const label = (mask.label || '').trim();
          const color = mask.color;
          if (!label || !color) return;
          // 如果 labelColorMap 中还没有，则添加；如果已有但颜色不同，优先使用 labelColorMap 中的（项目级统一）
          if (!map.has(label)) {
            map.set(label, color);
          }
        });

        boundingBoxes.forEach((bbox) => {
          const label = (bbox.label || '').trim();
          const color = bbox.color;
          if (!label || !color) return;
          // 如果 labelColorMap 中还没有，则添加；如果已有但颜色不同，优先使用 labelColorMap 中的（项目级统一）
          if (!map.has(label)) {
            map.set(label, color);
          }
        });

        // 读取最近使用的标签顺序
        let usageOrder: string[] = [];
        if (projectId) {
          try {
            const usageKey = `labelUsageOrder:${projectId}`;
            const raw = localStorage.getItem(usageKey);
            if (raw) {
              usageOrder = JSON.parse(raw);
            }
          } catch (err) {
            console.warn('[AnnotationCanvas] 读取标签使用顺序失败', err);
          }
        }

        // 构建标签列表，并按最近使用顺序排序
        const allLabels = Array.from(map.entries()).map(([label, color]) => ({
              label,
              color,
            }));

        // 排序：最近使用的在前，其他按字母顺序
        existingLabels = allLabels.sort((a, b) => {
          const aIndex = usageOrder.indexOf(a.label);
          const bIndex = usageOrder.indexOf(b.label);
          
          // 如果都在使用顺序中，按顺序排序
          if (aIndex !== -1 && bIndex !== -1) {
            return aIndex - bIndex;
          }
          // 如果只有 a 在使用顺序中，a 在前
          if (aIndex !== -1) return -1;
          // 如果只有 b 在使用顺序中，b 在前
          if (bIndex !== -1) return 1;
          // 都不在使用顺序中，按字母顺序
          return a.label.localeCompare(b.label);
        });

            const trimmed = renameInputValue.trim();
        if (trimmed && map.has(trimmed)) {
          currentColor = map.get(trimmed);
        }
      }
    } catch (err) {
      console.warn('[AnnotationCanvas] 渲染重命名弹窗时读取 / 汇总 labelColorMap 失败', err);
    }

    return createPortal(
      <div className="rename-modal-backdrop" onClick={handleRenameCancel}>
        <div
          className="rename-modal"
          style={{
            left: `${renameModalPosition.x}px`,
            top: `${renameModalPosition.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="rename-modal-title">
            重命名标签（将应用到所有选中的 Mask）
          </div>
          {existingLabels.length > 0 && (
            <div className="rename-modal-select-row">
              <select
                className="rename-modal-select"
                style={
                  currentColor
                    ? {
                        backgroundColor: currentColor,
                        // 简单对比度处理：亮色背景用深字色，深色背景用白字色
                        color: '#ffffff',
                      }
                    : undefined
                }
                value={
                  existingLabels.some(
                    (item) => item.label === renameInputValue.trim()
                  )
                    ? renameInputValue.trim()
                    : ''
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val) {
                    setRenameInputValue(val);
                    // 更新最近使用的标签顺序（从下拉框选择时也记录）
                    try {
                      const savedProject = getStoredCurrentProject<any>();
                      if (savedProject) {
                        const p = savedProject;
                        const projectId = p && typeof p.id === 'number' ? p.id : null;
                        if (projectId) {
                          const usageKey = `labelUsageOrder:${projectId}`;
                          const raw = localStorage.getItem(usageKey);
                          let usageOrder: string[] = raw ? JSON.parse(raw) : [];
                          
                          // 将选中的 label 移到最前面
                          usageOrder = usageOrder.filter(l => l !== val);
                          usageOrder.unshift(val);
                          
                          // 限制最多保存50个最近使用的标签
                          if (usageOrder.length > 50) {
                            usageOrder = usageOrder.slice(0, 50);
                          }
                          
                          localStorage.setItem(usageKey, JSON.stringify(usageOrder));
                        }
                      }
                    } catch (err) {
                      console.warn('[AnnotationCanvas] 更新标签使用顺序失败', err);
                    }
                  }
                }}
              >
                <option value="">选择已有标签（可选）</option>
                {existingLabels.map((item) => (
                  <option
                    key={item.label}
                    value={item.label}
                    style={{
                      backgroundColor: item.color,
                      color: '#ffffff',
                    }}
                  >
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <input
            ref={renameInputRef}
            type="text"
            className="rename-modal-input"
            value={renameInputValue}
            onChange={(e) => setRenameInputValue(e.target.value)}
            onKeyDown={(e) => {
              // 阻止事件继续冒泡到 window，避免触发 Delete / R / 方向键等全局快捷键
              e.stopPropagation();
              if (e.key === 'Enter') {
                handleRenameConfirm();
              } else if (e.key === 'Escape') {
                handleRenameCancel();
              }
            }}
            placeholder="请输入标签名"
          />
          <div className="rename-modal-actions">
            <button
              className="rename-modal-btn rename-modal-btn-cancel"
              onClick={handleRenameCancel}
            >
              取消
            </button>
            <button
              className="rename-modal-btn rename-modal-btn-confirm"
              onClick={handleRenameConfirm}
            >
              确认
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  return (
    <div className="annotation-canvas-container" ref={containerRef}>
      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        className="annotation-stage"
      >
        <Layer>
          {image && (
            <Image
              image={image}
              width={stageSize.width}
              height={stageSize.height}
            />
          )}

          {toolMode === 'eraser' && eraserCenter && (
            <Circle
              x={eraserCenter.x}
              y={eraserCenter.y}
              radius={brushSize * imageScale}
              fill="rgba(255, 255, 255, 0.15)"
              stroke="#333"
              strokeWidth={1}
              listening={false}
            />
          )}
          
          {renderBoundingBoxes()}
          {renderMasks()}

          {/* 框选可视化 */}
          {toolMode === 'mask-select' && boxSelectRect && (
            <Rect
              x={boxSelectRect.x}
              y={boxSelectRect.y}
              width={boxSelectRect.width}
              height={boxSelectRect.height}
              stroke="#4c6fff"
              strokeWidth={1}
              dash={[4, 4]}
              fill="rgba(76, 111, 255, 0.1)"
              listening={false}
            />
          )}
          {renderMaskControlPoints()}
          {renderPolygons()}
          
          {/* 当前正在绘制的多边形 */}
          {currentPoints.length > 0 && (
            <Line
              points={currentPoints}
              stroke="#ff0000"
              strokeWidth={2}
              lineCap="round"
              lineJoin="round"
            />
          )}

          {/* 当前绘制多边形的顶点放大显示 */}
          {renderDrawingControlPoints()}
        </Layer>
      </Stage>
      {renderRenameModal()}
    </div>
  );
};

export default AnnotationCanvas;