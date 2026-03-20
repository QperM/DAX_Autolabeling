const fs = require('fs');

function makeProjectsRepo(db, { deleteProjectFolder }) {
  return {
    getAllProjects: () =>
      new Promise((resolve, reject) => {
        db.all('SELECT * FROM projects ORDER BY created_at DESC', (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      }),

    createProject: (name, description = '', accessCode = null) =>
      new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT INTO projects (name, description, access_code) VALUES (?, ?, ?)');
        stmt.run([name, description, accessCode], function (err) {
          if (err) reject(err);
          else {
            db.get('SELECT * FROM projects WHERE id = ?', [this.lastID], (e, row) => {
              if (e) reject(e);
              else resolve(row);
            });
          }
        });
        stmt.finalize();
      }),

    getProjectByAccessCode: (accessCode) =>
      new Promise((resolve, reject) => {
        db.get('SELECT * FROM projects WHERE access_code = ?', [accessCode], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      }),

    updateProjectAccessCode: (projectId, accessCode) =>
      new Promise((resolve, reject) => {
        db.run(
          'UPDATE projects SET access_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [accessCode, projectId],
          function (err) {
            if (err) reject(err);
            else {
              db.get('SELECT * FROM projects WHERE id = ?', [projectId], (e, row) => {
                if (e) reject(e);
                else resolve(row);
              });
            }
          },
        );
      }),

    getProjectById: (id) =>
      new Promise((resolve, reject) => {
        db.get('SELECT * FROM projects WHERE id = ?', [id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      }),

    toggleProjectLock: (projectId, locked) =>
      new Promise((resolve, reject) => {
        db.run(
          'UPDATE projects SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [locked ? 1 : 0, projectId],
          function (err) {
            if (err) reject(err);
            else {
              db.get('SELECT * FROM projects WHERE id = ?', [projectId], (e, row) => {
                if (e) reject(e);
                else resolve(row);
              });
            }
          },
        );
      }),

    updateProject: (id, name, description) =>
      new Promise((resolve, reject) => {
        const stmt = db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        stmt.run([name, description, id], function (err) {
          if (err) reject(err);
          else {
            db.get('SELECT * FROM projects WHERE id = ?', [id], (e, row) => {
              if (e) reject(e);
              else resolve(row);
            });
          }
        });
        stmt.finalize();
      }),

    deleteProject: (id) =>
      new Promise((resolve, reject) => {
        db.run('DELETE FROM projects WHERE id = ?', [id], function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      }),

    deleteProjectWithRelated: (projectId, callback) => {
      db.serialize(() => {
        const sqlImages = `
          SELECT DISTINCT i.id, i.file_path
          FROM images i
          INNER JOIN project_images pi ON pi.image_id = i.id
          WHERE pi.project_id = ?
        `;

        db.all(sqlImages, [projectId], (err, images) => {
          if (err) {
            console.error('查询项目关联图片失败:', err);
            return callback(err);
          }

          if (!images || images.length === 0) {
            db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr) {
              if (delErr) return callback(delErr);
              deleteProjectFolder(projectId);
              callback(null, this.changes);
            });
            return;
          }

          const imagesToDelete = [];
          let checked = 0;
          let hasError = false;

          images.forEach((img) => {
            const sqlCount = `
              SELECT COUNT(*) AS cnt
              FROM project_images
              WHERE image_id = ? AND project_id != ?
            `;
            db.get(sqlCount, [img.id, projectId], (countErr, row) => {
              if (countErr) {
                if (!hasError) {
                  hasError = true;
                  return callback(countErr);
                }
                return;
              }

              if (row && row.cnt === 0) imagesToDelete.push(img);

              checked++;
              if (checked === images.length && !hasError) {
                if (imagesToDelete.length === 0) {
                  db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr2) {
                    if (delErr2) return callback(delErr2);
                    deleteProjectFolder(projectId);
                    callback(null, this.changes);
                  });
                  return;
                }

                let deleted = 0;
                imagesToDelete.forEach((imgToDel) => {
                  db.run('DELETE FROM images WHERE id = ?', [imgToDel.id], function (imgDelErr) {
                    if (!imgDelErr && imgToDel.file_path && fs.existsSync(imgToDel.file_path)) {
                      fs.unlink(imgToDel.file_path, () => {});
                    }
                    deleted++;
                    if (deleted === imagesToDelete.length) {
                      db.run('DELETE FROM projects WHERE id = ?', [projectId], function (delErr3) {
                        if (delErr3) return callback(delErr3);
                        deleteProjectFolder(projectId);
                        callback(null, this.changes);
                      });
                    }
                  });
                });
              }
            });
          });
        });
      });
    },
  };
}

module.exports = { makeProjectsRepo };

