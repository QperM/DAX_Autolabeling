const fs = require('fs');
const readline = require('readline');

async function computeObjBoundingBox(objFilePath) {
  const stream = fs.createReadStream(objFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let found = 0;

  try {
    for await (const lineRaw of rl) {
      const line = String(lineRaw || '').trim();
      if (!line || line[0] === '#') continue;
      if (line.startsWith('v ')) {
        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
        found += 1;
      }
    }
  } finally {
    try {
      rl.close();
    } catch (_) {}
    try {
      stream.destroy();
    } catch (_) {}
  }

  if (found <= 0) return null;
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  if (![sizeX, sizeY, sizeZ].every((v) => Number.isFinite(v))) return null;
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    size: { x: sizeX, y: sizeY, z: sizeZ },
    vertexCount: found,
  };
}

module.exports = { computeObjBoundingBox };

