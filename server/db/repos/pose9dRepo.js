function makePose9dRepo(db) {
  return {
    savePose9D: (imageId, meshId, poseJson, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const payload = typeof poseJson === 'string' ? poseJson : JSON.stringify(poseJson || {});
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, pose_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id) DO UPDATE SET
          pose_json = excluded.pose_json,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(sql, [imageId, meshIdVal, payload], function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    updatePose9DInitialPose: (imageId, meshId, initialPoseJson, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const payload =
        initialPoseJson == null
          ? null
          : (typeof initialPoseJson === 'string' ? initialPoseJson : JSON.stringify(initialPoseJson || {}));
      const sql = `
        UPDATE pose9d_annotations
        SET initial_pose_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE image_id = ? AND mesh_id ${meshIdVal == null ? 'IS NULL' : '= ?'}
      `;
      const params = meshIdVal == null ? [payload, imageId] : [payload, imageId, meshIdVal];
      db.run(sql, params, function (err) {
        if (err && String(err?.message || '').includes('no such column: initial_pose_json')) {
          if (callback) return callback(null, 0);
          return;
        }
        if (callback) callback(err, this.changes || 0);
      });
    },

    updatePose9DDiffDope: (imageId, meshId, diffdopeJson, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const payload =
        diffdopeJson == null ? null : (typeof diffdopeJson === 'string' ? diffdopeJson : JSON.stringify(diffdopeJson || {}));
      const sql = `
        UPDATE pose9d_annotations
        SET diffdope_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE image_id = ? AND mesh_id ${meshIdVal == null ? 'IS NULL' : '= ?'}
      `;
      const params = meshIdVal == null ? [payload, imageId] : [payload, imageId, meshIdVal];
      db.run(sql, params, function (err) {
        if (err && String(err?.message || '').includes('no such column: diffdope_json')) {
          if (callback) return callback(null, 0);
          return;
        }
        if (callback) callback(err, this.changes || 0);
      });
    },

    getPose9D: (imageId, meshId, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const baseSql = `
        SELECT id, image_id, mesh_id, pose_json, initial_pose_json, diffdope_json, created_at, updated_at
        FROM pose9d_annotations
        WHERE image_id = ?
      `;
      const sql =
        meshIdVal == null
          ? `${baseSql} ORDER BY updated_at DESC LIMIT 1`
          : `${baseSql} AND mesh_id = ? ORDER BY updated_at DESC LIMIT 1`;
      const params = meshIdVal == null ? [imageId] : [imageId, meshIdVal];
      db.get(sql, params, (err, row) => {
        if (err) return callback(err, null);
        if (!row) return callback(null, null);
        try { row.pose = JSON.parse(row.pose_json || '{}'); } catch (_) { row.pose = null; }
        try { row.initialPose = row.initial_pose_json ? JSON.parse(row.initial_pose_json) : null; } catch (_) { row.initialPose = null; }
        try { row.diffdope = row.diffdope_json ? JSON.parse(row.diffdope_json) : null; } catch (_) { row.diffdope = null; }
        callback(null, row);
      });
    },

    listPose9DByImageId: (imageId, callback) => {
      const sql = `
        SELECT id, image_id, mesh_id, pose_json, initial_pose_json, diffdope_json, created_at, updated_at
        FROM pose9d_annotations
        WHERE image_id = ?
        ORDER BY updated_at DESC
      `;
      db.all(sql, [imageId], (err, rows) => {
        if (err) return callback(err, []);
        const formatted = (rows || []).map((row) => {
          const r = { ...row };
          try { r.pose = JSON.parse(row.pose_json || '{}'); } catch (_) { r.pose = null; }
          try { r.initialPose = row.initial_pose_json ? JSON.parse(row.initial_pose_json) : null; } catch (_) { r.initialPose = null; }
          try { r.diffdope = row.diffdope_json ? JSON.parse(row.diffdope_json) : null; } catch (_) { r.diffdope = null; }
          return r;
        });
        callback(null, formatted);
      });
    },

    deletePose9D: (imageId, meshId, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const sql = `
        DELETE FROM pose9d_annotations
        WHERE image_id = ? AND mesh_id ${meshIdVal == null ? 'IS NULL' : '= ?'}
      `;
      const params = meshIdVal == null ? [imageId] : [imageId, meshIdVal];
      db.run(sql, params, function (err) {
        if (err) return callback(err, 0);
        callback(null, this.changes || 0);
      });
    },
  };
}

module.exports = { makePose9dRepo };

