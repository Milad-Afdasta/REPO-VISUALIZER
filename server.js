const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { createServer } = require('http');

const app = express();
app.use(express.json());

const PERSIST_FILE = path.join(__dirname, 'data', 'repos.json');

const IGNORE_DIRS = new Set([
  'node_modules', 'bower_components',
  'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.git',
  'Pods', 'Carthage',
  '.gradle',
  '__pycache__', '.tox', '.venv', 'venv', 'env', 'site-packages',
  'vendor',
  'target',
  'coverage', '.nyc_output',
  '.cache', '.parcel-cache', '.turbo', '.swc',
]);

function getExtLetter(ext) {
  const map = {
    '.ts': 'T', '.tsx': 'T',
    '.js': 'J', '.jsx': 'J', '.mjs': 'J', '.cjs': 'J',
    '.css': 'C', '.scss': 'C', '.sass': 'C', '.less': 'C',
    '.json': '{',
    '.md': 'M', '.mdx': 'M',
    '.html': 'H', '.htm': 'H',
    '.png': 'I', '.jpg': 'I', '.jpeg': 'I', '.gif': 'I',
    '.svg': 'V', '.webp': 'I', '.ico': 'I',
    '.py': 'P',
    '.go': 'G',
    '.rs': 'R',
    '.sh': '$', '.bash': '$', '.zsh': '$',
    '.yml': 'Y', '.yaml': 'Y',
    '.env': 'E',
    '.lock': 'L',
    '.toml': 'O',
    '.xml': 'X',
    '.sql': 'S',
    '.graphql': 'Q', '.gql': 'Q',
    '.txt': 'A',
    '.csv': 'D',
    '.kt': 'K', '.kts': 'K',
    '.java': 'J',
    '.swift': 'W',
    '.rb': 'B',
    '.php': 'P',
    '.vue': 'U',
    '.dart': 'D',
    '.proto': 'P',
    '.gradle': 'G',
  };
  return map[ext] || (ext && ext.length > 1 ? ext[1].toUpperCase() : 'F');
}

// ── Repo storage ─────────────────────────────────────────────────────────────
// repos: Map<rootPath, { name, files: Map<absPath, fileEntry>, addedAt }>

const repos = new Map();

function scanRepo(rootPath) {
  const name = path.basename(rootPath);
  const files = new Map();

  function scan(currentPath) {
    let entries;
    try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        scan(path.join(currentPath, entry.name));
      } else if (entry.isFile()) {
        const fullPath = path.join(currentPath, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        files.set(fullPath, {
          state: 'idle',
          extension: ext,
          letter: getExtLetter(ext),
          relativePath: path.relative(rootPath, fullPath),
          name: entry.name,
        });
      }
    }
  }

  scan(rootPath);

  const existing = repos.get(rootPath);
  repos.set(rootPath, {
    name,
    files,
    addedAt: existing ? existing.addedAt : Date.now(),
  });

  console.log(`[scan] "${name}" — ${files.size} files`);
  return repos.get(rootPath);
}

function repoToPayload(rootPath) {
  const repo = repos.get(rootPath);
  if (!repo) return null;
  return {
    root: rootPath,
    name: repo.name,
    fileCount: repo.files.size,
    files: Array.from(repo.files.entries()).map(([p, s]) => ({ path: p, ...s })),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadPersistedRepos() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    for (const { root } of saved) {
      if (fs.existsSync(root)) {
        scanRepo(root);
      } else {
        console.warn(`[skip] "${root}" no longer exists`);
      }
    }
  } catch (e) {
    console.error('[persist] load error:', e.message);
  }
}

function savePersistedRepos() {
  try {
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    const data = Array.from(repos.entries())
      .map(([root, r]) => ({ root, name: r.name, addedAt: r.addedAt }))
      .sort((a, b) => a.addedAt - b.addedAt);
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[persist] save error:', e.message);
  }
}

// ── Startup: load any CLI arg, then load persisted ───────────────────────────

const CLI_ROOT = process.argv[2] ? path.resolve(process.argv[2]) : null;
loadPersistedRepos();

