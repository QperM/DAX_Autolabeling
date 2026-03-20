const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

function ensureDbDir() {
  const dbDir = path.join(__dirname, '../../database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return dbDir;
}

function getDefaultDbPath() {
  const dbDir = ensureDbDir();
  return path.join(dbDir, 'annotations.db');
}

function createConnection(dbPath = getDefaultDbPath()) {
  return new sqlite3.Database(dbPath);
}

module.exports = {
  createConnection,
  getDefaultDbPath,
};

