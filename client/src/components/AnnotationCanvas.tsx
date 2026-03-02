import React, { useRef, useEffect, useState } from 'react';
import { Stage, Layer, Image, Line, Rect, Circle } from 'react-konva';
import useImage from 'use-image';
import type { Mask, BoundingBox, Polygon } from '../types';

interface AnnotationCanvasProps {
  imageUrl: string;
  masks: Mask[];
  boundingBoxes: BoundingBox[];
  polygons: Polygon[];
  toolMode: 'select' | 'eraser' | 'polygon' | 'bbox';
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
  const [isDrawing, setIsDrawing] = useState(false); // 多边形绘制状态
  const [isErasing, setIsErasing] = useState(false); // 橡皮擦状态
  const [currentPoints, setCurrentPoints] = useState<number[]>([]);
  const [eraserCenter, setEraserCenter] = useState<{ x: number; y: number } | null>(null);

  // 计算图像尺寸和位置
  useEffect(() => {
    if (image) {
      const container = stageRef.current?.container();
      if (container) {
        const maxWidth = container.clientWidth - 40;
        const maxHeight = container.clientHeight - 40;
        
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
      }
    }
  }, [image]);

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
    if (toolMode === 'polygon') {
      const pos = e.target.getStage().getPointerPosition();
      setCurrentPoints(prev => [...prev, pos.x, pos.y]);
      setIsDrawing(true);
    } else if (toolMode === 'eraser') {
      const pos = e.target.getStage().getPointerPosition();
      if (!pos) return;
      setIsErasing(true);
      setEraserCenter(pos);
      applyEraser(pos);
    }
  };

  const handleMouseMove = (e: any) => {
    if (toolMode === 'eraser' && isErasing) {
      const pos = e.target.getStage().getPointerPosition();
      if (!pos) return;
      setEraserCenter(pos);
      applyEraser(pos);
    }
  };

  const handleMouseUp = () => {
    if (toolMode === 'polygon' && isDrawing) {
      setIsDrawing(false);
      // 完成多边形绘制
      if (currentPoints.length >= 6) { // 至少3个点
        const newPolygon: Polygon = {
          id: `polygon-${Date.now()}`,
          points: [...currentPoints],
          label: 'new_object',
          color: '#ff0000'
        };
        onPolygonUpdate([...polygons, newPolygon]);
        setCurrentPoints([]);
      }
    } else if (toolMode === 'eraser' && isErasing) {
      setIsErasing(false);
      setEraserCenter(null);
    }
  };

  // 渲染Mask
  const renderMasks = () => {
    return masks.map(mask => (
      <Line
        key={mask.id}
        points={mask.points.map((value) => 
          // 统一按 imageScale 进行缩放，保证与图片缩放比例一致
          value * imageScale
        )}
        fill={mask.color || 'rgba(255, 0, 0, 0.3)'}
        stroke={mask.color || '#ff0000'}
        strokeWidth={2}
        closed={true}
        opacity={mask.opacity || 0.5}
      />
    ));
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

    const radius = 5;

    return masks.flatMap(mask => {
      const circles: JSX.Element[] = [];
      for (let i = 0; i < mask.points.length; i += 2) {
        const x = mask.points[i] * imageScale;
        const y = mask.points[i + 1] * imageScale;
        const key = `${mask.id}-pt-${i / 2}`;

        circles.push(
          <Circle
            key={key}
            x={x}
            y={y}
            radius={radius}
            fill="#ffffff"
            stroke={mask.color || '#ff0000'}
            strokeWidth={2}
            draggable
            onDragEnd={(e) => {
              const node = e.target;
              handlePointDrag(mask.id, i / 2, node.x(), node.y());
            }}
          />
        );
      }
      return circles;
    });
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
        onMousemove={handleMouseMove}
        onMouseup={handleMouseUp}
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
        </Layer>
      </Stage>
    </div>
  );
};

export default AnnotationCanvas;