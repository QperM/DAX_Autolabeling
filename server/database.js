const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 兼容 image-size 不同导出形式（v2+ 通常是 { imageSize }）
const imageSizeModule = require('image-size');
const sizeOf = imageSizeModule.imageSize || imageSizeModule;

// 确保database目录存在
const dbDir = path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 数据库文件路径
const dbPath = path.join(dbDir, 'annotations.db');

// 创建数据库连接
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('✅ 数据库连接成功');
    // 启用外键约束
    db.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
      if (pragmaErr) {
        console.error('启用外键约束失败:', pragmaErr.message);
      } else {
        console.log('✅ 外键约束已启用');
      }
      initializeDatabase();
    });
  }
});

// 删除项目文件夹的辅助函数
function deleteProjectFolder(projectId) {
  if (!projectId) return;
  
  const projectDir = path.join(__dirname, 'uploads', `project_${projectId}`);
  if (fs.existsSync(projectDir)) {
    try {
      // 递归删除文件夹及其所有内容
      fs.rmSync(projectDir, { recursive: true, force: true });
      console.log(`✅ 已删除项目文件夹: ${projectDir}`);
    } catch (err) {
      console.error(`❌ 删除项目文件夹失败: ${projectDir}`, err);
    }
  }
}

// 初始化数据库表
function initializeDatabase() {
  // 创建projects表
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
  
  // 为已有的projects表添加access_code列（如果不存在）
  // 注意：SQLite 不支持 ALTER TABLE ADD COLUMN ... UNIQUE，所以先添加普通列，再建唯一索引
  db.run('ALTER TABLE projects ADD COLUMN access_code TEXT', (alterErr) => {
    if (alterErr && !alterErr.message.includes('duplicate column name')) {
      // 真正的错误（不是"列已存在"）才打印
      console.warn('为projects表添加access_code列:', alterErr.message);
    }
    // 无论 ALTER 是否成功（可能列已存在），都尝试建唯一索引
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_access_code ON projects(access_code)', (idxErr) => {
      if (idxErr) {
        console.warn('创建access_code唯一索引:', idxErr.message);
      }
    });
  });
  
  // 创建users表（管理员）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('创建users表失败:', err.message);
    } else {
      console.log('✅ users表创建成功');
    }
  });
  
  // 创建project_access表（记录session访问权限）
  db.run(`
    CREATE TABLE IF NOT EXISTS project_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      UNIQUE(session_id, project_id)
    )
  `, (err) => {
    if (err) {
      console.error('创建project_access表失败:', err.message);
    } else {
      console.log('✅ project_access表创建成功');
    }
  });
  
  // 创建images表
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
  `, (err) => {
    if (err) {
      console.error('创建images表失败:', err.message);
    } else {
      console.log('✅ images表创建成功');
    }
  });

  // 为已有的images表补充width和height列（如果不存在）
  db.run('ALTER TABLE images ADD COLUMN width INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('为images表添加width列失败:', err.message);
    }
  });

  db.run('ALTER TABLE images ADD COLUMN height INTEGER', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('为images表添加height列失败:', err.message);
    }
  });

  // 创建annotations表
  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      image_id INTEGER NOT NULL,
      mask_data TEXT, -- JSON格式存储Mask点坐标
      bbox_data TEXT, -- JSON格式存储边界框数据
      polygon_data TEXT, -- JSON格式存储多边形数据
      labels TEXT, -- JSON格式存储标签信息
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) {
      console.error('创建annotations表失败:', err.message);
    } else {
      console.log('✅ annotations表创建成功');
    }
  });
  
  // 创建项目-图片关联表
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
  `, (err) => {
    if (err) {
      console.error('创建project_images表失败:', err.message);
    } else {
      console.log('✅ project_images表创建成功');
    }
  });
  
  // 创建索引提高查询性能
  db.run('CREATE INDEX IF NOT EXISTS idx_project_images_project_id ON project_images(project_id)', (err) => {
    if (err) console.error('创建索引失败:', err.message);
  });
  
  db.run('CREATE INDEX IF NOT EXISTS idx_project_images_image_id ON project_images(image_id)', (err) => {
    if (err) console.error('创建索引失败:', err.message);
  });
}

