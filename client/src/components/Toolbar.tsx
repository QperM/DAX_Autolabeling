import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { setToolMode, setBrushSize, undo, redo } from '../store/annotationSlice';
import type { ToolMode } from '../types';

const Toolbar: React.FC = () => {
  const dispatch = useDispatch();
  const { toolMode, brushSize, historyIndex, history } = useSelector((state: any) => state.annotation);

  const tools: { mode: ToolMode; icon: string; label: string }[] = [
    { mode: 'select', icon: '↖', label: '选择' },
    { mode: 'eraser', icon: '🧹', label: '擦除' },
    { mode: 'polygon', icon: '🔺', label: '多边形' },
    { mode: 'bbox', icon: '⬜', label: '边界框' },
  ];

  const handleToolChange = (mode: ToolMode) => {
    dispatch(setToolMode(mode));
  };

  const handleBrushSizeChange = (size: number) => {
    dispatch(setBrushSize(size));
  };

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  return (
    <div className="toolbar">
      <div className="tool-selection">
        <h3>工具</h3>
        <div className="tools-grid">
          {tools.map(tool => (
            <button
              key={tool.mode}
              className={`tool-button ${toolMode === tool.mode ? 'active' : ''}`}
              onClick={() => handleToolChange(tool.mode)}
              title={tool.label}
            >
              <span className="tool-icon">{tool.icon}</span>
              <span className="tool-label">{tool.label}</span>
            </button>
          ))}
        </div>
      </div>

      {toolMode === 'eraser' && (
        <div className="brush-controls">
          <h3>笔刷大小</h3>
          <div className="brush-slider-container">
            <input
              type="range"
              min="1"
              max="50"
              value={brushSize}
              onChange={(e) => handleBrushSizeChange(parseInt(e.target.value))}
              className="brush-slider"
            />
            <span className="brush-size-display">{brushSize}px</span>
          </div>
        </div>
      )}

      <div className="history-controls">
        <h3>历史记录</h3>
        <div className="history-buttons">
          <button
            className={`history-button ${!canUndo ? 'disabled' : ''}`}
            onClick={() => dispatch(undo())}
            disabled={!canUndo}
            title="撤销 (Ctrl+Z)"
          >
            ↶ 撤销
          </button>
          <button
            className={`history-button ${!canRedo ? 'disabled' : ''}`}
            onClick={() => dispatch(redo())}
            disabled={!canRedo}
            title="重做 (Ctrl+Y)"
          >
            ↷ 重做
          </button>
        </div>
      </div>

      <div className="action-buttons">
        <button className="primary-button">
          💾 保存标注
        </button>
        <button className="secondary-button">
          📤 导出数据集
        </button>
        <button className="secondary-button">
          🤖 自动标注
        </button>
      </div>
    </div>
  );
};

export default Toolbar;