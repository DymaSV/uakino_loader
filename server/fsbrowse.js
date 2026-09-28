'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

/**
 * Windows known folders can be redirected (OneDrive) and localized — a real
 * Desktop may live at `…\OneDrive\Рабочий стол`, so guessing the folder name by
 * appending "Desktop" fails. Ask the OS. Output is forced to UTF-8 because the
 * default console codepage mangles non-Latin folder names.
 */
function knownFolders() {
  if (!IS_WIN) return {};
  try {
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "@{ Desktop=[Environment]::GetFolderPath('Desktop'); " +
      "Documents=[Environment]::GetFolderPath('MyDocuments'); " +
      "Videos=[Environment]::GetFolderPath('MyVideos') } | ConvertTo-Json -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1 << 20,
    });
    return JSON.parse(out.toString('utf8'));
  } catch {
    return {};
  }
}

let cachedFolders = null;

/** Well-known destinations, including OneDrive-redirected and localized folders. */
function shortcuts() {
  if (!cachedFolders) cachedFolders = knownFolders();
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const out = [];

  const add = (label, dir) => {
    if (!dir) return;
    try {
      if (fs.existsSync(dir) && !out.some((s) => s.path === dir)) out.push({ label, path: dir });
    } catch {
      /* unreadable */
    }
  };

  add('Desktop', cachedFolders.Desktop);
  add('Desktop', path.join(home, 'Desktop'));
  add('Downloads', path.join(home, 'Downloads'));
  add('Videos', cachedFolders.Videos || path.join(home, IS_WIN ? 'Videos' : 'Movies'));
  add('Documents', cachedFolders.Documents);
  add('Home', home);
  return out;
}

function drives() {
  if (!IS_WIN) return [{ label: '/', path: '/' }];
  const found = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) found.push({ label: root, path: root });
    } catch {
      /* not ready */
    }
  }
  return found;
}

function listDir(target) {
  const resolved = path.resolve(target);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('Not a directory');

  const dirs = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('$') || entry.name.startsWith('.')) continue;
    const full = path.join(resolved, entry.name);
    try {
      fs.accessSync(full, fs.constants.R_OK);
    } catch {
      continue; // no permission — do not offer it
    }
    dirs.push({ name: entry.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved ? parent : null,
    writable: isWritable(resolved),
    dirs,
  };
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function register(app) {
  app.get('/api/fs/roots', (_req, res) => {
    res.json({ shortcuts: shortcuts(), drives: drives(), separator: path.sep });
  });

  app.get('/api/fs/list', (req, res) => {
    const target = (req.query.path || '').trim();
    if (!target) return res.status(400).json({ error: 'A `path` is required.' });
    try {
      res.json(listDir(target));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/fs/mkdir', (req, res) => {
    const { parent, name } = req.body || {};
    if (!parent || !name) return res.status(400).json({ error: '`parent` and `name` are required.' });
    if (/[<>:"/\\|?*]/.test(name)) return res.status(400).json({ error: 'That folder name has invalid characters.' });
    try {
      const full = path.join(path.resolve(parent), name);
      fs.mkdirSync(full, { recursive: true });
      res.json(listDir(full));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { register, isWritable, listDir };
