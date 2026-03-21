const path = require('path');
const fs = require('fs');

// 删除项目文件夹的辅助函数（用于项目删除时清理 uploads）
function deleteProjectFolder(projectId) {
  if (!projectId) return;
  const projectDir = path.join(__dirname, '..', 'uploads', `project_${projectId}`);
  if (fs.existsSync(projectDir)) {
    fs.rm(projectDir, { recursive: true, force: true }, (err) => {
      if (err) console.error(`❌ 删除项目文件夹失败: ${projectDir}`, err);
      else console.log(`✅ 已删除项目文件夹: ${projectDir}`);
    });
  }
}

function initializeSchema(db) {
  // projects
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      access_code TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('ALTER TABLE projects ADD COLUMN access_code TEXT', (alterErr) => {
    if (alterErr && !alterErr.message.includes('duplicate column name')) {
      console.warn('为projects表添加access_code列:', alterErr.message);
    }
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_access_code ON projects(access_code)', (idxErr) => {
      if (idxErr) console.warn('创建access_code唯一索引:', idxErr.message);
    });
  });
  db.run('ALTER TABLE projects ADD COLUMN locked INTEGER DEFAULT 0', (alterErr) => {
    if (alterErr && !alterErr.message.includes('duplicate column name')) {
      console.warn('为projects表添加locked列:', alterErr.message);
    }
  });

  // users
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // project_access
  db.run(`
    CREATE TABLE IF NOT EXISTS project_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(session_id, project_id)
    )
  `);

  // images
  db.run(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      upload_time TEXT NOT NULL
    )
  `);
  db.run('ALTER TABLE images ADD COLUMN width INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error('为images表添加width列失败:', err.message);
  });
  db.run('ALTER TABLE images ADD COLUMN height INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.error('为images表添加height列失败:', err.message);
  });

  // annotations (2D)
  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      image_id INTEGER NOT NULL,
      mask_data TEXT,
      bbox_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE
    )
  `);

  // meshes (6D)
  db.run(`
    CREATE TABLE IF NOT EXISTS meshes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      bbox_json TEXT,
      upload_time TEXT NOT NULL,
      sku_label TEXT,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_meshes_project_id ON meshes(project_id)');
  db.run('ALTER TABLE meshes ADD COLUMN sku_label TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 meshes 表添加 sku_label 列失败:', err.message);
  });
  db.run('ALTER TABLE meshes ADD COLUMN bbox_json TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 meshes 表添加 bbox_json 列失败:', err.message);
  });

  // pose9d_annotations (Diff-DOPE only)
  // 注意：不要在启动时 DROP，避免重启导致数据丢失。
  db.run(`
    CREATE TABLE IF NOT EXISTS pose9d_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL,
      mesh_id INTEGER,
      diffdope_json TEXT NOT NULL,
      fit_overlay_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
      FOREIGN KEY (mesh_id) REFERENCES meshes (id) ON DELETE SET NULL,
      UNIQUE(image_id, mesh_id)
    )
  `, (err) => {
    if (err) {
      console.warn('[DB] CREATE pose9d_annotations 失败:', err.message);
      return;
    }
    db.run('CREATE INDEX IF NOT EXISTS idx_pose9d_image_id ON pose9d_annotations(image_id)', (idxErr) => {
      if (idxErr) console.warn('[DB] CREATE INDEX idx_pose9d_image_id 失败:', idxErr.message);
    });
  });

  // cameras (intrinsics)
  db.run(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL,

      intrinsics_json TEXT,
      intrinsics_file_path TEXT,
      intrinsics_original_name TEXT,
      intrinsics_file_size INTEGER,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(project_id, role)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_cameras_project_id ON cameras(project_id)');

  // depth_maps (6D)
  db.run(`
    CREATE TABLE IF NOT EXISTS depth_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      image_id INTEGER,
      camera_id INTEGER,
      role TEXT,
      modality TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      upload_time TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE SET NULL,
      FOREIGN KEY (camera_id) REFERENCES cameras (id) ON DELETE SET NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_depth_project_id ON depth_maps(project_id)');
  db.run('ALTER TABLE depth_maps ADD COLUMN image_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 image_id 列失败:', err.message);
  });
  db.run('ALTER TABLE depth_maps ADD COLUMN camera_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 camera_id 列失败:', err.message);
  });

  // project_images (system)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      image_id INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
      UNIQUE(project_id, image_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_project_images_project_id ON project_images(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_project_images_image_id ON project_images(image_id)');
}

module.exports = {
  initializeSchema,
  deleteProjectFolder,
};

