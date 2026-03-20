function makeMeshesRepo(db) {
  return {
    insertMesh: (meshData, callback) => {
      const sql = `
        INSERT INTO meshes (project_id, filename, original_name, file_path, file_size, bbox_json, upload_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      const params = [
        meshData.projectId,
        meshData.filename,
        meshData.originalName,
        meshData.path,
        meshData.size,
        meshData.bboxJson ?? null,
        meshData.uploadTime,
      ];

      db.run(sql, params, function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      });
    },

    getMeshesByProjectId: (projectId, callback) => {
      const sql = `
        SELECT id, project_id, filename, original_name, file_path, file_size, bbox_json, upload_time, sku_label
        FROM meshes
        WHERE project_id = ?
        ORDER BY upload_time DESC
      `;
      db.all(sql, [projectId], callback);
    },

    getMeshById: (meshId, callback) => {
      const sql = `
        SELECT id, project_id, filename, original_name, file_path, file_size, bbox_json, upload_time
        FROM meshes
        WHERE id = ?
        LIMIT 1
      `;
      db.get(sql, [meshId], callback);
    },

    deleteMeshById: (meshId, callback) => {
      const sql = `DELETE FROM meshes WHERE id = ?`;
      db.run(sql, [meshId], function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    deletePose9DByMeshId: (meshId, callback) => {
      const sql = `DELETE FROM pose9d_annotations WHERE mesh_id = ?`;
      db.run(sql, [meshId], function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },

    updateMeshSkuLabel: (meshId, skuLabel, callback) => {
      const sql = `UPDATE meshes SET sku_label = ? WHERE id = ?`;
      db.run(sql, [skuLabel ?? null, meshId], function (err) {
        if (callback) callback(err, this.changes || 0);
      });
    },
  };
}

module.exports = { makeMeshesRepo };

