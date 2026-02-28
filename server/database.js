const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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
    initializeDatabase();
  }
});

// 初始化数据库表
function initializeDatabase() {
  // 创建projects表
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 创建images表
  db.run(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      upload_time TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('创建images表失败:', err.message);
    } else {
      console.log('✅ images表创建成功');
    }
  });

  // 创建annotations表
  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      image_id TEXT NOT NULL,
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
      image_id TEXT NOT NULL,
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
    const sql = `
      INSERT INTO images (id, filename, original_name, file_path, file_size, width, height, upload_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      imageData.id,
      imageData.filename,
      imageData.originalName,
      imageData.path,
      imageData.size,
      imageData.width || null,
      imageData.height || null,
      imageData.uploadTime
    ];
    
    db.run(sql, params, function(err) {
      callback(err, this.lastID);
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

  // 保存标注数据
  saveAnnotation: (annotationData, callback) => {
    const sql = `
      INSERT OR REPLACE INTO annotations 
      (id, image_id, mask_data, bbox_data, polygon_data, labels, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    const params = [
      annotationData.id || `anno_${Date.now()}_${Math.random()}`,
      annotationData.imageId,
      JSON.stringify(annotationData.masks || []),
      JSON.stringify(annotationData.boundingBoxes || []),
      JSON.stringify(annotationData.polygons || []),
      JSON.stringify(annotationData.labels || [])
    ];
    
    db.run(sql, params, function(err) {
      callback(err, this.lastID);
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
  
  createProject: (name, description = '') => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)');
      stmt.run([name, description], function(err) {
        if (err) reject(err);
        else {
          resolve({
            id: this.lastID,
            name,
            description,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        }
      });
      stmt.finalize();
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
  }
};

module.exports = database;