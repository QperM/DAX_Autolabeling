const { createConnection, getDefaultDbPath } = require('./connection');
const { initializeSchema, deleteProjectFolder } = require('./schema');

const { makeImagesRepo } = require('./repos/imagesRepo');
const { makeMeshesRepo } = require('./repos/meshesRepo');
const { makeDepthRepo } = require('./repos/depthRepo');
const { makeCamerasRepo } = require('./repos/camerasRepo');
const { makeAnnotationsRepo } = require('./repos/annotationsRepo');
const { makePose9dRepo } = require('./repos/pose9dRepo');
const { makeProjectsRepo } = require('./repos/projectsRepo');
const { makeProjectLabelColorsRepo } = require('./repos/projectLabelColorsRepo');
const { makeAuthRepo } = require('./repos/authRepo');

const dbPath = getDefaultDbPath();
const db = createConnection(dbPath);

db.on('trace', () => {}); // keep sqlite3 loaded; no-op

// Ensure schema initialization finishes before the server starts accepting requests.
// We do it by enqueueing a "marker" statement at the end of the serialize queue.
const ready = new Promise((resolve, reject) => {
  // 必须在本回调内同步排队所有语句；若在 db.run 的异步回调里再 queue，serialize 已结束，语句会并行，
  // 易出现「DELETE project_access 早于 CREATE」「引用 meshes 时尚未建表」等竞态。
  db.serialize(() => {
    // Improve sqlite concurrency/lock behavior under load.
    // WAL allows concurrent reads while writes are happening.
    db.run('PRAGMA journal_mode = WAL', (pragmaErr) => {
      if (pragmaErr) console.error('启用 WAL 失败:', pragmaErr.message);
    });
    db.run('PRAGMA synchronous = NORMAL', (pragmaErr) => {
      if (pragmaErr) console.error('设置 synchronous 失败:', pragmaErr.message);
    });
    db.run('PRAGMA busy_timeout = 5000', (pragmaErr) => {
      if (pragmaErr) console.error('设置 busy_timeout 失败:', pragmaErr.message);
    });
    db.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
      if (pragmaErr) console.error('启用外键约束失败:', pragmaErr.message);
    });
    try {
      initializeSchema(db);
    } catch (e) {
      reject(e);
      return;
    }
    db.all('SELECT 1 as ok', (err) => {
      if (err) return reject(err);
      console.log('[DB] schema initialization finished');
      resolve(true);
    });
  });
});

const imagesRepo = makeImagesRepo(db);
const meshesRepo = makeMeshesRepo(db);
const depthRepo = makeDepthRepo(db);
const camerasRepo = makeCamerasRepo(db);
const annotationsRepo = makeAnnotationsRepo(db);
const pose9dRepo = makePose9dRepo(db);
const projectsRepo = makeProjectsRepo(db, { deleteProjectFolder });
const projectLabelColorsRepo = makeProjectLabelColorsRepo(db);
const authRepo = makeAuthRepo(db);

const api = {
  // connection lifecycle
  close: () => {
    db.close((err) => {
      if (err) console.error('关闭数据库失败:', err.message);
      else console.log('数据库连接已关闭');
    });
  },

  // expose helper used by project delete flow (kept for compatibility)
  deleteProjectFolder,

  // 2D / shared
  ...imagesRepo,
  ...annotationsRepo,

  // 6D
  ...meshesRepo,
  ...pose9dRepo,
  ...depthRepo,
  ...camerasRepo,

  // system
  ...projectsRepo,
  ...projectLabelColorsRepo,
  ...authRepo,
};

api.ready = ready;
module.exports = api;