// 数据库操作方法
const database = {
  // 插入图片信息
  insertImage: (imageData, callback) => {
    // 计算图片宽高
    let width = null;
    let height = null;
    try {
      const buffer = fs.readFileSync(imageData.path);
      const dimensions = sizeOf(buffer);
      width = dimensions.width;
      height = dimensions.height;
    } catch (e) {
      console.warn('获取图片尺寸失败:', e.message);
    }

    const sql = `
      INSERT INTO images (filename, original_name, file_path, file_size, width, height, upload_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      imageData.filename,
      imageData.originalName,
      imageData.path,
      imageData.size,
      width,
      height,
      imageData.uploadTime
    ];
    
    db.run(sql, params, function(err) {
      if (err) {
        return callback(err, null);
      }
      // 确保正确获取 lastID
      const lastID = this.lastID;
      callback(null, lastID);
    });
  },

  // 获取所有图片
  getAllImages: (callback) => {
    const sql = `
      SELECT id, filename, original_name, file_path, file_size, width, height, upload_time
      FROM images
      ORDER BY upload_time DESC
    `;
    db.all(sql, [], callback);
  },

  // 根据项目ID获取图片（通过项目-图片关联表）
  getImagesByProjectId: (projectId, callback) => {
    const sql = `
      SELECT i.id, i.filename, i.original_name, i.file_path, i.file_size, i.width, i.height, i.upload_time
      FROM images i
      INNER JOIN project_images pi ON pi.image_id = i.id
      WHERE pi.project_id = ?
      ORDER BY i.upload_time DESC
    `;
    db.all(sql, [projectId], callback);
  },

  // 根据ID获取图片
  getImageById: (id, callback) => {
    const sql = `
      SELECT id, filename, original_name, file_path, file_size, width, height, upload_time
      FROM images
      WHERE id = ?
    `;
    db.get(sql, [id], callback);
  },

  // 获取图片关联的所有项目ID
  getProjectIdsByImageId: (imageId) => {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT project_id FROM project_images WHERE image_id = ?',
        [imageId],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map((row) => row.project_id));
        }
      );
    });
  },

  // 删除图片
  deleteImage: (id, callback) => {
    const sql = 'DELETE FROM images WHERE id = ?';
    db.run(sql, [id], function(err) {
      callback(err, this.changes);
    });
  },

  // 将图片关联到项目
  linkImageToProject: (projectId, imageId, callback) => {
    const sql = `
      INSERT OR IGNORE INTO project_images (project_id, image_id)
      VALUES (?, ?)
    `;
    db.run(sql, [projectId, imageId], function(err) {
      if (callback) {
        callback(err, this.lastID);
      }
    });
  },

  // 保存标注数据（按 imageId 覆盖旧结果，保证每张图片只有一条标注记录）
  saveAnnotation: (annotationData, callback) => {
    const masks = JSON.stringify(annotationData.masks || []);
    const bboxes = JSON.stringify(annotationData.boundingBoxes || []);
    const polygons = JSON.stringify(annotationData.polygons || []);
    const labels = JSON.stringify(annotationData.labels || []);

    // 先检查该图片是否已有标注
    db.get('SELECT id FROM annotations WHERE image_id = ?', [annotationData.imageId], (err, row) => {
      if (err) {
        console.error('查询现有标注失败:', err);
        return callback(err, null);
      }

      if (row) {
        // 已存在标注，执行覆盖更新
        const sqlUpdate = `
          UPDATE annotations 
          SET mask_data = ?, bbox_data = ?, polygon_data = ?, labels = ?, updated_at = CURRENT_TIMESTAMP
          WHERE image_id = ?
        `;
        const paramsUpdate = [masks, bboxes, polygons, labels, annotationData.imageId];

        db.run(sqlUpdate, paramsUpdate, function(updateErr) {
          if (updateErr) {
            console.error('更新标注失败:', updateErr);
            return callback(updateErr, null);
          }
          callback(null, row.id);
        });
      } else {
        // 不存在标注，新建一条记录
        const sqlInsert = `
          INSERT INTO annotations 
          (id, image_id, mask_data, bbox_data, polygon_data, labels, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        const annotationId = annotationData.id || `anno_${Date.now()}_${Math.random()}`;
        const paramsInsert = [annotationId, annotationData.imageId, masks, bboxes, polygons, labels];

        db.run(sqlInsert, paramsInsert, function(insertErr) {
          if (insertErr) {
            console.error('插入标注失败:', insertErr);
            return callback(insertErr, null);
          }
          callback(null, annotationId);
        });
      }
    });
  },

  // 获取标注数据
  getAnnotationByImageId: (imageId, callback) => {
    const sql = `
      SELECT id, image_id, mask_data, bbox_data, polygon_data, labels, created_at, updated_at
      FROM annotations
      WHERE image_id = ?
    `;
    db.get(sql, [imageId], (err, row) => {
      if (err) {
        callback(err, null);
        return;
      }
      
      if (row) {
        // 解析JSON数据
        try {
          row.masks = JSON.parse(row.mask_data || '[]');
          row.boundingBoxes = JSON.parse(row.bbox_data || '[]');
          row.polygons = JSON.parse(row.polygon_data || '[]');
          row.labels = JSON.parse(row.labels || '[]');
        } catch (parseErr) {
          console.error('解析标注数据失败:', parseErr);
        }
      }
      
      callback(null, row);
    });
  },

  // 获取项目的标注汇总信息：总图片数、已标注图片数、最新标注的图片ID
  // 注意：只统计当前仍然存在于 images 表中的图片，避免引用已删除或旧格式数据
  getProjectAnnotationSummary: (projectId, callback) => {
    const sql = `
      SELECT
        COUNT(DISTINCT i.id) AS total_images,
        COUNT(DISTINCT a.image_id) AS annotated_images,
        MAX(a.updated_at) AS latest_updated_at
      FROM images i
      INNER JOIN project_images pi ON pi.image_id = i.id
      LEFT JOIN annotations a ON a.image_id = i.id
      WHERE pi.project_id = ?
    `;

    db.get(sql, [projectId], (err, row) => {
      if (err) return callback(err);

      // 找到最新标注的那张图片（按 updated_at 排序），且确保图片仍存在于 images 表
      const sqlLatest = `
        SELECT a.image_id AS image_id
        FROM annotations a
        INNER JOIN project_images pi ON pi.image_id = a.image_id
        INNER JOIN images i ON i.id = a.image_id
        WHERE pi.project_id = ?
        ORDER BY a.updated_at DESC
        LIMIT 1
      `;

      db.get(sqlLatest, [projectId], (latestErr, latestRow) => {
        if (latestErr) return callback(latestErr);

        callback(null, {
          totalImages: row?.total_images || 0,
          annotatedImages: row?.annotated_images || 0,
          latestAnnotatedImageId: latestRow?.image_id || null,
          latestUpdatedAt: row?.latest_updated_at || null,
        });
      });
    });
  },

  // 更新标注数据
  updateAnnotation: (annotationData, callback) => {
    const sql = `
      UPDATE annotations 
      SET mask_data = ?, bbox_data = ?, polygon_data = ?, labels = ?, updated_at = CURRENT_TIMESTAMP
      WHERE image_id = ?
    `;
    const params = [
      JSON.stringify(annotationData.masks || []),
      JSON.stringify(annotationData.boundingBoxes || []),
      JSON.stringify(annotationData.polygons || []),
      JSON.stringify(annotationData.labels || []),
      annotationData.imageId
    ];
    
    db.run(sql, params, function(err) {
      callback(err, this.changes);
    });
  },

  // 关闭数据库连接
  close: () => {
    db.close((err) => {
      if (err) {
        console.error('关闭数据库失败:', err.message);
      } else {
        console.log('数据库连接已关闭');
      }
    });
  },
  
  // 项目管理方法
  getAllProjects: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM projects ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  
  createProject: (name, description = '', accessCode = null) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO projects (name, description, access_code) VALUES (?, ?, ?)');
      stmt.run([name, description, accessCode], function(err) {
        if (err) reject(err);
        else {
          // 获取创建的项目信息
          db.get('SELECT * FROM projects WHERE id = ?', [this.lastID], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        }
      });
      stmt.finalize();
    });
  },
  
  // 根据验证码查找项目
  getProjectByAccessCode: (accessCode) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM projects WHERE access_code = ?', [accessCode], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  // 更新项目验证码
  updateProjectAccessCode: (projectId, accessCode) => {
    return new Promise((resolve, reject) => {
      db.run('UPDATE projects SET access_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
        [accessCode, projectId], function(err) {
        if (err) reject(err);
        else {
          db.get('SELECT * FROM projects WHERE id = ?', [projectId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        }
      });
    });
  },
  
  getProjectById: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM projects WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  updateProject: (id, name, description) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      stmt.run([name, description, id], function(err) {
        if (err) reject(err);
        else {
          // 获取更新后的项目信息
          db.get('SELECT * FROM projects WHERE id = ?', [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        }
      });
      stmt.finalize();
    });
  },
  
  deleteProject: (id) => {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM projects WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  // 删除项目及其关联的图片/标注（仅删除不再被其他项目引用的图片）
  deleteProjectWithRelated: (projectId, callback) => {
    db.serialize(() => {
      // 找到该项目关联的所有图片
      const sqlImages = `
        SELECT DISTINCT i.id, i.file_path
        FROM images i
        INNER JOIN project_images pi ON pi.image_id = i.id
        WHERE pi.project_id = ?
      `;

      db.all(sqlImages, [projectId], (err, images) => {
        if (err) {
          console.error('查询项目关联图片失败:', err);
          return callback(err);
        }

        if (!images || images.length === 0) {
          // 没有关联图片，直接删除项目
          db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr) {
            if (delErr) {
              console.error('删除项目失败:', delErr);
              return callback(delErr);
            }
            // 删除项目文件夹
            deleteProjectFolder(projectId);
            callback(null, this.changes);
          });
          return;
        }

        const imagesToDelete = [];
        let checked = 0;
        let hasError = false;

        // 检查每张图片是否还被其他项目引用
        images.forEach((img) => {
          const sqlCount = `
            SELECT COUNT(*) AS cnt
            FROM project_images
            WHERE image_id = ? AND project_id != ?
          `;
          db.get(sqlCount, [img.id, projectId], (countErr, row) => {
            if (countErr) {
              console.error('查询图片引用计数失败:', countErr);
              if (!hasError) {
                hasError = true;
                return callback(countErr);
              }
              return;
            }

            if (row && row.cnt === 0) {
              imagesToDelete.push(img);
            }

            checked++;
            if (checked === images.length && !hasError) {
              // 删除无需保留的图片记录和物理文件
              if (imagesToDelete.length === 0) {
                // 直接删除项目（project_images 通过外键 ON DELETE CASCADE 自动清理）
                db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr2) {
                  if (delErr2) {
                    console.error('删除项目失败:', delErr2);
                    return callback(delErr2);
                  }
                  // 删除项目文件夹
                  deleteProjectFolder(projectId);
                  callback(null, this.changes);
                });
                return;
              }

              let deleted = 0;
              imagesToDelete.forEach((imgToDel) => {
                db.run('DELETE FROM images WHERE id = ?', [imgToDel.id], function (imgDelErr) {
                  if (imgDelErr) {
                    console.error('删除图片记录失败:', imgDelErr);
                  } else if (imgToDel.file_path && fs.existsSync(imgToDel.file_path)) {
                    fs.unlink(imgToDel.file_path, (fsErr) => {
                      if (fsErr) {
                        console.error('删除图片文件失败:', fsErr);
                      }
                    });
                  }

                  deleted++;
                  if (deleted === imagesToDelete.length) {
                    // 最后删除项目
                    db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr3) {
                      if (delErr3) {
                        console.error('删除项目失败:', delErr3);
                        return callback(delErr3);
                      }
                      // 删除项目文件夹
                      deleteProjectFolder(projectId);
                      callback(null, this.changes);
                    });
                  }
                });
              });
            }
          });
        });
      });
    });
  },
  
  // ========== 用户管理方法 ==========
  // 创建用户（管理员）
  createUser: (username, passwordHash) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      stmt.run([username, passwordHash], function(err) {
        if (err) reject(err);
        else {
          db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [this.lastID], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        }
      });
      stmt.finalize();
    });
  },
  
  // 根据用户名查找用户
  getUserByUsername: (username) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  // 根据ID查找用户
  getUserById: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  // 获取所有用户
  getAllUsers: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  
  // ========== 项目访问权限管理方法 ==========
  // 记录session访问项目权限
  grantProjectAccess: (sessionId, projectId) => {
    return new Promise((resolve, reject) => {
      db.run('INSERT OR IGNORE INTO project_access (session_id, project_id) VALUES (?, ?)', 
        [sessionId, projectId], function(err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      });
    });
  },
  
  // 检查session是否有项目访问权限
  hasProjectAccess: (sessionId, projectId) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as cnt FROM project_access WHERE session_id = ? AND project_id = ?', 
        [sessionId, projectId], (err, row) => {
        if (err) reject(err);
        else resolve(row && row.cnt > 0);
      });
    });
  },
  
  // 获取session可访问的所有项目
  getAccessibleProjects: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT p.* FROM projects p
        INNER JOIN project_access pa ON pa.project_id = p.id
        WHERE pa.session_id = ?
        ORDER BY p.created_at DESC
      `, [sessionId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  
  // 清除session的所有访问权限（登出时）
  clearSessionAccess: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM project_access WHERE session_id = ?', [sessionId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }
};

module.exports = database;