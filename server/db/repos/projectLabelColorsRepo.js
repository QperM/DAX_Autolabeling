const { debugLog } = require('../../utils/debugSettingsStore');

function makeProjectLabelColorsRepo(db) {
  const normalizeLabelKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizeColor = (v) => String(v || '').trim();

  return {
    listProjectLabelColors: (projectId, callback) => {
      const sql = `
        SELECT project_id, label, label_zh, label_key, color, usage_order, created_at, updated_at
        FROM project_label_colors
        WHERE project_id = ?
        ORDER BY usage_order ASC, updated_at DESC, label ASC
      `;
      db.all(sql, [Number(projectId)], (err, rows) => {
        if (err) return callback(err, []);
        const out = (rows || []).map((r) => ({
          projectId: Number(r.project_id),
          label: String(r.label || ''),
          labelZh: String(r.label_zh || ''),
          labelKey: String(r.label_key || ''),
          color: String(r.color || ''),
          usageOrder: Number(r.usage_order || 0),
          createdAt: r.created_at || null,
          updatedAt: r.updated_at || null,
        }));
        debugLog('node', 'nodeProjectLabelColors', '[listProjectLabelColors] loaded', {
          projectId: Number(projectId),
          count: out.length,
          labels: out.map((x) => ({ label: x.label, color: x.color, colorOrder: x.usageOrder })),
        });
        return callback(null, out);
      });
    },

    replaceProjectLabelColors: (projectId, mappings, callback) => {
      const pid = Number(projectId);
      const rows = (Array.isArray(mappings) ? mappings : [])
        .map((it, index) => {
          const label = String(it?.label || '').trim();
          const labelZh = String(it?.labelZh || '').trim();
          const color = normalizeColor(it?.color);
          if (!label || !color) return null;
          const labelKey = normalizeLabelKey(label);
          const usageOrder = Number.isFinite(Number(it?.usageOrder)) ? Number(it.usageOrder) : index;
          return { label, labelZh, labelKey, color, usageOrder };
        })
        .filter(Boolean);
      debugLog('node', 'nodeProjectLabelColors', '[replaceProjectLabelColors] replace request', {
        projectId: pid,
        incomingCount: rows.length,
        labels: rows.map((r) => ({ label: r.label, color: r.color, colorOrder: r.usageOrder })),
      });

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM project_label_colors WHERE project_id = ?', [pid], (delErr) => {
          if (delErr) {
            db.run('ROLLBACK');
            return callback(delErr, 0);
          }
          if (rows.length === 0) {
            return db.run('COMMIT', (commitErr) => callback(commitErr || null, 0));
          }

          const stmt = db.prepare(`
            INSERT INTO project_label_colors (project_id, label, label_zh, label_key, color, usage_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `);
          let done = 0;
          let failed = false;
          rows.forEach((r) => {
            stmt.run([pid, r.label, r.labelZh, r.labelKey, r.color, r.usageOrder], (insErr) => {
              if (failed) return;
              if (insErr) {
                failed = true;
                stmt.finalize(() => {
                  db.run('ROLLBACK');
                  callback(insErr, 0);
                });
                return;
              }
              done += 1;
              if (done === rows.length) {
                stmt.finalize(() => {
                  db.run('COMMIT', (commitErr) => callback(commitErr || null, done));
                });
              }
            });
          });
        });
      });
    },

    upsertProjectLabelColorsFromAnnotation: (projectId, annotationData, callback) => {
      const pid = Number(projectId);
      const masks = Array.isArray(annotationData?.masks) ? annotationData.masks : [];
      const bboxes = Array.isArray(annotationData?.boundingBoxes) ? annotationData.boundingBoxes : [];
      const collected = [];
      [...masks, ...bboxes].forEach((it) => {
        const label = String(it?.label || '').trim();
        const color = normalizeColor(it?.color);
        if (!label || !color) return;
        const labelKey = normalizeLabelKey(label);
        collected.push({ label, labelZh: '', labelKey, color });
      });
      if (!collected.length) return callback(null, 0);

      const uniqByKey = new Map();
      collected.forEach((it) => {
        if (!uniqByKey.has(it.labelKey)) uniqByKey.set(it.labelKey, it);
      });
      const rows = Array.from(uniqByKey.values());
      debugLog('node', 'nodeProjectLabelColors', '[upsertProjectLabelColorsFromAnnotation] upsert request', {
        projectId: pid,
        incomingCount: rows.length,
        labels: rows.map((r) => ({ label: r.label, color: r.color })),
      });

      const stmt = db.prepare(`
        INSERT INTO project_label_colors (project_id, label, label_zh, label_key, color, usage_order, updated_at)
        VALUES (
          ?, ?, ?, ?, ?,
          COALESCE(
            (SELECT usage_order FROM project_label_colors WHERE project_id = ? AND label_key = ?),
            (SELECT COALESCE(MAX(usage_order), -1) + 1 FROM project_label_colors WHERE project_id = ?)
          ),
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(project_id, label_key) DO UPDATE SET
          label = excluded.label,
          color = excluded.color,
          updated_at = CURRENT_TIMESTAMP
      `);
      let done = 0;
      let failed = false;
      rows.forEach((r) => {
        stmt.run([pid, r.label, r.labelZh, r.labelKey, r.color, pid, r.labelKey, pid], (err) => {
          if (failed) return;
          if (err) {
            failed = true;
            stmt.finalize(() => callback(err, done));
            return;
          }
          done += 1;
          if (done === rows.length) {
            stmt.finalize(() => {
              db.all(
                `
                  SELECT label, color, usage_order
                  FROM project_label_colors
                  WHERE project_id = ?
                  ORDER BY usage_order ASC, updated_at DESC, label ASC
                `,
                [pid],
                (qErr, curRows) => {
                  debugLog('node', 'nodeProjectLabelColors', '[upsertProjectLabelColorsFromAnnotation] completed', {
                    projectId: pid,
                    upserted: done,
                    error: qErr ? String(qErr.message || qErr) : null,
                    current: (curRows || []).map((x) => ({
                      label: String(x.label || ''),
                      color: String(x.color || ''),
                      colorOrder: Number(x.usage_order || 0),
                    })),
                  });
                  callback(null, done);
                },
              );
            });
          }
        });
      });
    },
  };
}

module.exports = { makeProjectLabelColorsRepo };

