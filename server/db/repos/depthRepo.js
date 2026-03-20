function makeDepthRepo(db) {
  return {
    insertDepthMap: (depthData, callback) => {
      const sql = `
        INSERT INTO depth_maps (project_id, image_id, camera_id, role, modality, filename, original_name, file_path, file_size, upload_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const params = [
        depthData.projectId,
        depthData.imageId || null,
        depthData.cameraId || null,
        depthData.role || null,
        depthData.modality || null,
        depthData.filename,
        depthData.originalName,
        depthData.path,
        depthData.size,
        depthData.uploadTime,
      ];

      db.run(sql, params, function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    getDepthMapsByProjectId: (projectId, callback) => {
      const sql = `
        SELECT id, project_id, image_id, camera_id, role, modality, filename, original_name, file_path, file_size, upload_time
        FROM depth_maps
        WHERE project_id = ?
        ORDER BY upload_time DESC
      `;
      db.all(sql, [projectId], callback);
    },

    getDepthMapsByImageId: (projectId, imageId, callback) => {
      const sql = `
        SELECT id, project_id, image_id, camera_id, role, modality, filename, original_name, file_path, file_size, upload_time
        FROM depth_maps
        WHERE project_id = ?
          AND image_id = ?
        ORDER BY upload_time DESC
      `;
      db.all(sql, [projectId, imageId], callback);
    },

    bindDepthMapsToImage: (projectId, depthIds, imageId, callback) => {
      if (!Array.isArray(depthIds) || depthIds.length === 0) {
        if (callback) callback(null, 0);
        return;
      }
      const placeholders = depthIds.map(() => '?').join(',');
      const sql = `
        UPDATE depth_maps
        SET image_id = ?
        WHERE project_id = ? AND id IN (${placeholders})
      `;
      const params = [imageId, projectId, ...depthIds];
      db.run(sql, params, function (err) {
        if (callback) callback(err, this.changes);
      });
    },

    // Backfill: set camera_id for rows that have role but missing camera_id
    // Used when older depth records were inserted before cameras linkage existed.
    backfillCameraIdByProjectAndRole: (projectId, role, cameraId, callback) => {
      const pid = Number(projectId);
      const r = role == null ? null : String(role).trim().toLowerCase();
      const cid = cameraId == null ? null : Number(cameraId);
      if (!pid || Number.isNaN(pid)) {
        if (callback) callback(new Error('projectId 非法'), 0);
        return;
      }
      if (!r) {
        if (callback) callback(new Error('role 不能为空'), 0);
        return;
      }
      if (!cid || Number.isNaN(cid)) {
        if (callback) callback(new Error('cameraId 非法'), 0);
        return;
      }
      const sql = `
        UPDATE depth_maps
        SET camera_id = ?
        WHERE project_id = ? AND role = ? AND (camera_id IS NULL OR camera_id = 0)
      `;
      db.run(sql, [cid, pid, r], function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },
  };
}

module.exports = { makeDepthRepo };

