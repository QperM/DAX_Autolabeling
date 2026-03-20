const express = require('express');

function registerAuthRoutes(app, { db, bcrypt, requireAdmin, DEFAULT_ADMIN_USERNAME }) {
  const router = express.Router();

  // 验证码验证
  router.post('/verify-code', async (req, res) => {
    try {
      const { accessCode } = req.body;
      if (!accessCode || typeof accessCode !== 'string') {
        return res.status(400).json({ error: '验证码不能为空' });
      }

      const project = await db.getProjectByAccessCode(accessCode.trim().toUpperCase());
      if (!project) {
        return res.status(404).json({ error: '验证码无效' });
      }

      // 检查项目是否锁定（非管理员无法访问锁定的项目）
      if (project.locked && !(req.session && req.session.isAdmin)) {
        return res.status(403).json({ error: '项目已锁定，请联系管理员' });
      }

      // 记录 session 访问权限
      const sessionId = req.sessionID;
      await db.grantProjectAccess(sessionId, project.id);

      // 标记 session 已初始化，确保 cookie 被发送（saveUninitialized: false 需要 session 被修改才会保存）
      if (!req.session.accessibleProjectIds) {
        req.session.accessibleProjectIds = [];
      }
      if (!req.session.accessibleProjectIds.includes(project.id)) {
        req.session.accessibleProjectIds.push(project.id);
      }

      return res.json({
        success: true,
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
        },
      });
    } catch (error) {
      console.error('[验证码验证] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  // 管理员登录
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
      }
      // 只允许统一配置的管理员账号登录
      if (username !== DEFAULT_ADMIN_USERNAME) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      const user = await db.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      // 设置 session
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = true;

      return res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      });
    } catch (error) {
      console.error('[管理员登录] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  // 修改管理员密码（管理员已登录）
  router.post('/change-password', requireAdmin, async (req, res) => {
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body || {};

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: '请填写当前密码、新密码与确认密码' });
      }
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
        return res.status(400).json({ error: '密码格式不正确' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: '两次输入的新密码不一致' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: '新密码至少 8 位' });
      }

      const username = req.session?.username;
      if (!username) {
        return res.status(401).json({ error: '未登录' });
      }

      const user = await db.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ error: '用户不存在' });
      }

      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: '当前密码不正确' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const changed = await db.updateUserPassword(user.id, passwordHash);
      if (!changed) {
        return res.status(500).json({ error: '密码更新失败' });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('[修改管理员密码] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  // 登出
  router.post('/logout', (req, res) => {
    const sessionId = req.sessionID;
    req.session.destroy(async (err) => {
      if (err) {
        console.error('[登出] 销毁session失败:', err);
        return res.status(500).json({ error: '登出失败' });
      }

      // 清除项目访问权限
      await db.clearSessionAccess(sessionId);
      return res.json({ success: true });
    });
  });

  // 检查当前登录状态
  router.get('/check', (req, res) => {
    if (req.session && req.session.userId) {
      return res.json({
        authenticated: true,
        isAdmin: req.session.isAdmin || false,
        user: {
          id: req.session.userId,
          username: req.session.username,
        },
      });
    }

    if (req.session && req.session.accessibleProjectIds && req.session.accessibleProjectIds.length > 0) {
      return res.json({
        authenticated: true,
        isAdmin: false,
        accessibleProjectIds: req.session.accessibleProjectIds,
      });
    }

    return res.json({ authenticated: false });
  });

  // 获取当前session可访问的项目列表
  router.get('/accessible-projects', async (req, res) => {
    try {
      const sessionId = req.sessionID;
      const projects = await db.getAccessibleProjects(sessionId);
      const formattedProjects = projects.map((p) => ({
        ...p,
        locked: p.locked === 1 || p.locked === true,
      }));
      return res.json(formattedProjects);
    } catch (error) {
      console.error('[获取可访问项目] 错误:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.use('/api/auth', router);
}

module.exports = { registerAuthRoutes };

