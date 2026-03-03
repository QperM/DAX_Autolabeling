import React, { useEffect, useRef, useState } from 'react';
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
  const [selectedTool, setSelectedTool] = useState<'eraser' | 'select'>('eraser');
  const [brushSize, setBrushSize] = useState(20);
  const [activeLayer, setActiveLayer] = useState<'background' | 'annotation'>('background');
  const [masks, setMasks] = useState<Mask[]>([]);
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
  const [polygons, setPolygons] = useState<Polygon[]>([]);
  const [showEraserDropdown, setShowEraserDropdown] = useState(false);
  const eraserWrapperRef = useRef<HTMLDivElement | null>(null);
  const [colorLabelDrafts, setColorLabelDrafts] = useState<Record<string, string>>({});
  const editingColorRef = useRef<string | null>(null);

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

  const handleToolSelect = (tool: 'eraser' | 'select') => {
    setSelectedTool(tool);
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
    navigate('/annotate');
  };

  const handleSaveAnnotation = async () => {
    if (!currentImage) return;
    try {
      console.log('[ManualAnnotation] 保存标注，imageId =', currentImage.id);
      await annotationApi.saveAnnotation(currentImage.id, {
        masks,
        boundingBoxes,
        polygons,
      });
      alert('标注已保存');
    } catch (e: any) {
      console.error('[ManualAnnotation] 保存标注失败:', e);
      alert(e?.message || '保存标注失败');
    }
  };

  const getEffectiveMaskColor = (mask: Mask) => mask.color || 'rgba(255, 0, 0, 0.7)';
  const getEffectiveBboxColor = (bbox: BoundingBox) => bbox.color || 'rgba(0, 255, 0, 0.7)';

  // 统计当前标注中的“颜色 -> label”，用于右侧标签图例展示
  // 目标：你改某个颜色对应的 label 时，该颜色下所有对象的 label 一起被修改
  const colorLabelEntries: Array<[string, string]> = (() => {
    const map = new Map<string, string>(); // color -> label

    masks.forEach((mask) => {
      const color = getEffectiveMaskColor(mask);
      const label = (mask.label || '').trim();
      if (!label) return;
      if (!map.has(color)) {
        map.set(color, label);
      }
    });

    boundingBoxes.forEach((bbox) => {
      const color = getEffectiveBboxColor(bbox);
      const label = (bbox.label || '').trim();
      if (!label) return;
      if (!map.has(color)) {
        map.set(color, label);
      }
    });

    return Array.from(map.entries());
  })();

  // 当图例条目变化时，同步填充 drafts（但不打断正在编辑的那一行）
  useEffect(() => {
    setColorLabelDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const [color, label] of colorLabelEntries) {
        if (editingColorRef.current === color) continue;
        next[color] = label;
      }
      // 清理已不存在的颜色
      for (const key of Object.keys(next)) {
        if (!colorLabelEntries.some(([c]) => c === key)) {
          delete next[key];
        }
      }
      return next;
    });
  }, [masks, boundingBoxes]);

  const handleLabelRenameByColor = (color: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;

    setMasks((prev) =>
      prev.map((mask) => {
        const c = getEffectiveMaskColor(mask);
        if (c !== color) return mask;
        if ((mask.label || '').trim() === trimmed) return mask;
        return { ...mask, label: trimmed };
      })
    );

    setBoundingBoxes((prev) =>
      prev.map((bbox) => {
        const c = getEffectiveBboxColor(bbox);
        if (c !== color) return bbox;
        if ((bbox.label || '').trim() === trimmed) return bbox;
        return { ...bbox, label: trimmed };
      })
    );
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
        {/* 左侧悬浮面板 - 橡皮擦 / 选择工具 */}
        <div className="annotation-left-panel">
          <div className="tool-section">
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
              className={`select-card ${selectedTool === 'select' ? 'active' : ''}`}
              onClick={() => handleToolSelect('select')}
              title="选择（拖动Mask顶点微调）"
            >
              <div className="select-icon-box">
                <span className="select-icon">🎯</span>
              </div>
              <div className="select-text-box">
                <div className="select-title">选择</div>
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
                {selectedTool === 'select' && '选择（拖动Mask顶点）'}
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

            <div className="property-section">
              <h4>保存</h4>
              <button
                type="button"
                className="primary-button"
                onClick={handleSaveAnnotation}
              >
                保存标注（JSON）
              </button>
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
                    <input
                      className="label-name"
                      title={`颜色: ${color}（当前: ${label}）`}
                      value={colorLabelDrafts[color] ?? label}
                      onFocus={() => {
                        editingColorRef.current = color;
                      }}
                      onChange={(e) => {
                        const v = e.target.value;
                        setColorLabelDrafts((prev) => ({ ...prev, [color]: v }));
                      }}
                      onBlur={(e) => {
                        editingColorRef.current = null;
                        const v = e.target.value;
                        handleLabelRenameByColor(color, v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="label-legend-hint">
                提示：在这里改的是“颜色对应的标签名”，同色的所有对象会一起改名。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ManualAnnotation;