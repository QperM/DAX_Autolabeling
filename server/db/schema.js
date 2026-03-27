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
  const ensurePose9dInstanceSchema = () => {
    db.get(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='pose9d_annotations'`,
      (qErr, row) => {
        if (qErr || !row?.sql) return;
        const sqlText = String(row.sql || '').toLowerCase().replace(/\s+/g, ' ');
        const alreadyInstanceScoped = sqlText.includes('unique(image_id, mesh_id, mask_id)');
        if (alreadyInstanceScoped) {
          db.run('ALTER TABLE pose9d_annotations ADD COLUMN mask_id TEXT', () => {});
          db.run('ALTER TABLE pose9d_annotations ADD COLUMN mask_index INTEGER', () => {});
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_pose9d_image_mesh_mask ON pose9d_annotations(image_id, mesh_id, mask_id)',
            () => {},
          );
          return;
        }

        db.all(`PRAGMA table_info('pose9d_annotations')`, (cErr, cols) => {
          if (cErr) return;
          const colNames = new Set((cols || []).map((c) => String(c?.name || '').toLowerCase()));
          const hasMaskId = colNames.has('mask_id');
          const hasMaskIndex = colNames.has('mask_index');
          const srcMaskIdExpr = hasMaskId
            ? "COALESCE(NULLIF(TRIM(mask_id), ''), 'legacy:image' || image_id || ':mesh' || COALESCE(mesh_id, 'null'))"
            : "'legacy:image' || image_id || ':mesh' || COALESCE(mesh_id, 'null')";
          const srcMaskIndexExpr = hasMaskIndex ? 'mask_index' : 'NULL';

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run('ALTER TABLE pose9d_annotations RENAME TO pose9d_annotations_legacy');
            db.run(`
              CREATE TABLE IF NOT EXISTS pose9d_annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                mesh_id INTEGER,
                mask_id TEXT NOT NULL,
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
            `);
            db.run(`
              INSERT INTO pose9d_annotations (
                id, image_id, mesh_id, mask_id, mask_index,
                diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
              )
              SELECT
                id, image_id, mesh_id, ${srcMaskIdExpr} AS mask_id, ${srcMaskIndexExpr} AS mask_index,
                diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
              FROM pose9d_annotations_legacy
            `);
            db.run('DROP TABLE pose9d_annotations_legacy');
            db.run('CREATE INDEX IF NOT EXISTS idx_pose9d_image_id ON pose9d_annotations(image_id)');
            db.run(
              'CREATE INDEX IF NOT EXISTS idx_pose9d_image_mesh_mask ON pose9d_annotations(image_id, mesh_id, mask_id)',
            );
            db.run('COMMIT', (mErr) => {
              if (mErr) {
                db.run('ROLLBACK');
                console.warn('[DB] pose9d_annotations 实例级迁移失败:', mErr.message);
              }
            });
          });
        });
      },
    );
  };
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
  // 清理已删除项目残留的访问行（外键在部分老库/迁移场景下可能未级联）
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
  db.run('ALTER TABLE images ADD COLUMN original_name TEXT', (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.warn('[DB] images ADD original_name:', err.message);
    }
  });
  db.run(
    `UPDATE images SET original_name = filename WHERE original_name IS NULL OR TRIM(COALESCE(original_name, '')) = ''`,
    (uErr) => {
      if (uErr) console.warn('[DB] images backfill original_name:', uErr.message);
    },
  );
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
  `, (err) => {
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
  });
  db.run('ALTER TABLE pose9d_annotations ADD COLUMN initial_pose_json TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.warn('[DB] 为 pose9d_annotations 添加 initial_pose_json 列失败:', err.message);
    }
  });
  db.run('ALTER TABLE pose9d_annotations ADD COLUMN mask_id TEXT', () => {});
  db.run('ALTER TABLE pose9d_annotations ADD COLUMN mask_index INTEGER', () => {});
  ensurePose9dInstanceSchema();

  // cameras (intrinsics)
  db.run(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL,

      intrinsics_json TEXT,
      intrinsics_file_path TEXT,
      intrinsics_file_size INTEGER,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(project_id, role)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_cameras_project_id ON cameras(project_id)');
  db.run('ALTER TABLE cameras DROP COLUMN intrinsics_original_name', (err) => {
    if (err && !String(err.message || '').includes('no such column')) {
      console.warn('[DB] cameras DROP intrinsics_original_name:', err.message);
    }
  });

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
      file_path TEXT NOT NULL,
      file_size INTEGER,
      upload_time TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE SET NULL,
      FOREIGN KEY (camera_id) REFERENCES cameras (id) ON DELETE SET NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_depth_project_id ON depth_maps(project_id)');
  db.run('ALTER TABLE depth_maps DROP COLUMN original_name', (err) => {
    if (err && !String(err.message || '').includes('no such column')) {
      console.warn('[DB] depth_maps DROP original_name:', err.message);
    }
  });
  db.run('ALTER TABLE depth_maps ADD COLUMN image_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 image_id 列失败:', err.message);
  });
  db.run('ALTER TABLE depth_maps ADD COLUMN camera_id INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 camera_id 列失败:', err.message);
  });
  db.run('ALTER TABLE depth_maps ADD COLUMN depth_raw_fix_path TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 depth_raw_fix_path 列失败:', err.message);
  });
  db.run('ALTER TABLE depth_maps ADD COLUMN depth_png_fix_path TEXT', (err) => {
    if (err && !err.message.includes('duplicate column name')) console.warn('为 depth_maps 添加 depth_png_fix_path 列失败:', err.message);
  });

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

  // project_label_colors (project-scoped label/color mapping)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_label_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      label_key TEXT NOT NULL,
      color TEXT NOT NULL,
      usage_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(project_id, label_key)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_project_label_colors_project_id ON project_label_colors(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_project_label_colors_order ON project_label_colors(project_id, usage_order, updated_at)');
  db.run('ALTER TABLE project_label_colors ADD COLUMN usage_order INTEGER DEFAULT 0', () => {});
}

module.exports = {
  initializeSchema,
  deleteProjectFolder,
};

