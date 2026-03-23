function makePose9dRepo(db) {
  const parseJsonSafe = (raw, fallback = null) => {
    if (!raw || typeof raw !== 'string') return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  return {
    savePose9D: (imageId, meshId, poseJson, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      let poseObj = poseJson || {};
      if (typeof poseJson === 'string') {
        try { poseObj = JSON.parse(poseJson || '{}'); } catch (_) { poseObj = {}; }
      }
      const payload = JSON.stringify({ pose: poseObj });
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, diffdope_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id) DO UPDATE SET
          diffdope_json = excluded.diffdope_json,
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
        INSERT INTO pose9d_annotations (image_id, mesh_id, diffdope_json, initial_pose_json, updated_at)
        VALUES (?, ?, '{}', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id) DO UPDATE SET
          initial_pose_json = excluded.initial_pose_json,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(sql, [imageId, meshIdVal, payload], function (err) {
        if (callback) callback(err, this?.changes || 0);
      });
    },

    deletePose9DInitialPose: (imageId, meshId, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const sql = `
        UPDATE pose9d_annotations
        SET initial_pose_json = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE image_id = ? AND mesh_id = ?
      `;
      db.run(sql, [imageId, meshIdVal], function (err) {
        if (err) return callback(err, 0);
        callback(null, this?.changes || 0);
      });
    },

    updatePose9DDiffDope: (imageId, meshId, diffdopeJson, fitOverlayPath, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const payload =
        diffdopeJson == null ? null : (typeof diffdopeJson === 'string' ? diffdopeJson : JSON.stringify(diffdopeJson || {}));
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, diffdope_json, fit_overlay_path, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id) DO UPDATE SET
          diffdope_json = excluded.diffdope_json,
          fit_overlay_path = excluded.fit_overlay_path,
          updated_at = CURRENT_TIMESTAMP
      `;
      const params = [imageId, meshIdVal, payload || '{}', fitOverlayPath];
      db.run(sql, params, function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    getPose9D: (imageId, meshId, callback) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const baseSql = `
        SELECT id, image_id, mesh_id, diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
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
        row.pose = null;
        row.diffdope = parseJsonSafe(row.diffdope_json, null);
        row.initialPose = parseJsonSafe(row.initial_pose_json, null);
        row.fitOverlayPath = row.fit_overlay_path || null;
        if (row.diffdope && row.diffdope.pose) row.pose = row.diffdope.pose;
        callback(null, row);
      });
    },

    listPose9DByImageId: (imageId, callback) => {
      const sql = `
        SELECT id, image_id, mesh_id, diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
        FROM pose9d_annotations
        WHERE image_id = ?
        ORDER BY updated_at DESC
      `;
      db.all(sql, [imageId], (err, rows) => {
        if (err) return callback(err, []);
        const formatted = (rows || []).map((row) => {
          const r = { ...row };
          r.pose = null;
          r.diffdope = parseJsonSafe(row.diffdope_json, null);
          r.initialPose = parseJsonSafe(row.initial_pose_json, null);
          r.fitOverlayPath = row.fit_overlay_path || null;
          if (r.diffdope && r.diffdope.pose) r.pose = r.diffdope.pose;
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

    clearPose9DByImageId: (imageId, callback) => {
      const sql = `
        DELETE FROM pose9d_annotations
        WHERE image_id = ?
      `;
      db.run(sql, [Number(imageId)], function (err) {
        if (err) return callback(err, 0);
        callback(null, this?.changes || 0);
      });
    },
  };
}

module.exports = { makePose9dRepo };

