function makeDepthRepo(db) {
  return {
    insertDepthMap: (depthData, callback) => {
      const sql = `
        INSERT INTO depth_maps (
          project_id, image_id, camera_id, role, modality, filename, file_path, file_size, upload_time,
          depth_raw_fix_path, depth_png_fix_path
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const params = [
        depthData.projectId,
        depthData.imageId || null,
        depthData.cameraId || null,
        depthData.role || null,
        depthData.modality || null,
        depthData.filename,
        depthData.path,
        depthData.size,
        depthData.uploadTime,
        depthData.depthRawFixPath || null,
        depthData.depthPngFixPath || null,
      ];

      db.run(sql, params, function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    getDepthMapsByProjectId: (projectId, callback) => {
      const sql = `
        SELECT
          id, project_id, image_id, camera_id, role, modality, filename, file_path, file_size, upload_time,
          depth_raw_fix_path, depth_png_fix_path
        FROM depth_maps
        WHERE project_id = ?
        ORDER BY upload_time DESC
      `;
      db.all(sql, [projectId], callback);
    },

    getDepthMapsByImageId: (projectId, imageId, callback) => {
      const sql = `
        SELECT
          id, project_id, image_id, camera_id, role, modality, filename, file_path, file_size, upload_time,
          depth_raw_fix_path, depth_png_fix_path
        FROM depth_maps
        WHERE project_id = ?
          AND image_id = ?
        ORDER BY upload_time DESC
      `;
      db.all(sql, [projectId, imageId], callback);
    },

    deleteDepthMapsByImageId: (projectId, imageId, callback) => {
      const sql = `
        DELETE FROM depth_maps
        WHERE project_id = ?
          AND image_id = ?
      `;
      db.run(sql, [Number(projectId), Number(imageId)], function (err) {
        if (callback) callback(err, this?.changes || 0);
      });
    },

    listDepthRepairRecordsByImageId: (projectId, imageId, callback) => {
      const sql = `
        SELECT id, project_id, image_id, role, depth_raw_path, depth_png_path, depth_raw_fix_path, depth_png_fix_path, status
        FROM depth_repair_records
        WHERE project_id = ?
          AND image_id = ?
      `;
      db.all(sql, [Number(projectId), Number(imageId)], callback);
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

    upsertDepthRepairRecord: (record, callback) => {
      const sql = `
        INSERT INTO depth_repair_records (
          project_id, image_id, role, depth_raw_path, depth_png_path, depth_raw_fix_path, depth_png_fix_path, status, note, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id, image_id, role)
        DO UPDATE SET
          depth_raw_path = excluded.depth_raw_path,
          depth_png_path = excluded.depth_png_path,
          depth_raw_fix_path = excluded.depth_raw_fix_path,
          depth_png_fix_path = excluded.depth_png_fix_path,
          status = excluded.status,
          note = excluded.note,
          updated_at = CURRENT_TIMESTAMP
      `;
      const params = [
        Number(record.projectId),
        Number(record.imageId),
        record.role ? String(record.role).trim().toLowerCase() : null,
        record.depthRawPath || null,
        record.depthPngPath || null,
        record.depthRawFixPath || null,
        record.depthPngFixPath || null,
        record.status || 'pending',
        record.note || null,
      ];
      db.run(sql, params, function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    updateDepthFixPathsByProjectImageRole: (projectId, imageId, role, depthRawFixPath, depthPngFixPath, callback) => {
      const pid = Number(projectId);
      const iid = Number(imageId);
      const r = role == null ? null : String(role).trim().toLowerCase();
      if (!pid || Number.isNaN(pid) || !iid || Number.isNaN(iid) || !r) {
        if (callback) callback(new Error('projectId/imageId/role 非法'), 0);
        return;
      }
      const sql = `
        UPDATE depth_maps
        SET depth_raw_fix_path = ?, depth_png_fix_path = ?
        WHERE project_id = ? AND image_id = ? AND role = ?
      `;
      db.run(sql, [depthRawFixPath || null, depthPngFixPath || null, pid, iid, r], function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    // 统计批量补全深度的总图像数（按 project）
    countImagesByProjectId: (projectId, callback) => {
      const pid = Number(projectId);
      if (!pid || Number.isNaN(pid)) {
        if (callback) callback(new Error('projectId 非法'), 0);
        return;
      }
      // images 表不一定直接包含 project_id；用 project_images 关联表来统计
      db.get(
        'SELECT COUNT(DISTINCT image_id) as cnt FROM project_images WHERE project_id = ?',
        [pid],
        (err, row) => {
        if (err) return callback(err, 0);
        return callback(null, row?.cnt || 0);
        },
      );
    },

    // 基于 sinceMs 统计 depth_repair_records 的 done/failed/processed 图像数（去重 image_id）
    getDepthRepairBatchProgressBySince: (projectId, sinceIso, callback) => {
      const pid = Number(projectId);
      if (!pid || Number.isNaN(pid)) {
        if (callback) callback(new Error('projectId 非法'), null);
        return;
      }

      const sql = `
        SELECT
          (SELECT COUNT(DISTINCT image_id)
             FROM depth_repair_records
             WHERE project_id = ? AND datetime(updated_at) >= datetime(?) AND status = 'done'
          ) AS doneImages,
          (SELECT COUNT(DISTINCT image_id)
             FROM depth_repair_records
             WHERE project_id = ? AND datetime(updated_at) >= datetime(?) AND status = 'failed'
          ) AS failedImages,
          (SELECT COUNT(DISTINCT image_id)
             FROM depth_repair_records
             WHERE project_id = ? AND datetime(updated_at) >= datetime(?) AND status IN ('done','failed')
          ) AS processedImages
      `;

      // 由于 sqlite 的子查询重复绑定，params 需要覆盖三次 projectId/since
      const params = [pid, sinceIso, pid, sinceIso, pid, sinceIso];
      db.get(sql, params, (err, row) => {
        if (err) return callback(err, null);
        return callback(null, row || { doneImages: 0, failedImages: 0, processedImages: 0 });
      });
    },
  };
}

module.exports = { makeDepthRepo };

