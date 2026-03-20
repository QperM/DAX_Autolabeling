function makeAuthRepo(db) {
  return {
    createUser: (username, passwordHash) =>
      new Promise((resolve, reject) => {
        const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
        stmt.run([username, passwordHash], function (err) {
          if (err) reject(err);
          else {
            db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [this.lastID], (e, row) => {
              if (e) reject(e);
              else resolve(row);
            });
          }
        });
        stmt.finalize();
      }),

    getUserByUsername: (username) =>
      new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      }),

    updateUserPassword: (userId, passwordHash) =>
      new Promise((resolve, reject) => {
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId], function (err) {
          if (err) return reject(err);
          resolve(this.changes || 0);
        });
      }),

    getUserById: (id) =>
      new Promise((resolve, reject) => {
        db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      }),

    getAllUsers: () =>
      new Promise((resolve, reject) => {
        db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC', (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      }),

    grantProjectAccess: (sessionId, projectId) =>
      new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO project_access (session_id, project_id) VALUES (?, ?)', [sessionId, projectId], function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        });
      }),

    hasProjectAccess: (sessionId, projectId) =>
      new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as cnt FROM project_access WHERE session_id = ? AND project_id = ?', [sessionId, projectId], (err, row) => {
          if (err) reject(err);
          else resolve(row && row.cnt > 0);
        });
      }),

    getAccessibleProjects: (sessionId) =>
      new Promise((resolve, reject) => {
        db.all(
          `
          SELECT p.* FROM projects p
          INNER JOIN project_access pa ON pa.project_id = p.id
          WHERE pa.session_id = ?
          ORDER BY p.created_at DESC
          `,
          [sessionId],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          },
        );
      }),

    clearSessionAccess: (sessionId) =>
      new Promise((resolve, reject) => {
        db.run('DELETE FROM project_access WHERE session_id = ?', [sessionId], function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      }),
  };
}

module.exports = { makeAuthRepo };

