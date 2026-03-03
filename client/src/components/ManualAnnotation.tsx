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
  const [selectedTool, setSelectedTool] = useState<'eraser' | 'mask' | 'point' | 'draw'>('mask');
  const [brushSize, setBrushSize] = useState(20);
  const [activeLayer, setActiveLayer] = useState<'background' | 'annotation'>('background');
  const [masks, setMasks] = useState<Mask[]>([]);
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
  const [polygons, setPolygons] = useState<Polygon[]>([]);
  type HistoryEntry = { masks: Mask[]; boundingBoxes: BoundingBox[]; polygons: Polygon[] };
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [showEraserDropdown, setShowEraserDropdown] = useState(false);
  const eraserWrapperRef = useRef<HTMLDivElement | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);

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
        console.log('[ManualAnnotation] 开始加载当前图片的标注数据, imageId =', currentImage.id);

        // 优先从 Redux 中读（如果之前已经加载过）
        const cached = annotations?.[currentImage.id];
        if (cached) {
          console.log('[ManualAnnotation] 使用 Redux 中缓存的标注数据:', cached);
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
        console.log('[ManualAnnotation] 从后端获取到的标注响应:', resp);

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
          console.warn('[ManualAnnotation] 当前图片暂无标注数据, imageId =', currentImage.id);
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
  }, [currentImage, annotations]);

  const handleToolSelect = (tool: 'eraser' | 'mask' | 'point' | 'draw') => {
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

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleNavigateImage('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNavigateImage('next');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentImage, images, autoSaveEnabled, canUndo, canRedo, historyIndex, history.length]);

  const handleSaveAnnotation = async (options?: { silent?: boolean }): Promise<boolean> => {
    if (!currentImage) return false;
    const silent = options?.silent ?? false;
    try {
      console.log('[ManualAnnotation] 保存标注，imageId =', currentImage.id);
      await annotationApi.saveAnnotation(currentImage.id, {
        masks,
        boundingBoxes,
        polygons,
      });
      if (!silent) {
        alert('标注已保存');
      }
      return true;
    } catch (e: any) {
      console.error('[ManualAnnotation] 保存标注失败:', e);
      if (!silent) {
        alert(e?.message || '保存标注失败');
      } else {
        alert(e?.message || '自动保存失败，请稍后重试手动保存');
      }
      return false;
    }
  };

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
          <button
            type="button"
            className="nav-arrow-button"
            onClick={() => handleNavigateImage('prev')}
            disabled={!images || images.length === 0 || images.findIndex((img: Image) => img.id === currentImage.id) <= 0}
            title="上一张（←）"
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
              title="选择（整块 Mask：点击选中，高亮，Delete 删除，R 改颜色和标签）"
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
              onMaskUpdate={(updatedMasks) => {
                console.log('[ManualAnnotation] onMaskUpdate, count =', updatedMasks.length);
                setMasks(updatedMasks);
                pushHistory(updatedMasks, boundingBoxes, polygons);
              }}
              onPolygonUpdate={(updatedPolygons) => {
                console.log('[ManualAnnotation] onPolygonUpdate, count =', updatedPolygons.length);
                setPolygons(updatedPolygons);
                pushHistory(masks, boundingBoxes, updatedPolygons);
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
                {selectedTool === 'mask' && '选择（整块 Mask：点击选中，高亮，Delete 删除，R 改颜色和标签）'}
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