if (CLI_ROOT && !repos.has(CLI_ROOT)) {
  scanRepo(CLI_ROOT);
  savePersistedRepos();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send full state for all repos
  ws.send(JSON.stringify({
    type: 'init',
    repos: Array.from(repos.keys()).map(repoToPayload).filter(Boolean),
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) try { client.send(data); } catch {}
  }
}

// Auto-reset transient states
const resetTimers = new Map();

function scheduleReset(rootPath, filePath, delayMs) {
  const key = `${rootPath}::${filePath}`;
  if (resetTimers.has(key)) clearTimeout(resetTimers.get(key));
  const timer = setTimeout(() => {
    const repo = repos.get(rootPath);
    const file = repo?.files.get(filePath);
    if (file && (file.state === 'viewing' || file.state === 'editing')) {
      file.state = 'idle';
      broadcast({ type: 'update', root: rootPath, path: filePath, state: 'idle' });
    }
    resetTimers.delete(key);
  }, delayMs);
  resetTimers.set(key, timer);
}

// ── Repo resolution helpers ───────────────────────────────────────────────────

function ensureRepo(rawRoot) {
  const rootPath = path.resolve(rawRoot);
  if (!repos.has(rootPath)) {
    console.log(`[new repo] "${rootPath}"`);
    scanRepo(rootPath);
    savePersistedRepos();
    broadcast({ type: 'repo_added', ...repoToPayload(rootPath) });
  }
  return rootPath;
}

// Auto-detect which repo a file belongs to (longest matching prefix wins)
function detectRepo(filePath) {
  let best = null;
  for (const rootPath of repos.keys()) {
    if (
      (filePath.startsWith(rootPath + '/') || filePath.startsWith(rootPath + path.sep)) &&
      (!best || rootPath.length > best.length)
    ) {
      best = rootPath;
    }
  }
  return best;
}

function resolveRootAndPath(rawRoot, rawPath) {
  const filePath = rawPath
    ? (path.isAbsolute(rawPath) ? rawPath : null)
    : null;

  if (!filePath) return { error: 'path must be absolute' };

  let rootPath;
  if (rawRoot) {
    rootPath = ensureRepo(rawRoot);
  } else {
    rootPath = detectRepo(filePath);
    if (!rootPath) return { error: `No repo found for path. Add ?root=/your/repo to register it.` };
  }

  return { rootPath, filePath };
}

// ── REST API ──────────────────────────────────────────────────────────────────

// GET /api/repos — list all known repos
app.get('/api/repos', (_req, res) => {
  res.json(Array.from(repos.keys()).map(root => {
    const r = repos.get(root);
    return { root, name: r.name, fileCount: r.files.size, addedAt: r.addedAt };
  }));
});

// GET /api/files?root=... — list files for a repo
app.get('/api/files', (req, res) => {
  if (!req.query.root) {
    return res.json(Array.from(repos.keys()).map(repoToPayload).filter(Boolean));
  }
  const rootPath = path.resolve(req.query.root);
  const payload = repoToPayload(rootPath);
  if (!payload) return res.status(404).json({ error: 'Repo not indexed' });
  res.json(payload);
});

// POST /api/repos/rescan?root=... — rescan one or all repos
app.post('/api/repos/rescan', (req, res) => {
  if (req.query.root) {
    const rootPath = path.resolve(req.query.root);
    if (!repos.has(rootPath)) return res.status(404).json({ error: 'Repo not indexed' });
    scanRepo(rootPath);
    broadcast({ type: 'repo_rescanned', ...repoToPayload(rootPath) });
    return res.json({ root: rootPath, fileCount: repos.get(rootPath).files.size });
  }
  // Rescan all
  for (const rootPath of repos.keys()) scanRepo(rootPath);
  broadcast({ type: 'init', repos: Array.from(repos.keys()).map(repoToPayload).filter(Boolean) });
  res.json({ rescanned: repos.size });
});

// Backward compat alias
app.post('/api/rescan', (req, res) => {
  for (const rootPath of repos.keys()) scanRepo(rootPath);
  broadcast({ type: 'init', repos: Array.from(repos.keys()).map(repoToPayload).filter(Boolean) });
  res.json({ rescanned: repos.size });
});

// ── File state endpoints ──────────────────────────────────────────────────────
// All accept: ?path=<absolute>&root=<absolute>  (root optional if path is under known repo)

function fileEndpoint(method, state, resetDelay) {
  return (req, res) => {
    const { rootPath, filePath, error } = resolveRootAndPath(req.query.root, req.query.path);
    if (error) return res.status(400).json({ error });

    const repo = repos.get(rootPath);
    let file = repo.files.get(filePath);

    if (!file) {
      if (method === 'POST') {
        // Creating a new file not yet indexed
        const ext = path.extname(filePath).toLowerCase();
        file = {
          state: 'new',
          extension: ext,
          letter: getExtLetter(ext),
          relativePath: path.relative(rootPath, filePath),
          name: path.basename(filePath),
        };
        repo.files.set(filePath, file);
        broadcast({ type: 'add', root: rootPath, path: filePath, ...file });
        return res.json({ root: rootPath, path: filePath, ...file });
      }
      return res.status(404).json({ error: 'Not in index', path: filePath, root: rootPath });
    }

    file.state = state;
    broadcast({ type: 'update', root: rootPath, path: filePath, state });
    if (resetDelay) scheduleReset(rootPath, filePath, resetDelay);
    res.json({ root: rootPath, path: filePath, ...file });
  };
}

app.get   ('/api/file', fileEndpoint('GET',    'viewing', 4000));
app.put   ('/api/file', fileEndpoint('PUT',    'editing', 6000));
app.delete('/api/file', fileEndpoint('DELETE', 'deleted', null));
app.post  ('/api/file', fileEndpoint('POST',   'new',     null));

// Serve built client
app.use(express.static(path.join(__dirname, 'client/dist')));
app.get('*', (_req, res) => {
  const p = path.join(__dirname, 'client/dist/index.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.send('<p>Run <code>npm run build</code> first.</p>');
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n  REPO VISUALIZER`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  URL   : http://localhost:${PORT}`);
  console.log(`  Repos : ${repos.size} loaded`);
  for (const [root, r] of repos) console.log(`          "${r.name}" (${r.files.size} files) — ${root}`);
  console.log(`\n  To add a repo hit any file endpoint with ?root=/path/to/repo`);
  console.log(`  or pass it as a CLI arg: node server.js /path/to/repo\n`);
});
