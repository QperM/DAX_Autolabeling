import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const LandingPage: React.FC = () => {
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const navigate = useNavigate();

  const availableModules = [
    { id: '2d-bbox-mask', name: '2D Bbox/Mask 标注', description: '基础的2D边界框和Mask标注功能' },
    { id: '9d-pose', name: '9D Pose 标注', description: '3D姿态标注（待开发）', disabled: true },
  ];

  const handleModuleToggle = (moduleId: string) => {
    setSelectedModules(prev => 
      prev.includes(moduleId) 
        ? prev.filter(id => id !== moduleId)
        : [...prev, moduleId]
    );
  };

  const handleStart = () => {
    if (selectedModules.length === 0) {
      alert('请至少选择一个模块');
      return;
    }
    
    // 存储选择的模块到localStorage
    localStorage.setItem('selectedModules', JSON.stringify(selectedModules));
    navigate('/annotate');
  };

  return (
    <div className="landing-page">
      <div className="landing-content">
        <header className="landing-header">
          <h1>智能图像标注系统</h1>
          <p className="subtitle">V1.0</p>
        </header>

        <div className="module-selection">
          <h2>请选择本次标注任务需要的模块</h2>
          <p className="hint">可以根据需要选择多个模块，选定后将锁定功能页面</p>
          
          <div className="modules-grid">
            {availableModules.map(module => (
              <div 
                key={module.id}
                className={`module-card ${selectedModules.includes(module.id) ? 'selected' : ''} ${module.disabled ? 'disabled' : ''}`}
                onClick={() => !module.disabled && handleModuleToggle(module.id)}
              >
                <div className="module-header">
                  <h3>{module.name}</h3>
                  {module.disabled && <span className="badge coming-soon">即将推出</span>}
                </div>
                <p className="module-description">{module.description}</p>
                {selectedModules.includes(module.id) && (
                  <div className="checkmark">✓</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {selectedModules.includes('9d-pose') && (
          <div className="warning-box">
            <h3>⚠️ 9D Pose 模块注意事项</h3>
            <p>9D Pose标注需要相机参数和深度图等额外信息，请确保这批数据包含：</p>
            <ul>
              <li>相机内参矩阵</li>
              <li>深度图像数据</li>
              <li>对应的RGB图像</li>
            </ul>
            <p>缺少这些信息可能导致标注结果不准确。</p>
          </div>
        )}

        <div className="actions">
          <button 
            className="start-button"
            onClick={handleStart}
            disabled={selectedModules.length === 0}
          >
            开始标注工作 →
          </button>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;