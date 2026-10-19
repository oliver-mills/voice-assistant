// Small JSON files on disk, so the conversation and what the assistant has
// been asked to remember survive a restart. Nothing here is big or busy enough
// to need a database.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (err) {
    // A missing file is just a first run; anything else is worth knowing about
    if (err.code !== 'ENOENT') console.warn(`Could not read ${name}.json, starting fresh:`, err.message);
    return fallback;
  }
}

// Write to a temporary file and rename it into place, so a crash mid-write
// can't leave half a file behind
function save(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath(name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, target);
}

module.exports = { load, save, DATA_DIR };
