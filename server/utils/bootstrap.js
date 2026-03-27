const bcrypt = require('bcrypt');
const db = require('../database');

async function initializeDefaultAdmin({ username, password }) {
  try {
    const adminUser = await db.getUserByUsername(username);
    if (!adminUser) {
      const passwordHash = await bcrypt.hash(password, 10);
      await db.createUser(username, passwordHash);
      console.log(`✅ 已创建默认管理员账号: ${username}`);
      console.log(`⚠️  默认密码: ${password}（请在生产环境中修改！）`);
      console.log('⚠️  可通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 设置账号密码');
    } else {
      console.log('✅ 管理员账号已存在');
    }
  } catch (error) {
    console.error('❌ 初始化管理员账号失败:', error);
  }
}

async function startServer(app, { port, defaultAdminUsername, defaultAdminPassword }) {
  // Wait for schema initialization before accepting requests.
  // This prevents "no such table" errors when the DB is missing/partially migrated.
  try {
    if (db?.ready && typeof db.ready.then === 'function') {
      console.log('[DB] waiting schema initialization...');
      await db.ready;
      console.log('[DB] waiting done (schema ready)');
    }
  } catch (e) {
    console.error('[DB] schema initialization failed:', e);
  }

  app.listen(port, async () => {
    console.log(`🚀 服务器运行在端口 ${port}`);
    console.log(`📊 健康检查: http://localhost:${port}/api/health`);
    console.log(`📝 自动标注接口: http://localhost:${port}/api/annotate/auto`);

    await initializeDefaultAdmin({
      username: defaultAdminUsername,
      password: defaultAdminPassword,
    });
  });
}

module.exports = { startServer };
