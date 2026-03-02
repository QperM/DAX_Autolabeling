import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setCurrentImage } from '../store/annotationSlice';
import type { Image, Mask, BoundingBox, Polygon } from '../types';
import { annotationApi } from '../services/api';
import AnnotationCanvas from './AnnotationCanvas';
import './ManualAnnotation.css';

const ManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images, annotations } = useSelector((state: any) => state.annotation);
  const [selectedTool, setSelectedTool] = useState('eraser');
  const [brushSize, setBrushSize] = useState(20);
  const [activeLayer, setActiveLayer] = useState<'background' | 'annotation'>('background');
  const [masks, setMasks] = useState<Mask[]>([]);
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
  const [polygons, setPolygons] = useState<Polygon[]>([]);

  // 检查是否有选中的图片
  useEffect(() => {
    // 添加延迟检查，避免初始渲染时的误判
    const timer = setTimeout(() => {
      if (!currentImage) {
        // 如果没有选中图片，返回主页
        navigate('/');
      }
    }, 200);
    
    return () => clearTimeout(timer);
  }, [currentImage, navigate]);

  // 加载当前图片的标注（mask / bbox 等）
  useEffect(() => {
    const loadAnnotation = async () => {
      if (!currentImage) {
        setMasks([]);
        setBoundingBoxes([]);
        setPolygons([]);
        return;
      }

      try {
        console.log('[ManualAnnotation] 开始加载当前图片的标注数据, imageId =', currentImage.id);

        // 优先从 Redux 中读（如果之前已经加载过）
        const cached = annotations?.[currentImage.id];
        if (cached) {
          console.log('[ManualAnnotation] 使用 Redux 中缓存的标注数据:', cached);
          setMasks(cached.masks || []);
          setBoundingBoxes(cached.boundingBoxes || []);
          setPolygons(cached.polygons || []);
          return;
        }

        // 否则从后端拉取
        const resp = await annotationApi.getAnnotation(currentImage.id);
        const anno = resp?.annotation;
        console.log('[ManualAnnotation] 从后端获取到的标注响应:', resp);

        if (anno) {
          setMasks(anno.masks || []);
          setBoundingBoxes(anno.boundingBoxes || []);
          setPolygons(anno.polygons || []);
        } else {
          console.warn('[ManualAnnotation] 当前图片暂无标注数据, imageId =', currentImage.id);
          setMasks([]);
          setBoundingBoxes([]);
          setPolygons([]);
        }
      } catch (e) {
        console.error('[ManualAnnotation] 加载标注数据失败:', e);
        setMasks([]);
        setBoundingBoxes([]);
        setPolygons([]);
      }
    };

    loadAnnotation();
  }, [currentImage, annotations]);

  const handleToolSelect = (tool: string) => {
    setSelectedTool(tool);
  };

  const handleBack = () => {
    dispatch(setCurrentImage(null));
    navigate('/annotate');
  };

  if (!currentImage) {
    return null;
  }

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
            {currentImage.originalName}
          </span>
        </div>
        <div className="header-right">
          <span className="image-counter">
            {images.findIndex((img: Image) => img.id === currentImage.id) + 1} / {images.length}
          </span>
        </div>
      </header>

      {/* 主工作区域 */}
      <div className="annotation-main">
        {/* 左侧悬浮面板 - 仅保留橡皮擦工具 */}
        <div className="annotation-left-panel">
          <div className="tool-section">
            <button
              className={`eraser-card ${selectedTool === 'eraser' ? 'active' : ''}`}
              onClick={() => handleToolSelect('eraser')}
              title="橡皮擦"
            >
              <div className="eraser-icon-box">
                <span className="eraser-icon">🧹</span>
              </div>
              <div className="eraser-text-box">
                <div className="eraser-title">橡皮擦</div>
              </div>
            </button>
          </div>
        </div>

        {/* 中间面板 - 标注画布 */}
        <div className="annotation-center-panel">
          <div className="canvas-area">
            <AnnotationCanvas
              imageUrl={`http://localhost:3001${currentImage.url}`}
              masks={activeLayer === 'annotation' ? masks : []}
              boundingBoxes={activeLayer === 'annotation' ? boundingBoxes : []}
              polygons={activeLayer === 'annotation' ? polygons : []}
              toolMode={selectedTool === 'eraser' ? 'eraser' : 'select'}
              brushSize={brushSize}
              onMaskUpdate={(updatedMasks) => {
                console.log('[ManualAnnotation] onMaskUpdate, count =', updatedMasks.length);
                setMasks(updatedMasks);
              }}
              onPolygonUpdate={(updatedPolygons) => {
                console.log('[ManualAnnotation] onPolygonUpdate, count =', updatedPolygons.length);
                setPolygons(updatedPolygons);
              }}
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
              </div>
            </div>
            
            <div className="property-section">
              <h4>标注统计</h4>
              <div className="stats">
                <div className="stat-item">
                  <span>多边形:</span>
                  <span>0</span>
                </div>
                <div className="stat-item">
                  <span>边界框:</span>
                  <span>0</span>
                </div>
                <div className="stat-item">
                  <span>Mask区域:</span>
                  <span>0</span>
                </div>
              </div>
            </div>

            <div className="property-section">
              <h4>图层管理</h4>
              <div className="layers">
                <div
                  className={`layer-item ${activeLayer === 'background' ? 'active' : ''}`}
                  onClick={() => {
                    console.log('[ManualAnnotation] 切换图层: background');
                    setActiveLayer('background');
                  }}
                >
                  <span>背景图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
                <div
                  className={`layer-item ${activeLayer === 'annotation' ? 'active' : ''}`}
                  onClick={() => {
                    console.log('[ManualAnnotation] 切换图层: annotation');
                    setActiveLayer('annotation');
                  }}
                >
                  <span>标注图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualAnnotation;