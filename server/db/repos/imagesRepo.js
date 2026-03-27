const fs = require('fs');
const path = require('path');
const { buildRgbStoredBasename } = require('../../utils/rgbImageFilename');

// 兼容 image-size 不同导出形式（v2+ 通常是 { imageSize }）
const imageSizeModule = require('image-size');
const sizeOf = imageSizeModule.imageSize || imageSizeModule;

function makeImagesRepo(db) {
  return {
    insertImage: (imageData, callback) => {
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
        imageData.originalName != null ? String(imageData.originalName) : '',
        imageData.path,
        imageData.size,
        width,
        height,
        imageData.uploadTime,
      ];

      db.run(sql, params, function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    /** 将临时落盘文件重命名为 rgb_img{id}_… 并回写 filename / file_path */
    finalizeRgbImageStorage: (imageId, originalDisplayName, currentAbsPath, callback) => {
      const id = Number(imageId);
      if (!Number.isFinite(id) || id <= 0) {
        return callback(new Error('finalizeRgbImageStorage: invalid imageId'));
      }
      const cur = String(currentAbsPath || '');
      if (!cur || !fs.existsSync(cur)) {
        return callback(new Error('finalizeRgbImageStorage: file missing'));
      }
      const finalName = buildRgbStoredBasename(id, originalDisplayName, cur);
      const dir = path.dirname(cur);
      const newAbsPath = path.join(dir, finalName);

      if (path.basename(cur) === finalName) {
        return db.run(
          'UPDATE images SET filename = ?, file_path = ? WHERE id = ?',
          [finalName, newAbsPath, id],
          (err) => (err ? callback(err) : callback(null, { filename: finalName, path: newAbsPath })),
        );
      }

      if (fs.existsSync(newAbsPath)) {
        try {
          fs.unlinkSync(newAbsPath);
        } catch (_) {}
      }
      try {
        fs.renameSync(cur, newAbsPath);
      } catch (e) {
        return callback(e);
      }
      db.run(
        'UPDATE images SET filename = ?, file_path = ? WHERE id = ?',
        [finalName, newAbsPath, id],
        (err) => (err ? callback(err) : callback(null, { filename: finalName, path: newAbsPath })),
      );
    },

    getAllImages: (callback) => {
      const sql = `
        SELECT id, filename, original_name, file_path, file_size, width, height, upload_time
        FROM images
        ORDER BY upload_time DESC
      `;
      db.all(sql, [], callback);
    },

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

    getImageById: (id, callback) => {
      const sql = `
        SELECT id, filename, original_name, file_path, file_size, width, height, upload_time
        FROM images
        WHERE id = ?
      `;
      db.get(sql, [id], callback);
    },

    deleteImage: (id, callback) => {
      const sql = 'DELETE FROM images WHERE id = ?';
      db.run(sql, [id], function (err) {
        callback(err, this.changes);
      });
    },

    linkImageToProject: (projectId, imageId, callback) => {
      const sql = `
        INSERT OR IGNORE INTO project_images (project_id, image_id)
        VALUES (?, ?)
      `;
      db.run(sql, [projectId, imageId], function (err) {
        if (callback) callback(err, this.lastID);
      });
    },

    getProjectIdsByImageId: (imageId) => {
      return new Promise((resolve, reject) => {
        db.all('SELECT project_id FROM project_images WHERE image_id = ?', [imageId], (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map((row) => row.project_id));
        });
      });
    },
  };
}

module.exports = { makeImagesRepo };

