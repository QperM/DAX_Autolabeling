const fs = require('fs');
const path = require('path');
const { getUploadsRootDir } = require('../../utils/dataPaths');

function makePose9dRepo(db) {
  const DEFAULT_MASK_ID = '__mesh_default__';
  const normalizeMaskId = (maskId) => {
    if (typeof maskId !== 'string') return DEFAULT_MASK_ID;
    const trimmed = maskId.trim();
    return trimmed || DEFAULT_MASK_ID;
  };
  const normalizeMaskIndex = (maskIndex) => {
    const n = Number(maskIndex);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const resolveFitOverlayAbsPath = (fitOverlayWebPath) => {
    if (typeof fitOverlayWebPath !== 'string' || !fitOverlayWebPath.startsWith('/uploads/')) return null;
    // `/uploads/project_3/pose-fit-overlays/xxx.png` -> `<uploadsRootDir>/project_3/pose-fit-overlays/xxx.png`
    const rel = fitOverlayWebPath.replace(/^\/uploads\//, '');
    if (!rel) return null;
    return path.join(getUploadsRootDir(), rel);
  };

  const fileExists = (absPath) => {
    if (!absPath) return false;
    try {
      return fs.existsSync(absPath);
    } catch (_) {
      return false;
    }
  };

  const normalizeFitOverlayPath = (row) => {
    const web = row?.fit_overlay_path;
    const abs = resolveFitOverlayAbsPath(web);
    if (!web || !abs || !fileExists(abs)) return null;
    return web;
  };

  const parseJsonSafe = (raw, fallback = null) => {
    if (!raw || typeof raw !== 'string') return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  return {
    savePose9D: (imageId, meshId, poseJson, callback, options = {}) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal = normalizeMaskId(options?.maskId);
      const maskIndexVal = normalizeMaskIndex(options?.maskIndex);
      let poseObj = poseJson || {};
      if (typeof poseJson === 'string') {
        try { poseObj = JSON.parse(poseJson || '{}'); } catch (_) { poseObj = {}; }
      }
      const payload = JSON.stringify({ pose: poseObj });
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, mask_id, mask_index, diffdope_json, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id, mask_id) DO UPDATE SET
          mask_index = excluded.mask_index,
          diffdope_json = excluded.diffdope_json,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(sql, [imageId, meshIdVal, maskIdVal, maskIndexVal, payload], function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    updatePose9DInitialPose: (imageId, meshId, initialPoseJson, callback, options = {}) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal = normalizeMaskId(options?.maskId);
      const maskIndexVal = normalizeMaskIndex(options?.maskIndex);
      const payload =
        initialPoseJson == null
          ? null
          : (typeof initialPoseJson === 'string' ? initialPoseJson : JSON.stringify(initialPoseJson || {}));
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, mask_id, mask_index, diffdope_json, initial_pose_json, updated_at)
        VALUES (?, ?, ?, ?, '{}', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id, mask_id) DO UPDATE SET
          mask_index = excluded.mask_index,
          initial_pose_json = excluded.initial_pose_json,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(sql, [imageId, meshIdVal, maskIdVal, maskIndexVal, payload], function (err) {
        if (callback) callback(err, this?.changes || 0);
      });
    },

    deletePose9DInitialPose: (imageId, meshId, callback, options = {}) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal = options && typeof options.maskId === 'string' ? options.maskId.trim() : '';
      const hasMaskId = !!maskIdVal;
      const sql = hasMaskId
        ? `
          UPDATE pose9d_annotations
          SET initial_pose_json = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE image_id = ? AND mesh_id = ? AND mask_id = ?
        `
        : `
          UPDATE pose9d_annotations
          SET initial_pose_json = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE image_id = ? AND mesh_id = ?
        `;
      const params = hasMaskId ? [imageId, meshIdVal, maskIdVal] : [imageId, meshIdVal];
      db.run(sql, params, function (err) {
        if (err) return callback(err, 0);
        callback(null, this?.changes || 0);
      });
    },

    updatePose9DDiffDope: (imageId, meshId, diffdopeJson, fitOverlayPath, callback, options = {}) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal = normalizeMaskId(options?.maskId);
      const maskIndexVal = normalizeMaskIndex(options?.maskIndex);
      const payload =
        diffdopeJson == null ? null : (typeof diffdopeJson === 'string' ? diffdopeJson : JSON.stringify(diffdopeJson || {}));
      const sql = `
        INSERT INTO pose9d_annotations (image_id, mesh_id, mask_id, mask_index, diffdope_json, fit_overlay_path, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(image_id, mesh_id, mask_id) DO UPDATE SET
          mask_index = excluded.mask_index,
          diffdope_json = excluded.diffdope_json,
          fit_overlay_path = excluded.fit_overlay_path,
          updated_at = CURRENT_TIMESTAMP
      `;
      const params = [imageId, meshIdVal, maskIdVal, maskIndexVal, payload || '{}', fitOverlayPath];
      db.run(sql, params, function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    getPose9D: (imageId, meshId, maskIdOrCallback, callbackMaybe) => {
      const callback = typeof maskIdOrCallback === 'function' ? maskIdOrCallback : callbackMaybe;
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal =
        typeof maskIdOrCallback === 'string' && maskIdOrCallback.trim()
          ? maskIdOrCallback.trim()
          : null;
      const baseSql = `
        SELECT id, image_id, mesh_id, mask_id, mask_index, diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
        FROM pose9d_annotations
        WHERE image_id = ?
      `;
      let sql = `${baseSql} ORDER BY updated_at DESC LIMIT 1`;
      let params = [imageId];
      if (meshIdVal != null && maskIdVal) {
        sql = `${baseSql} AND mesh_id = ? AND mask_id = ? ORDER BY updated_at DESC LIMIT 1`;
        params = [imageId, meshIdVal, maskIdVal];
      } else if (meshIdVal != null) {
        sql = `${baseSql} AND mesh_id = ? ORDER BY updated_at DESC LIMIT 1`;
        params = [imageId, meshIdVal];
      }
      db.get(sql, params, (err, row) => {
        if (err) return callback(err, null);
        if (!row) return callback(null, null);
        row.pose = null;
        row.diffdope = parseJsonSafe(row.diffdope_json, null);
        row.initialPose = parseJsonSafe(row.initial_pose_json, null);
        row.fitOverlayPath = normalizeFitOverlayPath(row);
        if (row.diffdope && row.diffdope.pose) row.pose = row.diffdope.pose;
        callback(null, row);
      });
    },

    listPose9DByImageId: (imageId, callback) => {
      const sql = `
        SELECT id, image_id, mesh_id, mask_id, mask_index, diffdope_json, initial_pose_json, fit_overlay_path, created_at, updated_at
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
          r.fitOverlayPath = normalizeFitOverlayPath(row);
          if (r.diffdope && r.diffdope.pose) r.pose = r.diffdope.pose;
          return r;
        });
        callback(null, formatted);
      });
    },

    deletePose9D: (imageId, meshId, callback, options = {}) => {
      const meshIdVal = meshId == null ? null : Number(meshId);
      const maskIdVal = options && typeof options.maskId === 'string' ? options.maskId.trim() : '';
      const hasMaskId = !!maskIdVal;
      const sql = hasMaskId
        ? `
          DELETE FROM pose9d_annotations
          WHERE image_id = ? AND mesh_id ${meshIdVal == null ? 'IS NULL' : '= ?'} AND mask_id = ?
        `
        : `
          DELETE FROM pose9d_annotations
          WHERE image_id = ? AND mesh_id ${meshIdVal == null ? 'IS NULL' : '= ?'}
        `;
      const params = hasMaskId
        ? (meshIdVal == null ? [imageId, maskIdVal] : [imageId, meshIdVal, maskIdVal])
        : (meshIdVal == null ? [imageId] : [imageId, meshIdVal]);
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

