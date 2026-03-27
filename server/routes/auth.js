const express = require('express');
const crypto = require('crypto');

function registerAuthRoutes(app, { db, bcrypt, requireAdmin, DEFAULT_ADMIN_USERNAME, projectSessionGuard }) {
  const router = express.Router();

  // 安全策略：用户第一次输入错误之后，后续每次都必须先通过人机验证
  // 通过 /human-verify 成功后发放“一次性放行券”，只允许放行下一次对应目的的请求。
  const VERIFY_CODE_PURPOSE = 'verifyCode';
  const ADMIN_LOGIN_PURPOSE = 'adminLogin';
  // 同一 IP 风险状态（进程内内存态，服务重启后会清空）
  const ipRiskFlags = new Map();

  function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || 'unknown';
  }

  function getOrCreateIpState(ip) {
    const key = ip || 'unknown';
    if (!ipRiskFlags.has(key)) {
      ipRiskFlags.set(key, {
        verifyCodeWrongOnce: false,
        adminLoginWrongOnce: false,
      });
    }
    return ipRiskFlags.get(key);
  }

  function markWrongOnce(req, flagKey) {
    if (req.session) {
      req.session[flagKey] = true;
    }
    const ipState = getOrCreateIpState(getClientIp(req));
    ipState[flagKey] = true;
  }

  function hasWrongOnce(req, flagKey) {
    const bySession = !!(req.session && req.session[flagKey]);
    const ipState = getOrCreateIpState(getClientIp(req));
    const byIp = !!ipState[flagKey];
    return bySession || byIp;
  }

  function requireHumanVerifyIfNeeded(req, res, { gateWrongFlag, purpose }) {
    // 本次会话内一旦通过过一次人机验证，则后续流程放行（项目码与管理员登录都不再受限）
    if (req.session?.humanVerifiedPassed) return false;

    if (!hasWrongOnce(req, gateWrongFlag)) return false;
    res.status(403).json({ error: 'HUMAN_VERIFICATION_REQUIRED', message: '需要人机验证后才能继续' });
    return true;
  }

  // ==========================
  // 人机验证：滑动拼图（服务端校验）
  // ==========================
  // 说明：
  // - 前端使用 jigsaw（纯前端绘制/交互）来降低改造成本
  // - 但校验逻辑由后端执行：基于 challenge 中的期望拼图 x 坐标、
  //   前端上报的滑块 left（像素）+ 拖动轨迹 trail（y 方向波动）+ 拖动耗时 durationMs
  const JIGSAW_DEFAULT_WIDTH = 310;
  const JIGSAW_DEFAULT_HEIGHT = 155;
  // jigsaw/src/jigsaw.js 中：
  // l=42, r=9, L = l + r*2 + 3 => 63；spliced 容差 < 10
  const JIGSAW_L = 63;
  const JIGSAW_X_TOLERANCE_PX = 10;

  function calcStddev(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const n = arr.length;
    const average = arr.reduce((a, b) => a + b, 0) / n;
    const deviations = arr.map((x) => x - average);
    const sumSquares = deviations.map((x) => x * x).reduce((a, b) => a + b, 0);
    return Math.sqrt(sumSquares / n);
  }

  // 人机验证：获取挑战（返回拼图参数用于绘制）
  router.post('/human-challenge', async (req, res) => {
    try {
      const purpose = req.body?.purpose || 'generic';

      const challengeId = crypto.randomBytes(16).toString('hex');
      const width = JIGSAW_DEFAULT_WIDTH;
      const height = JIGSAW_DEFAULT_HEIGHT;

      // x/y 的范围与前端 jigsaw.js 的 random 逻辑保持一致：
      // x: getRandomNumberByRange(L + 10, width - (L + 10))
      // y: getRandomNumberByRange(10 + r*2, height - (L + 10))
      // 其中 r=9 => 10+r*2 = 28
      const minX = JIGSAW_L + 10;
      const maxX = width - (JIGSAW_L + 10);
      const minY = 10 + 9 * 2; // 28
      const maxY = height - (JIGSAW_L + 10);

      const randInt = (a, b) => Math.round(Math.random() * (b - a) + a);
      const x = randInt(minX, maxX);
      const y = randInt(minY, maxY);

      // 使用 seed 形式可显著降低 /id/{n} 404 概率，并保证同 challenge 可重复加载。
      const imageSrc = `https://picsum.photos/seed/dax_hv_${challengeId}/${width}/${height}`;

      // 保存到 session：只允许本 session 使用一次（避免重放）
      req.session.humanChallenge = {
        challengeId,
        purpose,
        createdAt: Date.now(),
        // 期望拼图参数
        width,
        height,
        x,
        y,
        imageSrc,
        used: false,
        failedCount: 0,
      };

      return res.json({ challengeId, purpose, width, height, x, y, imageSrc });
    } catch (error) {
      console.error('[人机验证挑战] 错误:', error);
      return res.status(500).json({ error: error.message || '获取挑战失败' });
    }
  });

  // 人机验证：提交校验数据（后端验证）
  router.post('/human-verify', async (req, res) => {
    try {
      const { challengeId, purpose, sliderLeft, trail, durationMs } = req.body || {};

      const ch = req.session?.humanChallenge;
      if (!ch || !challengeId || ch.challengeId !== challengeId) {
        return res.status(400).json({ error: '挑战已失效，请刷新后重试' });
      }
      if (ch.used) return res.status(400).json({ error: '挑战已使用，请刷新后重试' });

      // 过期保护：5 分钟失效
      if (Date.now() - (ch.createdAt || 0) > 5 * 60 * 1000) {
        return res.status(400).json({ error: '挑战已过期，请刷新后重试' });
      }

      if (ch.purpose && ch.purpose !== purpose) {
        // 目的不匹配，视作失败（避免复用挑战绕过）
        return res.status(403).json({ error: '挑战用途不匹配' });
      }

      // 参数校验
      const leftNum = Number(sliderLeft);
      if (!Number.isFinite(leftNum)) return res.status(400).json({ error: 'sliderLeft 格式不正确' });

      const msNum = Number(durationMs);
      if (!Number.isFinite(msNum)) return res.status(400).json({ error: 'durationMs 格式不正确' });

      const trailArr = Array.isArray(trail) ? trail.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
      if (trailArr.length < 3) return res.status(400).json({ error: 'trail 数据不完整' });

      // 人类操作基本约束：拖动不应过快/过慢
      //（防止脚本直接提交“猜测结果”）
      const MIN_DURATION_MS = 250;
      const MAX_DURATION_MS = 15000;
      if (msNum < MIN_DURATION_MS || msNum > MAX_DURATION_MS) {
        return res.status(403).json({ error: '拖动耗时不符合预期' });
      }

      // 期望拼图位置容差
      const spliced = Math.abs(leftNum - ch.x) < JIGSAW_X_TOLERANCE_PX;
      if (!spliced) return res.status(403).json({ error: '拼图位置不匹配' });

      // jigsaw 里 verified: stddev !== 0
      // 这里把阈值放大一点，避免客户端用常量数组绕过
      const stddev = calcStddev(trailArr);
      const verified = stddev > 0.15;
      if (!verified) return res.status(403).json({ error: '轨迹波动不符合预期' });

      // 通过：设置通过标记（并标记 challenge used，避免重放）
      ch.used = true;
      // 会话级放行：本次操作进程（同 session）中，项目码与管理员登录都不再受限
      req.session.humanVerifiedPassed = true;
      req.session.humanChallenge = null;

      return res.json({ success: true });
    } catch (error) {
      console.error('[人机验证提交] 错误:', error);
      return res.status(500).json({ error: error.message || '验证失败' });
    }
  });

  // 验证码验证
  router.post('/verify-code', async (req, res) => {
    try {
      const { accessCode } = req.body;
      if (!accessCode || typeof accessCode !== 'string') {
        return res.status(400).json({ error: '验证码不能为空' });
      }

      // 普通用户：如果曾经输入过一次错误验证码，则后续每次都必须先通过人机验证
      if (
        requireHumanVerifyIfNeeded(req, res, {
          gateWrongFlag: 'verifyCodeWrongOnce',
          purpose: VERIFY_CODE_PURPOSE,
        })
      ) {
        return;
      }

      const project = await db.getProjectByAccessCode(accessCode.trim().toUpperCase());
      if (!project) {
        // “输入错误一次”触发：后续每次都必须先通过人机验证
        markWrongOnce(req, 'verifyCodeWrongOnce');
        // 注意：这里不要返回 404，否则浏览器会把该请求标红显示为“错误请求”。
        // 这是预期的业务分支：验证码输入错误，返回 200 + success=false 供前端处理。
        return res.status(200).json({ success: false, error: '验证码无效' });
      }

      // 检查项目是否锁定（非管理员无法访问锁定的项目）
      if (project.locked && !(req.session && req.session.isAdmin)) {
        return res.status(403).json({ error: '项目已锁定，请联系管理员' });
      }

      // 记录 session 访问权限
      const sessionId = req.sessionID;
      await db.grantProjectAccess(sessionId, project.id);
      // 声明该项目控制权（若已有其他会话在控制，将触发对方断开提示）
      if (projectSessionGuard) {
        projectSessionGuard.claim({ sessionId, projectId: Number(project.id) });
      }

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

      // 管理员：如果曾经输入过一次错误账号/密码，则后续每次都必须先通过人机验证
      if (
        requireHumanVerifyIfNeeded(req, res, {
          gateWrongFlag: 'adminLoginWrongOnce',
          purpose: ADMIN_LOGIN_PURPOSE,
        })
      ) {
        return;
      }

      // 只允许统一配置的管理员账号登录
      if (username !== DEFAULT_ADMIN_USERNAME) {
        markWrongOnce(req, 'adminLoginWrongOnce');
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      const user = await db.getUserByUsername(username);
      if (!user) {
        markWrongOnce(req, 'adminLoginWrongOnce');
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        markWrongOnce(req, 'adminLoginWrongOnce');
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
      if (projectSessionGuard) {
        projectSessionGuard.releaseAllForSession({ sessionId });
      }
      return res.json({ success: true });
    });
  });

  // 检查当前登录状态
  router.get('/check', (req, res) => {
    const sessionVerified = !!req.session?.humanVerifiedPassed;
    const needVerifyCodeHuman =
      !sessionVerified && hasWrongOnce(req, 'verifyCodeWrongOnce');
    const needAdminLoginHuman =
      !sessionVerified && hasWrongOnce(req, 'adminLoginWrongOnce');

    if (req.session && req.session.userId) {
      return res.json({
        authenticated: true,
        isAdmin: req.session.isAdmin || false,
        user: {
          id: req.session.userId,
          username: req.session.username,
        },
        requireHumanVerification: {
          verifyCode: needVerifyCodeHuman,
          adminLogin: needAdminLoginHuman,
        },
      });
    }

    if (req.session && req.session.accessibleProjectIds && req.session.accessibleProjectIds.length > 0) {
      return res.json({
        authenticated: true,
        isAdmin: false,
        accessibleProjectIds: req.session.accessibleProjectIds,
        requireHumanVerification: {
          verifyCode: needVerifyCodeHuman,
          adminLogin: needAdminLoginHuman,
        },
      });
    }

    return res.json({
      authenticated: false,
      requireHumanVerification: {
        verifyCode: needVerifyCodeHuman,
        adminLogin: needAdminLoginHuman,
      },
    });
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

