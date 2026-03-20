function makeCamerasRepo(db) {
  return {
    upsertCameraIntrinsics: (cameraData, callback) => {
      const projectId = Number(cameraData.projectId);
      const role = String(cameraData.role || '').trim().toLowerCase();
      const intrinsicsJson =
        cameraData.intrinsicsJson == null
          ? null
          : (typeof cameraData.intrinsicsJson === 'string' ? cameraData.intrinsicsJson : JSON.stringify(cameraData.intrinsicsJson || {}));
      const intrinsicsFilePath = cameraData.intrinsicsFilePath || null;
      const intrinsicsOriginalName = cameraData.intrinsicsOriginalName || null;
      const intrinsicsFileSize = cameraData.intrinsicsFileSize || null;

      if (!projectId || Number.isNaN(projectId)) return callback(new Error('projectId 非法'), null);
      if (!role) return callback(new Error('role 不能为空'), null);

      const sql = `
        INSERT INTO cameras (
          project_id, role,
          intrinsics_json,
          intrinsics_file_path, intrinsics_original_name, intrinsics_file_size,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id, role) DO UPDATE SET
          intrinsics_json = excluded.intrinsics_json,
          intrinsics_file_path = excluded.intrinsics_file_path,
          intrinsics_original_name = excluded.intrinsics_original_name,
          intrinsics_file_size = excluded.intrinsics_file_size,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(
        sql,
        [projectId, role, intrinsicsJson, intrinsicsFilePath, intrinsicsOriginalName, intrinsicsFileSize],
        function (err) {
          if (err) return callback(err, null);
          // sqlite3: lastID on insert; on update it can be stale, so re-select id
          db.get(
            'SELECT id FROM cameras WHERE project_id = ? AND role = ? LIMIT 1',
            [projectId, role],
            (selErr, row) => {
              if (selErr) return callback(selErr, null);
              callback(null, row?.id ?? null);
            },
          );
        },
      );
    },

    getCameraByProjectAndRole: (projectId, role, callback) => {
      const pid = Number(projectId);
      const r = String(role || '').trim().toLowerCase();
      const sql = `
        SELECT id, project_id, role, intrinsics_json, intrinsics_file_path, intrinsics_original_name, intrinsics_file_size,
               created_at, updated_at
        FROM cameras
        WHERE project_id = ? AND role = ?
        LIMIT 1
      `;
      db.get(sql, [pid, r], (err, row) => {
        if (err) return callback(err, null);
        callback(null, row || null);
      });
    },

    listCamerasByProjectId: (projectId, callback) => {
      const pid = Number(projectId);
      const sql = `
        SELECT id, project_id, role, intrinsics_json, intrinsics_file_path, intrinsics_original_name, intrinsics_file_size,
               created_at, updated_at
        FROM cameras
        WHERE project_id = ?
        ORDER BY role ASC, updated_at DESC
      `;
      db.all(sql, [pid], callback);
    },
  };
}

module.exports = { makeCamerasRepo };

