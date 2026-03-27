const path = require('path');

function getDataRootDir() {
  const configured = process.env.DATA_ROOT || process.env.DAX_DATA_DIR;
  if (configured && String(configured).trim()) return path.resolve(String(configured).trim());
  return path.join(__dirname, '..', '..', 'dax-autolabel-data');
}

function getDatabaseDir() {
  return path.join(getDataRootDir(), 'database');
}

function getUploadsRootDir() {
  return path.join(getDataRootDir(), 'uploads');
}

module.exports = {
  getDataRootDir,
  getDatabaseDir,
  getUploadsRootDir,
};
