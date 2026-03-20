function makeAnnotationsRepo(db) {
  return {
    saveAnnotation: (annotationData, callback) => {
      const masks = JSON.stringify(annotationData.masks || []);
      const bboxes = JSON.stringify(annotationData.boundingBoxes || []);

      db.get('SELECT id FROM annotations WHERE image_id = ?', [annotationData.imageId], (err, row) => {
        if (err) {
          console.error('查询现有标注失败:', err);
          return callback(err, null);
        }

        if (row) {
          const sqlUpdate = `
            UPDATE annotations 
            SET mask_data = ?, bbox_data = ?, updated_at = CURRENT_TIMESTAMP
            WHERE image_id = ?
          `;
          const paramsUpdate = [masks, bboxes, annotationData.imageId];
          db.run(sqlUpdate, paramsUpdate, function (updateErr) {
            if (updateErr) {
              console.error('更新标注失败:', updateErr);
              return callback(updateErr, null);
            }
            callback(null, row.id);
          });
        } else {
          const sqlInsert = `
            INSERT INTO annotations 
            (id, image_id, mask_data, bbox_data, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          `;
          const annotationId = annotationData.id || `anno_${Date.now()}_${Math.random()}`;
          const paramsInsert = [annotationId, annotationData.imageId, masks, bboxes];
          db.run(sqlInsert, paramsInsert, function (insertErr) {
            if (insertErr) {
              console.error('插入标注失败:', insertErr);
              return callback(insertErr, null);
            }
            callback(null, annotationId);
          });
        }
      });
    },

    getAnnotationByImageId: (imageId, callback) => {
      const sql = `
        SELECT id, image_id, mask_data, bbox_data, created_at, updated_at
        FROM annotations
        WHERE image_id = ?
      `;
      db.get(sql, [imageId], (err, row) => {
        if (err) return callback(err, null);
        if (row) {
          try {
            row.masks = JSON.parse(row.mask_data || '[]');
            row.boundingBoxes = JSON.parse(row.bbox_data || '[]');
            // polygon_data / labels 列已弃用（开发阶段手动删除），这里保持为空数组以兼容前端结构
            row.polygons = [];
            row.labels = [];
          } catch (parseErr) {
            console.error('解析标注数据失败:', parseErr);
          }
        }
        callback(null, row);
      });
    },

    updateAnnotation: (annotationData, callback) => {
      const sql = `
        UPDATE annotations 
        SET mask_data = ?, bbox_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE image_id = ?
      `;
      const params = [
        JSON.stringify(annotationData.masks || []),
        JSON.stringify(annotationData.boundingBoxes || []),
        annotationData.imageId,
      ];
      db.run(sql, params, function (err) {
        callback(err, this.changes);
      });
    },

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
  };
}

module.exports = { makeAnnotationsRepo };

