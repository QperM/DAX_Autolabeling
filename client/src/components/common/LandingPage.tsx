import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectApi, authApi, adminApi } from '../../services/api';
import {
  clearStoredCurrentProject,
  clearStoredSelectedModules,
  getStoredCurrentProject,
  getStoredSelectedModules,
  setStoredCurrentProject,
  setStoredSelectedModules,
} from '../../tabStorage';
import './LandingPage.css';

async function copyToClipboard(text: string): Promise<boolean> {
  // Prefer modern Clipboard API when available (requires secure context in most browsers).
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy fallback.
  }

  // Legacy fallback: hidden textarea + execCommand('copy')
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const LandingPage: React.FC = () => {
  // 认证状态
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ id: number; username: string } | null>(null);
  
  // 验证码输入
  const [showAccessCodeModal, setShowAccessCodeModal] = useState(true);
  const [accessCode, setAccessCode] = useState('');
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [codeError, setCodeError] = useState('');
  
  // 管理员登录
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');

  // 管理员：重设密码
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [resetPasswordError, setResetPasswordError] = useState('');
  
  // 管理员面板
  
  // 选中的功能模块
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  // 当前选择的项目
  const [currentProject, setCurrentProject] = useState<any>(null);
  // 项目列表（用于弹出的项目选择列表）
  const [projects, setProjects] = useState<any[]>([]);
  // 是否显示项目列表弹窗
  const [showProjectList, setShowProjectList] = useState(false);
  // 是否显示项目描述弹窗
  const [showDescriptionModal, setShowDescriptionModal] = useState(false);
  const [descriptionModalProjectId, setDescriptionModalProjectId] = useState<number | null>(null);
  const [descriptionModalTitle, setDescriptionModalTitle] = useState('');
  const [descriptionModalContent, setDescriptionModalContent] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  // 是否显示“新建项目”弹窗
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  // 新建项目表单
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  // 删除项目时的加载状态
  const [deletingProjectId, setDeletingProjectId] = useState<number | null>(null);
  // 锁定/解锁项目时的加载状态
  const [togglingLockProjectId, setTogglingLockProjectId] = useState<number | null>(null);
  const navigate = useNavigate();

  // 初始化：检查登录状态和加载项目
  useEffect(() => {
    const initialize = async () => {
      // 检查登录状态
      try {
        const authStatus = await authApi.checkAuth();
        const userIsAdmin = authStatus.isAdmin || false;
        setIsAuthenticated(authStatus.authenticated);
        setIsAdmin(userIsAdmin);
        if (authStatus.user) {
          setCurrentUser(authStatus.user);
        }
        
        // 如果已登录（管理员或通过验证码），加载项目列表
        if (authStatus.authenticated) {
          setShowAccessCodeModal(false);
          
          // 加载项目列表（使用从API返回的isAdmin状态，而不是state中的isAdmin）
          try {
            const projectsList = userIsAdmin 
              ? await adminApi.getAllProjects()
              : await authApi.getAccessibleProjects();
            setProjects(projectsList);

            const savedModules = getStoredSelectedModules();
            if (savedModules.length > 0) {
              setSelectedModules(savedModules);
            }
            
            // 尝试从当前标签页的 sessionStorage 恢复当前项目
            const savedProject = getStoredCurrentProject<any>();
      if (savedProject) {
        try {
                const project = savedProject;
                // 验证项目是否在可访问列表中
                if (projectsList.some(p => p.id === project.id)) {
          setCurrentProject(project);
          console.log('自动加载保存的项目:', project.name);
                } else {
                  clearStoredCurrentProject();
                }
        } catch (e) {
          console.error('解析保存的项目失败', e);
                clearStoredCurrentProject();
        }
      }
          } catch (error: any) {
        console.error('加载项目列表失败', error);
            if (error.response?.status === 403) {
              // 权限不足，需要重新输入验证码
              setIsAuthenticated(false);
              setShowAccessCodeModal(true);
            }
        setProjects([]);
          }
        } else {
          // 未登录，显示验证码输入界面
          setShowAccessCodeModal(true);
        }
      } catch (error) {
        console.error('检查登录状态失败', error);
        setShowAccessCodeModal(true);
      }
    };

    initialize();
  }, []);
  
  // 验证码验证
  const handleVerifyCode = async () => {
    if (!accessCode.trim()) {
      setCodeError('请输入验证码');
      return;
    }
    
    setVerifyingCode(true);
    setCodeError('');
    
    try {
      const result = await authApi.verifyCode(accessCode.trim().toUpperCase());
      
      if (result.success) {
        setCurrentProject(result.project);
        setStoredCurrentProject(result.project);
        setShowAccessCodeModal(false);
        setIsAuthenticated(true);
        
        // 重新加载项目列表
        const projectsList = await authApi.getAccessibleProjects();
        setProjects(projectsList);
      }
    } catch (error: any) {
      console.error('验证码验证失败', error);
      // 检查是否是项目锁定错误
      if (error.response?.status === 403 && error.response?.data?.error?.includes('锁定')) {
        setCodeError('项目已锁定，请联系管理员');
      } else {
        setCodeError(error.response?.data?.error || '验证码无效，请重试');
      }
    } finally {
      setVerifyingCode(false);
    }
  };
  
  // 管理员登录
  const handleAdminLogin = async () => {
    if (!adminUsername.trim() || !adminPassword.trim()) {
      setLoginError('请输入用户名和密码');
      return;
    }
    
    try {
      setLoggingIn(true);
      setLoginError('');
      const result = await authApi.login(adminUsername.trim(), adminPassword);
      
      if (result.success) {
        setIsAuthenticated(true);
        setIsAdmin(true);
        setCurrentUser(result.user);
        setShowAdminLogin(false);
        setShowAccessCodeModal(false);
        
        // 加载所有项目（管理员）
        const projectsList = await adminApi.getAllProjects();
        setProjects(projectsList);
      }
    } catch (error: any) {
      console.error('管理员登录失败', error);
      setLoginError(error.response?.data?.error || '登录失败，请检查用户名和密码');
    } finally {
      setLoggingIn(false);
    }
  };
  
  // 登出
  const handleLogout = async () => {
    try {
      await authApi.logout();
      setIsAuthenticated(false);
      setIsAdmin(false);
      setCurrentUser(null);
      setCurrentProject(null);
      setProjects([]);
      clearStoredCurrentProject();
      clearStoredSelectedModules();
      setShowAccessCodeModal(true);
    } catch (error) {
      console.error('登出失败', error);
    }
  };

  const handleOpenResetPassword = () => {
    setCurrentPasswordInput('');
    setNewPasswordInput('');
    setConfirmPasswordInput('');
    setResetPasswordError('');
    setShowResetPasswordModal(true);
  };

  const handleChangePassword = async () => {
    if (!currentPasswordInput || !newPasswordInput || !confirmPasswordInput) {
      setResetPasswordError('请填写当前密码、新密码与确认密码');
      return;
    }
    if (newPasswordInput !== confirmPasswordInput) {
      setResetPasswordError('两次输入的新密码不一致');
      return;
    }
    if (newPasswordInput.length < 8) {
      setResetPasswordError('新密码至少 8 位');
      return;
    }

    try {
      setResettingPassword(true);
      setResetPasswordError('');
      await authApi.changePassword(currentPasswordInput, newPasswordInput, confirmPasswordInput);
      setShowResetPasswordModal(false);
      alert('密码已更新');
    } catch (error: any) {
      console.error('修改密码失败', error);
      setResetPasswordError(error.response?.data?.error || '修改密码失败，请稍后重试');
    } finally {
      setResettingPassword(false);
    }
  };

  const availableModules = [
    { id: '2d-bbox-mask', name: '2D Bbox/Mask 标注', description: '基础的2D边界框和Mask标注功能', disabled: false },
    { id: '9d-pose', name: '9D Pose 标注', description: '3D姿态标注（开发中）', disabled: false },
  ];

  const handleModuleToggle = (moduleId: string) => {
    console.log('切换模块:', moduleId);
    // 单选：同一时间只能选中一个模块，避免组合模块导致流程/路由混乱
    setSelectedModules((prev) => {
      const newSelected = prev.includes(moduleId) ? [] : [moduleId];
      console.log('新的选中模块(单选):', newSelected);
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

  // 确认创建项目（仅管理员）
  const handleConfirmCreateProject = async () => {
    if (!newProjectName.trim()) {
      alert('项目名称不能为空');
      return;
    }
    
    if (!isAdmin) {
      alert('只有管理员可以创建项目');
      return;
    }

    const projectData = {
      name: newProjectName.trim(),
      description: newProjectDescription.trim(),
    };

    try {
      setIsCreatingProject(true);
      console.log('提交新建项目:', projectData);
      const createdProject = await adminApi.createProject(projectData);
      console.log('创建项目成功:', createdProject);

      // 保存到状态和 localStorage
      setCurrentProject(createdProject);
      setStoredCurrentProject(createdProject);
      setShowProjectList(false);
      setShowCreateProjectModal(false);
      // 新项目默认清空已选模块
      setSelectedModules([]);
      clearStoredSelectedModules();
      
      // 重新加载项目列表
      const projectsList = await adminApi.getAllProjects();
      setProjects(projectsList);
      
      alert(`项目 "${createdProject.name}" 创建成功！\n验证码: ${createdProject.access_code}`);
    } catch (error: any) {
      console.error('创建项目失败:', error);
      alert(error.response?.data?.error || '创建项目失败，请检查后端服务是否正常运行');
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
    setStoredCurrentProject(project);
    setShowProjectList(false);
    // 切换项目时可以清空已选模块，避免误操作
    setSelectedModules([]);
    clearStoredSelectedModules();
    console.log('状态更新: 选择项目并保持在主页');
  };

  // 查看项目描述
  const handleShowProjectDescription = (project: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setDescriptionModalProjectId(project.id);
    setDescriptionModalTitle(project.name || `项目 ${project.id}`);
    setDescriptionModalContent(project.description || '暂无描述');
    setShowDescriptionModal(true);
  };

  // 保存项目描述（管理员）
  const handleSaveProjectDescription = async () => {
    if (!isAdmin || descriptionModalProjectId == null) return;

    try {
      setSavingDescription(true);
      // 找到当前要更新的项目，确保同时携带 name，避免后端 name 变为 null/undefined
      const targetProject =
        projects.find(p => p.id === descriptionModalProjectId) ||
        (currentProject && currentProject.id === descriptionModalProjectId ? currentProject : null);

      const updatedProject = await projectApi.updateProject(descriptionModalProjectId, {
        name: targetProject?.name,
        description: descriptionModalContent,
      });

      // 更新项目列表
      setProjects(prev =>
        prev.map(p => (p.id === updatedProject.id ? { ...p, ...updatedProject } : p)),
      );

      // 如果当前项目是这个项目，同步更新
      if (currentProject && currentProject.id === updatedProject.id) {
        setCurrentProject({ ...currentProject, ...updatedProject });
        setStoredCurrentProject({ ...currentProject, ...updatedProject });
      }

      alert('项目描述已更新');
    } catch (error) {
      console.error('更新项目描述失败:', error);
      alert('更新项目描述失败，请稍后重试或检查后端服务');
    } finally {
      setSavingDescription(false);
    }
  };

  // 锁定/解锁项目
  const handleToggleProjectLock = async (project: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (togglingLockProjectId !== null) return;

    const action = project.locked ? '解锁' : '锁定';
    const confirmed = window.confirm(`确定要${action}项目 "${project.name}" 吗？${project.locked ? '解锁后，用户可以通过验证码访问该项目。' : '锁定后，只有管理员可以访问该项目，普通用户输入验证码后将无法访问。'}`);
    if (!confirmed) return;

    try {
      setTogglingLockProjectId(project.id);
      const updatedProject = await adminApi.toggleProjectLock(project.id);

      // 更新项目列表中的项目状态，保留原有项目的所有字段，只更新 locked 字段
      setProjects(prev => prev.map(p => {
        if (p.id === project.id) {
          // 保留原有项目的所有字段，只更新返回的字段
          return { ...p, ...updatedProject };
        }
        return p;
      }));

      // 如果当前项目被锁定/解锁，更新当前项目状态
      if (currentProject && currentProject.id === project.id) {
        setCurrentProject({ ...currentProject, ...updatedProject });
        setStoredCurrentProject({ ...currentProject, ...updatedProject });
      }

      alert(`项目 "${project.name}" 已${action}`);
    } catch (error) {
      console.error(`${action}项目失败:`, error);
      alert(`${action}项目失败，请检查后端服务是否正常运行`);
    } finally {
      setTogglingLockProjectId(null);
    }
  };

  // 删除项目
  const handleDeleteProject = async (project: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingProjectId !== null) return;

    const confirmed = window.confirm(`确定要删除项目 "${project.name}" 以及其相关数据吗？该操作不可恢复！`);
    if (!confirmed) return;

    try {
      setDeletingProjectId(project.id);
      await projectApi.deleteProject(project.id);

      // 从项目列表中移除
      setProjects(prev => prev.filter(p => p.id !== project.id));

      // 如果当前项目被删除，清空当前项目和模块选择
      if (currentProject && currentProject.id === project.id) {
        setCurrentProject(null);
        clearStoredCurrentProject();
        setSelectedModules([]);
        clearStoredSelectedModules();
      }

      alert(`项目 "${project.name}" 已删除`);
    } catch (error) {
      console.error('删除项目失败:', error);
      alert('删除项目失败，请检查后端服务是否正常运行');
    } finally {
      setDeletingProjectId(null);
    }
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
    
    if (!isAuthenticated) {
      alert('请先输入验证码或登录');
      return;
    }
    
    // 存储选择的模块到当前标签页
    setStoredSelectedModules(selectedModules);
    console.log('导航到标注页面');
    // 模块路由分发：
    // - 仅选 9D Pose：进入 pose 页面
    // - 其他情况：默认进入 2D 标注页面（后续可扩展为模块组合工作流）
    const onlyPose = selectedModules.length === 1 && selectedModules[0] === '9d-pose';
    navigate(onlyPose ? '/pose' : '/annotate');
  };
  
  // 重新生成项目验证码（管理员）
  const handleRegenerateCode = async (projectId: number) => {
    if (!isAdmin) return;
    
    const confirmed = window.confirm('确定要重新生成验证码吗？旧的验证码将失效！');
    if (!confirmed) return;
    
    try {
      const updatedProject = await adminApi.regenerateAccessCode(projectId);
      // 更新项目列表
      const projectsList = await adminApi.getAllProjects();
      setProjects(projectsList);
      
      // 如果当前项目被更新，更新当前项目
      if (currentProject && currentProject.id === projectId) {
        setCurrentProject(updatedProject);
        setStoredCurrentProject(updatedProject);
      }
      
      alert(`验证码已重新生成: ${updatedProject.access_code}`);
    } catch (error: any) {
      console.error('重新生成验证码失败', error);
      alert(error.response?.data?.error || '重新生成验证码失败');
    }
  };

  const hasProject = !!currentProject;

  return (
    <div className="landing-page">
      {/* 验证码输入弹窗 */}
      {showAccessCodeModal && !isAuthenticated && (
        <div className="access-code-overlay">
          <div className="access-code-modal">
            <div className="access-code-header">
              <h2>项目访问验证</h2>
              <p className="access-code-hint">请输入项目验证码以访问标注系统</p>
            </div>
            <div className="access-code-body">
              <input
                type="text"
                className="access-code-input code-input"
                placeholder="请输入6位验证码"
                value={accessCode}
                onChange={(e) => {
                  setAccessCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  setCodeError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !verifyingCode) {
                    handleVerifyCode();
                  }
                }}
                maxLength={6}
                disabled={verifyingCode}
                autoFocus
              />
              {codeError && <div className="access-code-error">{codeError}</div>}
            </div>
            <div className="access-code-actions">
              <button
                className="access-code-btn primary"
                onClick={handleVerifyCode}
                disabled={verifyingCode || !accessCode.trim()}
              >
                {verifyingCode ? '验证中...' : '确认'}
              </button>
              <button
                className="access-code-btn secondary"
                onClick={() => setShowAdminLogin(true)}
                disabled={verifyingCode}
              >
                管理员登录
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 管理员登录弹窗 */}
      {showAdminLogin && (
        <div className="access-code-overlay">
          <div className="access-code-modal">
            <div className="access-code-header">
              <h2>管理员登录</h2>
            </div>
            <div className="access-code-body">
              <div className="form-group">
                <label>用户名</label>
                <input
                  type="text"
                  className="access-code-input"
                  placeholder="请输入用户名"
                  value={adminUsername}
                  onChange={(e) => {
                    setAdminUsername(e.target.value);
                    setLoginError('');
                  }}
                  disabled={loggingIn}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>密码</label>
                <input
                  type="password"
                  className="access-code-input"
                  placeholder="请输入密码"
                  value={adminPassword}
                  onChange={(e) => {
                    setAdminPassword(e.target.value);
                    setLoginError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !loggingIn) {
                      handleAdminLogin();
                    }
                  }}
                  disabled={loggingIn}
                />
              </div>
              {loginError && <div className="access-code-error">{loginError}</div>}
            </div>
            <div className="access-code-actions">
              <button
                className="access-code-btn primary"
                onClick={handleAdminLogin}
                disabled={loggingIn || !adminUsername.trim() || !adminPassword.trim()}
              >
                {loggingIn ? '登录中...' : '登录'}
              </button>
              <button
                className="access-code-btn secondary"
                onClick={() => {
                  setShowAdminLogin(false);
                  setLoginError('');
                }}
                disabled={loggingIn}
              >
                返回
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 管理员重设密码弹窗 */}
      {showResetPasswordModal && (
        <div className="access-code-overlay">
          <div className="access-code-modal">
            <div className="access-code-header">
              <h2>重设密码</h2>
              <p className="access-code-hint">请输入当前密码并设置新密码（需两次确认）</p>
            </div>
            <div className="access-code-body">
              <div className="form-group">
                <label>当前密码</label>
                <input
                  type="password"
                  className="access-code-input"
                  placeholder="请输入当前密码"
                  value={currentPasswordInput}
                  onChange={(e) => {
                    setCurrentPasswordInput(e.target.value);
                    setResetPasswordError('');
                  }}
                  disabled={resettingPassword}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>新密码</label>
                <input
                  type="password"
                  className="access-code-input"
                  placeholder="至少8位"
                  value={newPasswordInput}
                  onChange={(e) => {
                    setNewPasswordInput(e.target.value);
                    setResetPasswordError('');
                  }}
                  disabled={resettingPassword}
                />
              </div>
              <div className="form-group">
                <label>确认新密码</label>
                <input
                  type="password"
                  className="access-code-input"
                  placeholder="请再次输入新密码"
                  value={confirmPasswordInput}
                  onChange={(e) => {
                    setConfirmPasswordInput(e.target.value);
                    setResetPasswordError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !resettingPassword) {
                      handleChangePassword();
                    }
                  }}
                  disabled={resettingPassword}
                />
              </div>
              {resetPasswordError && <div className="access-code-error">{resetPasswordError}</div>}
            </div>
            <div className="access-code-actions">
              <button
                className="access-code-btn primary"
                onClick={handleChangePassword}
                disabled={
                  resettingPassword ||
                  !currentPasswordInput ||
                  !newPasswordInput ||
                  !confirmPasswordInput
                }
              >
                {resettingPassword ? '提交中...' : '确认修改'}
              </button>
              <button
                className="access-code-btn secondary"
                onClick={() => {
                  if (resettingPassword) return;
                  setShowResetPasswordModal(false);
                  setResetPasswordError('');
                }}
                disabled={resettingPassword}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="landing-content">
        <header className="landing-header">
          <h1>智能图像标注系统</h1>
          <p className="subtitle">V2.1</p>
        </header>

        {/* 顶部：项目管理区域（始终展示） */}
        <div className="project-selection">
          <div className="project-selection-header">
          <h2>项目管理</h2>
            {isAuthenticated && (
              <div className="project-selection-header-right">
                <div className="user-info">
                  {isAdmin && (
                    <button
                      type="button"
                      className="admin-badge admin-badge-btn"
                      onClick={handleOpenResetPassword}
                      title="重设管理员密码"
                    >
                      管理员
                    </button>
                  )}
                  {currentUser && <span className="username">{currentUser.username}</span>}
                </div>
                <button className="logout-btn" onClick={handleLogout}>
                  登出
                </button>
              </div>
            )}
          </div>
          <p className="hint">
            请先选择或创建一个项目来开始标注工作
          </p>

          <div className="project-actions">
            <div className="project-actions-left">
              {isAdmin && (
                <>
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
                </>
              )}
              {!isAdmin && (
                <div className="project-description-input-container">
                  <label className="project-description-label">项目描述</label>
                  <textarea
                    className="project-description-textarea"
                    value={currentProject?.description || ''}
                    readOnly
                    placeholder="暂无项目描述"
                  />
                </div>
              )}
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
                    <div className={`project-list-header-row ${isAdmin ? 'with-code' : ''}`}>
                      <div className="project-column id">ID</div>
                      <div className="project-column name">项目名称</div>
                      <div className="project-column description">描述</div>
                      {isAdmin && <div className="project-column access-code">验证码</div>}
                      <div className="project-column created">创建时间</div>
                      <div className="project-column updated">更新时间</div>
                      <div className="project-column actions">操作</div>
                    </div>
                    {/* 项目列表 */}
                    {projects.map(project => (
                      <div 
                        key={project.id}
                        className={`project-list-row ${isAdmin ? 'with-code' : ''}`}
                        onClick={() => handleSelectProject(project)}
                      >
                        <div className="project-column id">{project.id}</div>
                        <div className="project-column name">
                          <div className="project-icon">📁</div>
                          <span>{project.name}</span>
                        </div>
                        <div className="project-column description">
                          <button
                            className="project-desc-btn"
                            onClick={(e) => handleShowProjectDescription(project, e)}
                          >
                            查看描述
                          </button>
                        </div>
                        {isAdmin && (
                          <div className="project-column access-code">
                            <code className="access-code-display">{project.access_code || '未生成'}</code>
                            {project.access_code && (
                              <>
                                <button
                                  className="copy-code-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const btn = e.currentTarget as HTMLButtonElement;
                                    copyToClipboard(project.access_code).then((ok) => {
                                      if (ok) {
                                        btn.textContent = '✅';
                                      } else {
                                        btn.textContent = '❌';
                                        // Most common reason: non-secure context (http) blocks Clipboard API.
                                        console.warn('[copy] Clipboard unavailable. If this is an http site, consider using https.');
                                      }
                                      setTimeout(() => { btn.textContent = '📋'; }, 1500);
                                    });
                                  }}
                                  title="复制验证码"
                                >
                                  📋
                                </button>
                                <button
                                  className="regenerate-code-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRegenerateCode(project.id);
                                  }}
                                  title="重新生成验证码"
                                >
                                  🔄
                                </button>
                              </>
                            )}
                          </div>
                        )}
                        <div className="project-column created">{new Date(project.created_at).toLocaleString()}</div>
                        <div className="project-column updated">{new Date(project.updated_at).toLocaleString()}</div>
                        <div className="project-column actions">
                          {isAdmin && (
                            <>
                              <button
                                className="project-lock-btn"
                                onClick={(e) => handleToggleProjectLock(project, e)}
                                disabled={togglingLockProjectId === project.id}
                                title={project.locked ? '解锁项目' : '锁定项目'}
                              >
                                {togglingLockProjectId === project.id 
                                  ? (project.locked ? '解锁中...' : '锁定中...')
                                  : (project.locked ? '🔒' : '🔓')}
                              </button>
                              <button
                                className="project-delete-btn"
                                onClick={(e) => handleDeleteProject(project, e)}
                                disabled={deletingProjectId === project.id}
                              >
                                {deletingProjectId === project.id ? '删除中...' : '删除'}
                              </button>
                            </>
                          )}
                        </div>
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

      {/* 项目描述弹窗 */}
      {showDescriptionModal && (
        <div className="description-modal-overlay">
          <div className="description-modal">
            <div className="description-modal-header">
              <h3>项目描述：{descriptionModalTitle}</h3>
              <button
                className="close-description-btn"
                onClick={() => setShowDescriptionModal(false)}
              >
                ×
              </button>
            </div>
            <div className="description-modal-body">
              <textarea
                className="description-textarea"
                readOnly={!isAdmin}
                value={descriptionModalContent}
                onChange={isAdmin ? (e) => setDescriptionModalContent(e.target.value) : undefined}
              />
            </div>
            <div className="description-modal-footer">
              {isAdmin && (
                <button
                  className="description-save-btn"
                  onClick={handleSaveProjectDescription}
                  disabled={savingDescription}
                >
                  {savingDescription ? '保存中...' : '保存'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
};

export default LandingPage;