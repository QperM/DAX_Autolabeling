const express = require('express');

function registerProjectRoutes(app, { db, requireAdmin, requireProjectAccess, generateAccessCode }) {
  const router = express.Router();
  const admin = express.Router();

  // ========== 管理员专用：项目 ==========
  admin.get('/projects', requireAdmin, async (req, res) => {
    try {
      const projects = await db.getAllProjects();
      const formattedProjects = projects.map((p) => ({
        ...p,
        locked: p.locked === 1 || p.locked === true,
      }));
      return res.json(formattedProjects);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  admin.post('/projects', requireAdmin, async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: '项目名称不能为空' });
      }

      // 生成唯一验证码
      let accessCode;
      let attempts = 0;
      do {
        accessCode = generateAccessCode();
        const existing = await db.getProjectByAccessCode(accessCode);
        if (!existing) break;
        attempts++;
        if (attempts > 10) {
          return res.status(500).json({ error: '生成验证码失败，请重试' });
        }
      } while (true);

      const project = await db.createProject(name.trim(), description || '', accessCode);
      return res.json(project);
    } catch (error) {
      console.error('[创建项目] 错误:', error);
      if (error.message && error.message.includes('UNIQUE constraint')) {
        return res.status(400).json({ error: '项目名称已存在' });
      }
      return res.status(500).json({ error: error.message });
    }
  });

  // 锁定/解锁项目
  admin.post('/projects/:id/toggle-lock', requireAdmin, async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) {
        return res.status(400).json({ error: '无效的项目ID' });
      }

      const project = await db.getProjectById(projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const newLocked = !project.locked;
      const updatedProject = await db.toggleProjectLock(projectId, newLocked);
      const formattedProject = {
        ...updatedProject,
        locked: updatedProject.locked === 1 || updatedProject.locked === true,
      };

      return res.json(formattedProject);
    } catch (error) {
      console.error('[锁定/解锁项目] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  // 重新生成项目验证码
  admin.post('/projects/:id/regenerate-code', requireAdmin, async (req, res) => {
    try {
      const projectId = req.params.id;

      let accessCode;
      let attempts = 0;
      do {
        accessCode = generateAccessCode();
        const existing = await db.getProjectByAccessCode(accessCode);
        if (!existing || existing.id === parseInt(projectId)) break;
        attempts++;
        if (attempts > 10) {
          return res.status(500).json({ error: '生成验证码失败，请重试' });
        }
      } while (true);

      const project = await db.updateProjectAccessCode(projectId, accessCode);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      return res.json(project);
    } catch (error) {
      console.error('[重新生成验证码] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ========== 普通项目接口 ==========
  router.get('/', async (req, res) => {
    try {
      let projects;
      if (req.session && req.session.isAdmin) {
        projects = await db.getAllProjects();
      } else {
        const sessionId = req.sessionID;
        projects = await db.getAccessibleProjects(sessionId);
      }

      const formattedProjects = projects.map((p) => ({
        ...p,
        locked: p.locked === 1 || p.locked === true,
      }));

      return res.json(formattedProjects);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id', requireProjectAccess, async (req, res) => {
    try {
      const project = await db.getProjectById(req.params.id);
      if (!project) return res.status(404).json({ error: '项目不存在' });

      if (!req.session || !req.session.isAdmin) {
        delete project.access_code;
      }
      return res.json(project);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', requireProjectAccess, async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!req.session || !req.session.isAdmin) {
        const project = await db.getProjectById(req.params.id);
        if (!project) return res.status(404).json({ error: '项目不存在' });
        const updated = await db.updateProject(req.params.id, project.name, description || project.description);
        return res.json(updated);
      }
      const project = await db.updateProject(req.params.id, name, description);
      return res.json(project);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    try {
      const projectId = req.params.id;
      db.deleteProjectWithRelated(projectId, (err, changes) => {
        if (err) {
          return res.status(500).json({ error: err.message || '删除项目失败' });
        }
        return res.json({ message: '项目及相关数据删除成功', changes });
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id/annotation-summary', (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) {
        return res.status(400).json({
          success: false,
          message: '无效的项目ID',
        });
      }

      db.getProjectAnnotationSummary(projectId, (err, summary) => {
        if (err) {
          console.error('获取项目标注汇总失败:', err);
          return res.status(500).json({
            success: false,
            message: '获取项目标注汇总失败',
            error: err.message,
          });
        }

        return res.json({
          success: true,
          summary,
        });
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: '获取项目标注汇总失败',
        error: error.message,
      });
    }
  });

  app.use('/api/admin', admin);
  app.use('/api/projects', router);
}

module.exports = { registerProjectRoutes };

