import React, { useRef, useEffect, useState } from 'react';
import { Stage, Layer, Image, Line, Rect, Circle } from 'react-konva';
import useImage from 'use-image';
import type { Mask, BoundingBox, Polygon } from '../types';

interface AnnotationCanvasProps {
  imageUrl: string;
  masks: Mask[];
  boundingBoxes: BoundingBox[];
  polygons: Polygon[];
  toolMode: 'select' | 'mask-select' | 'eraser' | 'polygon' | 'bbox';
  brushSize: number;
  onMaskUpdate: (updatedMasks: Mask[]) => void;
  onPolygonUpdate: (updatedPolygons: Polygon[]) => void;
}

const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  imageUrl,
  masks,
  boundingBoxes,
  polygons,
  toolMode,
  brushSize,
  onMaskUpdate,
  onPolygonUpdate
}) => {
  const [image] = useImage(imageUrl);
  const stageRef = useRef<any>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [imageScale, setImageScale] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false); // 新建 Mask 绘制状态
  const [isErasing, setIsErasing] = useState(false); // 橡皮擦状态
  const [currentPoints, setCurrentPoints] = useState<number[]>([]);
  const [eraserCenter, setEraserCenter] = useState<{ x: number; y: number } | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<{ maskId: string; pointIndex: number } | null>(null);
  const [selectedMaskIds, setSelectedMaskIds] = useState<string[]>([]);
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [boxSelectStart, setBoxSelectStart] = useState<{ x: number; y: number } | null>(null);
  const [boxSelectRect, setBoxSelectRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // 键盘快捷键（点编辑模式）：Delete 删除点，I 插入新点
  useEffect(() => {
    if (toolMode !== 'select') return;

    const handleKeyDown = (e: KeyboardEvent) => {
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
      if (!selectedMaskIds || selectedMaskIds.length === 0) return;

      // 删除整块 Mask
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const updatedMasks = masks.filter(mask => !selectedMaskIds.includes(mask.id));
        onMaskUpdate(updatedMasks);
        setSelectedMaskIds([]);
        return;
      }

      // 更换颜色并修改标签名（对所有选中的 Mask 生效）
      if (e.key === 'r' || e.key === 'R') {
        const targets = masks.filter(mask => selectedMaskIds.includes(mask.id));
        if (targets.length === 0) return;

        const newLabel = window.prompt(
          '请输入新的标签名（将应用到所有选中的 Mask，按项目级规则统一颜色）：',
          targets[0].label || ''
        );

        if (newLabel === null) {
          // 用户取消
          return;
        }

        const trimmed = newLabel.trim();

        const COLOR_PALETTE = [
          '#1F77B4', '#FF7F0E', '#2CA02C', '#D62728',
          '#9467BD', '#8C564B', '#E377C2', '#7F7F7F',
        ];

        // 1. 读取当前项目（从 AnnotationPage 存在 localStorage 里的 currentProject）
        let projectId: number | null = null;
        try {
          const savedProject = localStorage.getItem('currentProject');
          if (savedProject) {
            const p = JSON.parse(savedProject);
            if (p && typeof p.id === 'number') {
              projectId = p.id;
            }
          }
        } catch (err) {
          console.warn('[AnnotationCanvas] 解析 currentProject 失败，用默认颜色逻辑', err);
        }

        // label -> color 映射按项目级持久化在 localStorage
        const loadProjectLabelColorMap = (pid: number | null): Map<string, string> => {
          if (!pid) return new Map();
          const key = `labelColorMap:${pid}`;
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return new Map();
            const obj = JSON.parse(raw) as Record<string, string>;
            return new Map(Object.entries(obj));
          } catch (err) {
            console.warn('[AnnotationCanvas] 读取 labelColorMap 失败', err);
            return new Map();
          }
        };

        const saveProjectLabelColorMap = (pid: number | null, map: Map<string, string>) => {
          if (!pid) return;
          const key = `labelColorMap:${pid}`;
          const obj: Record<string, string> = {};
          map.forEach((value, keyLabel) => {
            obj[keyLabel] = value;
          });
          try {
            localStorage.setItem(key, JSON.stringify(obj));
          } catch (err) {
            console.warn('[AnnotationCanvas] 保存 labelColorMap 失败', err);
          }
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

            // 记录新 label 的颜色
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

        // 3. 应用到所有选中的 Mask
        const updatedMasks = masks.map(mask => {
          if (!selectedMaskIds.includes(mask.id)) return mask;

          const nextLabel = trimmed.length > 0 ? trimmed : (mask.label || '');

          return {
            ...mask,
            color: targetColor,
            label: nextLabel,
          };
        });

        // 4. 写回映射
        saveProjectLabelColorMap(projectId, labelColorMap);

        onMaskUpdate(updatedMasks);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toolMode, selectedMaskIds, masks, onMaskUpdate]);

  // 切换到其他工具时，清空整块选中状态
  useEffect(() => {
    if (toolMode !== 'mask-select' && selectedMaskIds.length > 0) {
      setSelectedMaskIds([]);
    }
  }, [toolMode, selectedMaskIds]);

  // 图片切换时，重置所有交互状态
  useEffect(() => {
    setSelectedMaskIds([]);
    setSelectedPoint(null);
    setIsBoxSelecting(false);
    setBoxSelectRect(null);
    setBoxSelectStart(null);
    setIsErasing(false);
    setEraserCenter(null);
    setIsDrawing(false);
    setCurrentPoints([]);
  }, [imageUrl]);

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
      const container = stageRef.current?.container();
      if (!container) return;

      const maxWidth = container.clientWidth - 40;
      const maxHeight = container.clientHeight - 40;
      
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
      
      const scale = Math.min(
        maxWidth / image.width,
        maxHeight / image.height
      );
      
      console.log('[AnnotationCanvas] 原始图片尺寸:', image.width, image.height);
      console.log('[AnnotationCanvas] 容器最大尺寸:', maxWidth, maxHeight);
      console.log('[AnnotationCanvas] 计算得到的缩放比例 scale =', scale);

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

  const applyEraser = (stagePos: { x: number; y: number }) => {
    if (!imageScale || brushSize <= 0) return;

    const cx = stagePos.x / imageScale;
    const cy = stagePos.y / imageScale;
    const radius = brushSize;
    const radiusSq = radius * radius;

    const updatedMasks = masks.map((mask) => {
      if (!mask.points || mask.points.length < 2) return mask;

      const newPoints = [...mask.points];

      for (let i = 0; i < newPoints.length; i += 2) {
        const px = newPoints[i];
        const py = newPoints[i + 1];
        const dx = px - cx;
        const dy = py - cy;
        const distSq = dx * dx + dy * dy;

        if (distSq > 0 && distSq < radiusSq) {
          const dist = Math.sqrt(distSq);
          const scale = radius / dist;
          const nx = cx + dx * scale;
          const ny = cy + dy * scale;
          newPoints[i] = nx;
          newPoints[i + 1] = ny;
        }
      }

      return {
        ...mask,
        points: newPoints,
      };
    });

    onMaskUpdate(updatedMasks);
  };

  // 处理鼠标事件
  const handleMouseDown = (e: any) => {
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
              opacity: 0.5,
            };

            onMaskUpdate([...masks, newMask]);
            setIsDrawing(false);
            setCurrentPoints([]);
            return;
          }
        }

        // 继续追加新的顶点（舞台坐标）
        setCurrentPoints(prev => [...prev, pos.x, pos.y]);
      }
    } else if (toolMode === 'eraser') {
      setIsErasing(true);
      setEraserCenter(pos);
      applyEraser(pos);
    } else if (toolMode === 'mask-select') {
      setIsBoxSelecting(true);
      setBoxSelectStart(pos);
      setBoxSelectRect({ x: pos.x, y: pos.y, width: 0, height: 0 });
    }
  };

  const handleMouseMove = (e: any) => {
    const stage = e.target.getStage?.() ?? stageRef.current?.getStage?.();
    const pos = stage?.getPointerPosition?.();

    if (toolMode === 'eraser' && isErasing) {
      if (!pos) return;
      setEraserCenter(pos);
      applyEraser(pos);
    } else if (toolMode === 'mask-select' && isBoxSelecting && boxSelectStart) {
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
    }
  };

  const handleMouseUp = (e: any) => {
    if (toolMode === 'eraser' && isErasing) {
      setIsErasing(false);
      setEraserCenter(null);
    } else if (toolMode === 'mask-select' && isBoxSelecting && boxSelectRect && boxSelectStart) {
      setIsBoxSelecting(false);

      const stage = e?.target?.getStage?.() ?? stageRef.current?.getStage?.();
      const pos = stage?.getPointerPosition?.() as { x: number; y: number } | null | undefined;

      const dragDistance = Math.max(boxSelectRect.width, boxSelectRect.height);
      // 拖拽距离太小，当作单击处理（Windows 体验：按住左键不动≈单击）
      if (dragDistance < 5) {
        if (pos) {
          // 点击空白处清空选择；点击到某个 Mask 则选中该 Mask（取最后绘制的优先）
          let clickedId: string | null = null;
          for (let mi = masks.length - 1; mi >= 0; mi--) {
            const mask = masks[mi];
            if (!mask.points || mask.points.length < 2) continue;

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
              clickedId = mask.id;
              break;
            }
          }
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
    }
  };

  // 渲染Mask
  const renderMasks = () => {
    return masks.map(mask => {
      const isSelected =
        toolMode === 'mask-select' && selectedMaskIds.includes(mask.id);
      const baseColor = mask.color || '#ff0000';
      const fillColor = mask.color || 'rgba(255, 0, 0, 0.3)';

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
          opacity={isSelected ? 0.8 : mask.opacity || 0.5}
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

  return (
    <div className="annotation-canvas-container">
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
          {renderBoundingBoxes()}
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
    </div>
  );
};

export default AnnotationCanvas;