function makeAuthzMiddlewares({ db }) {
  // 检查是否为管理员
  const requireAdmin = (req, res, next) => {
    if (req.session && req.session.userId && req.session.isAdmin) {
      return next();
    }

    console.warn('[requireAdmin] 未通过管理员校验', {
      sessionID: req.sessionID,
      hasSession: !!req.session,
      userId: req.session?.userId,
      isAdmin: req.session?.isAdmin,
    });

    res.status(401).json({ error: '需要管理员权限' });
  };

  // 检查是否有项目访问权限
  const requireProjectAccess = async (req, res, next) => {
    const projectId = req.params.id || req.body.projectId || req.query.projectId;
    if (!projectId) {
      return res.status(400).json({ error: '缺少项目ID' });
    }

    // 如果是管理员，直接通过
    if (req.session && req.session.isAdmin) {
      return next();
    }

    // 检查项目是否锁定
    try {
      const project = await db.getProjectById(projectId);
      if (project && project.locked) {
        return res.status(403).json({ error: '项目已锁定，请联系管理员' });
      }
    } catch (err) {
      console.error('[检查项目锁定状态] 错误:', err);
    }

    const sessionId = req.sessionID;
    const hasAccess = await db.hasProjectAccess(sessionId, projectId);

    if (hasAccess) {
      next();
    } else {
      res.status(403).json({ error: '没有访问该项目的权限，请先输入验证码' });
    }
  };

  // 检查图片所属项目的访问权限
  const requireImageProjectAccess = async (req, res, next) => {
    const imageId = req.params.imageId || req.params.id;
    if (!imageId) {
      return res.status(400).json({ error: '缺少图片ID' });
    }

    // 如果是管理员，直接通过
    if (req.session && req.session.isAdmin) {
      return next();
    }

    try {
      // 查找图片所属的项目
      const image = await new Promise((resolve, reject) => {
        db.getImageById(imageId, (err, img) => {
          if (err) reject(err);
          else resolve(img);
        });
      });

      if (!image) {
        return res.status(404).json({ error: '图片不存在' });
      }

      // 查找图片关联的项目
      const projectIds = await db.getProjectIdsByImageId(imageId);

      if (projectIds.length === 0) {
        return res.status(403).json({ error: '该图片未关联到项目，无法访问' });
      }

      // 检查是否有任一项目的访问权限
      const sessionId = req.sessionID;
      let hasAccess = false;
      for (const projectId of projectIds) {
        const access = await db.hasProjectAccess(sessionId, projectId);
        if (access) {
          hasAccess = true;
          break;
        }
      }

      if (hasAccess) {
        next();
      } else {
        res.status(403).json({ error: '没有访问该图片所属项目的权限，请先输入验证码' });
      }
    } catch (error) {
      console.error('[检查图片项目权限] 错误:', error);
      res.status(500).json({ error: error.message });
    }
  };

  return {
    requireAdmin,
    requireProjectAccess,
    requireImageProjectAccess,
  };
}

module.exports = { makeAuthzMiddlewares };

