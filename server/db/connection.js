const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { getDatabaseDir } = require('../utils/dataPaths');

function ensureDbDir() {
  const dbDir = getDatabaseDir();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return dbDir;
}

function getDefaultDbPath() {
  const dbDir = ensureDbDir();
  return path.join(dbDir, 'dax-autolabel.db');
}

function createConnection(dbPath = getDefaultDbPath()) {
  return new sqlite3.Database(dbPath);
}

module.exports = {
  createConnection,
  getDefaultDbPath,
};

