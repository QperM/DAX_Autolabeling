import React, { useRef, useEffect, useState } from 'react';
import { Stage, Layer, Image, Line, Rect } from 'react-konva';
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
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<number[]>([]);

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
        
        setStageSize({
          width: image.width * scale,
          height: image.height * scale
        });
      }
    }
  }, [image]);

  // 处理鼠标事件
  const handleMouseDown = (e: any) => {
    if (toolMode === 'polygon') {
      const pos = e.target.getStage().getPointerPosition();
      setCurrentPoints(prev => [...prev, pos.x, pos.y]);
      setIsDrawing(true);
    }
  };

  const handleMouseMove = (e: any) => {
    if (toolMode === 'eraser' && isDrawing) {
      // 擦除逻辑
      const pos = e.target.getStage().getPointerPosition();
      // 实现擦除功能
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
    } else if (toolMode === 'eraser') {
      setIsDrawing(false);
    }
  };

  // 渲染Mask
  const renderMasks = () => {
    return masks.map(mask => (
      <Line
        key={mask.id}
        points={mask.points}
        fill={mask.color || 'rgba(255, 0, 0, 0.3)'}
        stroke={mask.color || '#ff0000'}
        strokeWidth={2}
        closed={true}
        opacity={mask.opacity || 0.5}
      />
    ));
  };

  // 渲染边界框
  const renderBoundingBoxes = () => {
    return boundingBoxes.map(bbox => (
      <Rect
        key={bbox.id}
        x={bbox.x}
        y={bbox.y}
        width={bbox.width}
        height={bbox.height}
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
        points={polygon.points}
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
          
          {renderMasks()}
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