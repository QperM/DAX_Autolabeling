const path = require('path');
const fs = require('fs');
const { getUploadsRootDir } = require('../utils/dataPaths');

// 删除项目文件夹的辅助函数（用于项目删除时清理 uploads）
function deleteProjectFolder(projectId) {
  if (!projectId) return;
  const projectDir = path.join(getUploadsRootDir(), `project_${projectId}`);
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
      locked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_access_code ON projects(access_code)', (idxErr) => {
    if (idxErr) console.warn('创建 access_code 唯一索引:', idxErr.message);
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
  db.run(`DELETE FROM project_access WHERE project_id NOT IN (SELECT id FROM projects)`, (orphErr) => {
    if (orphErr) console.warn('[DB] project_access orphan cleanup:', orphErr.message);
  });

  // images
  db.run(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      upload_time TEXT NOT NULL
    )
  `);

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
  // Speed up annotation-summary under pressure test.
  // - project annotation summary does joins by image_id and filters by project_id via project_images.
  // - latestAnnotatedImageId needs ORDER BY annotations.updated_at DESC.
  db.run('CREATE INDEX IF NOT EXISTS idx_annotations_image_id ON annotations(image_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_annotations_image_id_updated_at ON annotations(image_id, updated_at)');

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

  // pose9d_annotations (Diff-DOPE only)
  // 注意：不要在启动时 DROP，避免重启导致数据丢失。
  db.run(
    `
    CREATE TABLE IF NOT EXISTS pose9d_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL,
      mesh_id INTEGER,
      mask_id TEXT NOT NULL DEFAULT '__mesh_default__',
      mask_index INTEGER,
      diffdope_json TEXT NOT NULL,
      initial_pose_json TEXT,
      fit_overlay_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
      FOREIGN KEY (mesh_id) REFERENCES meshes (id) ON DELETE SET NULL,
      UNIQUE(image_id, mesh_id, mask_id)
    )
  `,
    (err) => {
      if (err) {
        console.warn('[DB] CREATE pose9d_annotations 失败:', err.message);
        return;
      }
      db.run('CREATE INDEX IF NOT EXISTS idx_pose9d_image_id ON pose9d_annotations(image_id)', (idxErr) => {
        if (idxErr) console.warn('[DB] CREATE INDEX idx_pose9d_image_id 失败:', idxErr.message);
      });
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_pose9d_image_mesh_mask ON pose9d_annotations(image_id, mesh_id, mask_id)',
        (idxErr) => {
          if (idxErr) console.warn('[DB] CREATE INDEX idx_pose9d_image_mesh_mask 失败:', idxErr.message);
        },
      );
    },
  );

  // cameras (intrinsics)
  db.run(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL,

      intrinsics_json TEXT,
      intrinsics_file_path TEXT,
      intrinsics_file_size INTEGER,
      intrinsics_original_name TEXT,

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
      original_name TEXT,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      upload_time TEXT NOT NULL,
      depth_raw_fix_path TEXT,
      depth_png_fix_path TEXT,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE SET NULL,
      FOREIGN KEY (camera_id) REFERENCES cameras (id) ON DELETE SET NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_depth_project_id ON depth_maps(project_id)');

  // depth_repair_records
  db.run(`
    CREATE TABLE IF NOT EXISTS depth_repair_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      image_id INTEGER NOT NULL,
      role TEXT,
      depth_raw_path TEXT,
      depth_png_path TEXT,
      depth_raw_fix_path TEXT,
      depth_png_fix_path TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
      UNIQUE(project_id, image_id, role)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_depth_repair_project_id ON depth_repair_records(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_depth_repair_image_id ON depth_repair_records(image_id)');

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
  db.run('CREATE INDEX IF NOT EXISTS idx_project_images_project_id_image_id ON project_images(project_id, image_id)');

  // project_label_colors (project-scoped label/color mapping)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_label_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      label_zh TEXT,
      label_key TEXT NOT NULL,
      color TEXT NOT NULL,
      usage_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(project_id, label_key)
    )
  `);
  // 兼容旧库：为 project_label_colors 增加中文昵称列
  db.all(`PRAGMA table_info(project_label_colors)`, (pragmaErr, cols) => {
    if (pragmaErr) {
      console.warn('[DB] 读取 project_label_colors 表结构失败:', pragmaErr.message);
      return;
    }
    const hasLabelZh = Array.isArray(cols) && cols.some((c) => String(c?.name || '').toLowerCase() === 'label_zh');
    if (hasLabelZh) return;
    db.run(`ALTER TABLE project_label_colors ADD COLUMN label_zh TEXT`, (alterErr) => {
      if (alterErr) {
        console.warn('[DB] project_label_colors 添加 label_zh 列失败:', alterErr.message);
      } else {
        console.log('[DB] project_label_colors 已添加 label_zh 列');
      }
    });
  });
  db.run('CREATE INDEX IF NOT EXISTS idx_project_label_colors_project_id ON project_label_colors(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_project_label_colors_order ON project_label_colors(project_id, usage_order, updated_at)');
}

module.exports = {
  initializeSchema,
  deleteProjectFolder,
};
