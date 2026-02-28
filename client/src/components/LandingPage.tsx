import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectApi } from '../services/api';
import './LandingPage.css';

const LandingPage: React.FC = () => {
  // 选中的功能模块
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  // 当前选择的项目
  const [currentProject, setCurrentProject] = useState<any>(null);
  // 项目列表（用于弹出的项目选择列表）
  const [projects, setProjects] = useState<any[]>([]);
  // 是否显示项目列表弹窗
  const [showProjectList, setShowProjectList] = useState(false);
  // 是否显示“新建项目”弹窗
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  // 新建项目表单
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const navigate = useNavigate();

  // 初始化：加载当前项目和项目列表
  useEffect(() => {
    const initialize = async () => {
      // 尝试从 localStorage 恢复当前项目
      const savedProject = localStorage.getItem('currentProject');
      if (savedProject) {
        try {
          const project = JSON.parse(savedProject);
          setCurrentProject(project);
          console.log('自动加载保存的项目:', project.name);
        } catch (e) {
          console.error('解析保存的项目失败', e);
          localStorage.removeItem('currentProject');
        }
      }

      // 加载项目列表（用于“选择项目”弹窗）
      try {
        const projectsList = await projectApi.getProjects();
        setProjects(projectsList);
      } catch (error) {
        console.error('加载项目列表失败', error);
        setProjects([]);
      }
    };

    initialize();
  }, []);

  const availableModules = [
    { id: '2d-bbox-mask', name: '2D Bbox/Mask 标注', description: '基础的2D边界框和Mask标注功能' },
    { id: '9d-pose', name: '9D Pose 标注', description: '3D姿态标注（待开发）', disabled: true },
  ];

  const handleModuleToggle = (moduleId: string) => {
    console.log('切换模块:', moduleId);
    setSelectedModules(prev => {
      const newSelected = prev.includes(moduleId) 
        ? prev.filter(id => id !== moduleId)
        : [...prev, moduleId];
      console.log('新的选中模块:', newSelected);
      return newSelected;
    });
  };

  // 打开新建项目弹窗
  const handleCreateProject = () => {
    console.log('开始创建项目 - 打开弹窗');
    setNewProjectName('');
    setNewProjectDescription('');
    setShowCreateProjectModal(true);
  };

  // 取消新建项目
  const handleCancelCreateProject = () => {
    if (isCreatingProject) return;
    setShowCreateProjectModal(false);
  };

  // 确认创建项目
  const handleConfirmCreateProject = async () => {
    if (!newProjectName.trim()) {
      alert('项目名称不能为空');
      return;
    }

    const projectData = {
      name: newProjectName.trim(),
      description: newProjectDescription.trim(),
    };

    try {
      setIsCreatingProject(true);
      console.log('提交新建项目:', projectData);
      const createdProject = await projectApi.createProject(projectData);
      console.log('创建项目成功:', createdProject);

      // 保存到状态和 localStorage
      setCurrentProject(createdProject);
      localStorage.setItem('currentProject', JSON.stringify(createdProject));
      setShowProjectList(false);
      setShowCreateProjectModal(false);
      // 新项目默认清空已选模块
      setSelectedModules([]);
      alert(`项目 "${createdProject.name}" 创建成功！`);
    } catch (error) {
      console.error('创建项目失败:', error);
      alert('创建项目失败，请检查后端服务是否正常运行');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleShowProjectList = () => {
    console.log('显示项目列表');
    setShowProjectList(true);
    console.log('状态更新: 显示项目列表弹窗');
  };

  const handleBackToProjects = () => {
    console.log('关闭项目列表弹窗，当前项目:', currentProject);
    setShowProjectList(false);
  };

  const handleSelectProject = (project: any) => {
    console.log('选择项目:', project);
    // 选择项目后更新当前项目并关闭弹窗
    setCurrentProject(project);
    localStorage.setItem('currentProject', JSON.stringify(project));
    setShowProjectList(false);
    // 切换项目时可以清空已选模块，避免误操作
    setSelectedModules([]);
    console.log('状态更新: 选择项目并保持在主页');
  };

  const handleStart = () => {
    console.log('开始标注，选中模块:', selectedModules, '当前项目:', currentProject);
    if (!currentProject) {
      alert('请先选择或创建一个项目');
      return;
    }
    if (selectedModules.length === 0) {
      alert('请至少选择一个模块');
      return;
    }
    
    // 存储选择的模块到localStorage
    localStorage.setItem('selectedModules', JSON.stringify(selectedModules));
    console.log('导航到标注页面');
    navigate('/annotate');
  };

  const hasProject = !!currentProject;

  return (
    <div className="landing-page">
      <div className="landing-content">
        <header className="landing-header">
          <h1>智能图像标注系统</h1>
          <p className="subtitle">V1.0</p>

        </header>

        {/* 顶部：项目管理区域（始终展示） */}
        <div className="project-selection">
          <h2>项目管理</h2>
          <p className="hint">
            请先选择或创建一个项目来开始标注工作
          </p>

          <div className="project-actions">
            <div className="project-actions-left">
              <button 
                className="project-action-btn primary"
                onClick={handleCreateProject}
              >
                ➕ 新建项目
              </button>
              <button 
                className="project-action-btn secondary"
                onClick={handleShowProjectList}
              >
                📁 选择项目
              </button>
            </div>

            <div className="current-project-card">
              <div className="current-project-title">当前项目</div>
              {hasProject ? (
                <>
                  <div className="current-project-name">{currentProject.name}</div>
                  <div className="current-project-meta">
                    <span className="current-project-id">ID：{currentProject.id ?? '未提供'}</span>
                  </div>
                </>
              ) : (
                <div className="current-project-empty">暂无项目，请在左侧新建或选择项目</div>
              )}
            </div>
          </div>

          <div className="project-description">
            <p>💡 项目用于组织和管理不同的标注任务</p>
            <p>每个项目可以包含独立的图片集合和标注数据</p>
          </div>
        </div>

        {/* 项目选择列表悬浮弹窗 */}
        {showProjectList && (
          <div className="project-list-overlay">
            <div className="project-list-container">
              <div className="project-list-header">
                <h2>选择项目</h2>
                <button 
                  className="close-project-list-btn"
                  onClick={handleBackToProjects}
                >
                  × 关闭
                </button>
              </div>
              <div className="project-list">
                {projects.length === 0 ? (
                  <div className="no-projects-message">
                    <div className="folder-icon">📁</div>
                    <p>暂无项目</p>
                    <button 
                      className="create-first-project-btn"
                      onClick={handleCreateProject}
                    >
                      ➕ 创建第一个项目
                    </button>
                  </div>
                ) : (
                  <>
                    {/* 列表表头 */}
                    <div className="project-list-header-row">
                      <div className="project-column name">项目名称</div>
                      <div className="project-column id">ID</div>
                      <div className="project-column created">创建时间</div>
                      <div className="project-column updated">更新时间</div>
                    </div>
                    {/* 项目列表 */}
                    {projects.map(project => (
                      <div 
                        key={project.id}
                        className="project-list-row"
                        onClick={() => handleSelectProject(project)}
                      >
                        <div className="project-column name">
                          <div className="project-icon">📁</div>
                          <span>{project.name}</span>
                        </div>
                        <div className="project-column id">{project.id}</div>
                        <div className="project-column created">{new Date(project.created_at).toLocaleString()}</div>
                        <div className="project-column updated">{new Date(project.updated_at).toLocaleString()}</div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 新建项目弹窗 */}
        {showCreateProjectModal && (
          <div className="project-list-overlay">
            <div className="create-project-modal">
              <div className="create-project-header">
                <h2>新建项目</h2>
                <button 
                  className="close-project-list-btn"
                  onClick={handleCancelCreateProject}
                  disabled={isCreatingProject}
                >
                  ×
                </button>
              </div>
              <div className="create-project-body">
                <div className="form-group">
                  <label htmlFor="project-name">项目名称<span className="required">*</span></label>
                  <input
                    id="project-name"
                    type="text"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    placeholder="请输入项目名称"
                    disabled={isCreatingProject}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="project-description">项目描述</label>
                  <textarea
                    id="project-description"
                    value={newProjectDescription}
                    onChange={e => setNewProjectDescription(e.target.value)}
                    placeholder="可选：简单描述该项目的用途或数据来源"
                    disabled={isCreatingProject}
                    rows={3}
                  />
                </div>
              </div>
              <div className="create-project-actions">
                <button 
                  className="create-project-btn secondary"
                  onClick={handleCancelCreateProject}
                  disabled={isCreatingProject}
                >
                  取消
                </button>
                <button 
                  className="create-project-btn primary"
                  onClick={handleConfirmCreateProject}
                  disabled={isCreatingProject || !newProjectName.trim()}
                >
                  {isCreatingProject ? '创建中...' : '创建项目'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 模块选择区域（始终展示，但依赖是否已选择项目） */}
        <div className="module-selection">
          <h2>请选择本次标注任务需要的模块</h2>
          <p className="hint">
            可以根据需要选择多个模块，选定后将锁定功能页面
            {!hasProject && '（当前未选择项目，请先在上方选择或创建项目）'}
          </p>
          
          <div className={`modules-grid ${!hasProject ? 'disabled' : ''}`}>
            {availableModules.map(module => (
              <div 
                key={module.id}
                className={`module-card ${selectedModules.includes(module.id) ? 'selected' : ''} ${module.disabled || !hasProject ? 'disabled' : ''}`}
                onClick={() => hasProject && !module.disabled && handleModuleToggle(module.id)}
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

        {/* 9D Pose 提示 */}
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

        {/* 底部操作按钮 */}
        <div className="actions">
          <button 
            className="start-button"
            onClick={handleStart}
            disabled={!hasProject || selectedModules.length === 0}
          >
            开始标注工作 →
          </button>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;