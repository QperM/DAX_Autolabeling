const express = require('express');
const { debugLog } = require('../utils/debugSettingsStore');

function registerProjectSessionRoutes(app, { db, projectSessionGuard }) {
  const router = express.Router();

  const requireAuthLike = (req, res, next) => {
    if (req.session?.isAdmin) return next();
    if (req.session?.userId) return next();
    if (Array.isArray(req.session?.accessibleProjectIds) && req.session.accessibleProjectIds.length > 0) return next();
    return res.status(401).json({ success: false, error: '未认证会话' });
  };

  const checkProjectLifecycle = async (req, projectId) => {
    const project = await db.getProjectById(projectId);
    if (!project) {
      return {
        ok: false,
        status: 404,
        body: {
          success: false,
          code: 'PROJECT_DELETED',
          message: '项目不存在或已删除，当前连接已断开。',
          disconnect: true,
        },
      };
    }
    // 项目被锁：直接断开（管理员除外）
    if (project.locked && !req.session?.isAdmin) {
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          code: 'PROJECT_LOCKED',
          message: '项目已被管理员锁定，当前连接已断开。',
          disconnect: true,
        },
      };
    }
    return { ok: true, project };
  };

  router.post('/claim', requireAuthLike, async (req, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      debugLog('node', 'nodeProjectSessionGuard', '[POST /project-session/claim] received', {
        sessionId: String(req.sessionID || ''),
        projectId,
        isAdmin: !!req.session?.isAdmin,
      });
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }
      const life = await checkProjectLifecycle(req, projectId);
      if (!life.ok) return res.status(life.status).json(life.body);

      if (!req.session?.isAdmin) {
        const hasAccess = await db.hasProjectAccess(req.sessionID, projectId);
        if (!hasAccess) {
          return res.status(403).json({ success: false, message: '没有访问该项目的权限，请先输入验证码' });
        }
      }

      const r = projectSessionGuard.claim({ sessionId: req.sessionID, projectId });
      if (!r?.ok) {
        debugLog('node', 'nodeProjectSessionGuard', '[POST /project-session/claim] failed', {
          sessionId: String(req.sessionID || ''),
          projectId,
          code: r?.code,
          message: r?.message,
        });
        return res.status(400).json({ success: false, code: r?.code, message: r?.message || '会话声明失败' });
      }
      debugLog('node', 'nodeProjectSessionGuard', '[POST /project-session/claim] success', {
        sessionId: String(req.sessionID || ''),
        projectId,
      });
      return res.json({ success: true, projectId, controlled: true });
    } catch (error) {
      return res.status(500).json({ success: false, message: error?.message || String(error) });
    }
  });

  router.get('/status', requireAuthLike, async (req, res) => {
    try {
      const projectId = Number(req.query?.projectId);
      debugLog('node', 'nodeProjectSessionGuard', '[GET /project-session/status] received', {
        sessionId: String(req.sessionID || ''),
        projectId,
        isAdmin: !!req.session?.isAdmin,
      });
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }
      const life = await checkProjectLifecycle(req, projectId);
      if (!life.ok) return res.status(life.status).json(life.body);

      if (!req.session?.isAdmin) {
        const hasAccess = await db.hasProjectAccess(req.sessionID, projectId);
        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            code: 'PROJECT_ACCESS_REVOKED',
            message: '项目访问权限已失效，当前连接已断开。',
            disconnect: true,
          });
        }
      }

      const guardResult = projectSessionGuard.check({ sessionId: req.sessionID, projectId });
      if (!guardResult?.ok) {
        debugLog('node', 'nodeProjectSessionGuard', '[GET /project-session/status] conflict', {
          sessionId: String(req.sessionID || ''),
          projectId,
          code: guardResult?.code || 'PROJECT_CONTROL_TAKEN',
          message: guardResult?.message,
        });
        return res.status(409).json({
          success: false,
          code: guardResult?.code || 'PROJECT_CONTROL_TAKEN',
          message: guardResult?.message || '有其他人操作此项目了，当前连接已断开。',
          disconnect: true,
        });
      }

      // 保活：状态检查成功时更新当前会话为控制方（幂等）
      projectSessionGuard.claim({ sessionId: req.sessionID, projectId });
      debugLog('node', 'nodeProjectSessionGuard', '[GET /project-session/status] success', {
        sessionId: String(req.sessionID || ''),
        projectId,
      });
      return res.json({ success: true, projectId, controlled: true });
    } catch (error) {
      return res.status(500).json({ success: false, message: error?.message || String(error) });
    }
  });

  router.post('/release', requireAuthLike, async (req, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      debugLog('node', 'nodeProjectSessionGuard', '[POST /project-session/release] received', {
        sessionId: String(req.sessionID || ''),
        projectId,
      });
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }
      projectSessionGuard.release({ sessionId: req.sessionID, projectId });
      debugLog('node', 'nodeProjectSessionGuard', '[POST /project-session/release] success', {
        sessionId: String(req.sessionID || ''),
        projectId,
      });
      return res.json({ success: true, projectId, released: true });
    } catch (error) {
      return res.status(500).json({ success: false, message: error?.message || String(error) });
    }
  });

  app.use('/api/project-session', router);
}

module.exports = { registerProjectSessionRoutes };

