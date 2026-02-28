import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { setCurrentImage } from '../store/annotationSlice';
import type { Image } from '../types';
import './ManualAnnotation.css';

const ManualAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { currentImage, images } = useSelector((state: any) => state.annotation);
  const [selectedTool, setSelectedTool] = useState('select');
  const [brushSize, setBrushSize] = useState(20);

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

  const handleToolSelect = (tool: string) => {
    setSelectedTool(tool);
  };

  const handleBrushSizeChange = (size: number) => {
    setBrushSize(size);
  };

  const handleSave = () => {
    alert('标注已保存！');
  };

  const handleExport = () => {
    alert('数据集导出功能待实现');
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
        {/* 左侧面板 - 工具栏 */}
        <div className="annotation-left-panel">
          <div className="tool-section">
            <h3>标注工具</h3>
            <div className="tools-grid">
              <button 
                className={`tool-button ${selectedTool === 'select' ? 'active' : ''}`}
                onClick={() => handleToolSelect('select')}
                title="选择工具"
              >
                <span className="tool-icon">↖</span>
                <span className="tool-label">选择</span>
              </button>
              <button 
                className={`tool-button ${selectedTool === 'brush' ? 'active' : ''}`}
                onClick={() => handleToolSelect('brush')}
                title="画笔工具"
              >
                <span className="tool-icon">🖌️</span>
                <span className="tool-label">画笔</span>
              </button>
              <button 
                className={`tool-button ${selectedTool === 'eraser' ? 'active' : ''}`}
                onClick={() => handleToolSelect('eraser')}
                title="橡皮擦"
              >
                <span className="tool-icon">🧹</span>
                <span className="tool-label">橡皮擦</span>
              </button>
              <button 
                className={`tool-button ${selectedTool === 'polygon' ? 'active' : ''}`}
                onClick={() => handleToolSelect('polygon')}
                title="多边形"
              >
                <span className="tool-icon">🔺</span>
                <span className="tool-label">多边形</span>
              </button>
              <button 
                className={`tool-button ${selectedTool === 'rectangle' ? 'active' : ''}`}
                onClick={() => handleToolSelect('rectangle')}
                title="矩形框"
              >
                <span className="tool-icon">⬜</span>
                <span className="tool-label">矩形框</span>
              </button>
              <button 
                className={`tool-button ${selectedTool === 'magic-wand' ? 'active' : ''}`}
                onClick={() => handleToolSelect('magic-wand')}
                title="魔棒工具"
              >
                <span className="tool-icon">✨</span>
                <span className="tool-label">魔棒</span>
              </button>
            </div>
          </div>

          {/* 画笔大小调节 */}
          {selectedTool === 'brush' && (
            <div className="brush-controls">
              <h3>画笔大小</h3>
              <div className="size-slider">
                <input 
                  type="range" 
                  min="5" 
                  max="50" 
                  value={brushSize}
                  onChange={(e) => handleBrushSizeChange(parseInt(e.target.value))}
                />
                <span className="size-value">{brushSize}px</span>
              </div>
              <div className="brush-preview">
                <div 
                  className="brush-circle" 
                  style={{ width: brushSize, height: brushSize }}
                ></div>
              </div>
            </div>
          )}

          <div className="action-section">
            <button className="primary-button" onClick={handleSave}>
              💾 保存标注
            </button>
            <button className="secondary-button" onClick={handleExport}>
              📤 导出数据集
            </button>
          </div>
        </div>

        {/* 中间面板 - 标注画布 */}
        <div className="annotation-center-panel">
          <div className="canvas-area">
            <div className="image-container">
              <img 
                src={`http://localhost:3001${currentImage.url}`} 
                alt={currentImage.originalName}
                className="annotation-image"
              />
              {/* 标注层将在这里渲染 */}
              <div className="annotation-overlay">
                {/* 动态标注元素 */}
              </div>
            </div>
          </div>
        </div>

        {/* 右侧面板 - 属性面板 */}
        <div className="annotation-right-panel">
          <div className="properties-panel">
            <h3>属性面板</h3>
            <div className="property-section">
              <h4>当前工具</h4>
              <div className="current-tool">
                {selectedTool === 'select' && '选择工具'}
                {selectedTool === 'brush' && '画笔工具'}
                {selectedTool === 'eraser' && '橡皮擦'}
                {selectedTool === 'polygon' && '多边形工具'}
                {selectedTool === 'rectangle' && '矩形框工具'}
                {selectedTool === 'magic-wand' && '魔棒工具'}
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
                <div className="layer-item active">
                  <span>背景图层</span>
                  <span className="layer-visible">👁️</span>
                </div>
                <div className="layer-item">
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