import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const WS_URL = import.meta.env.DEV
  ? 'ws://localhost:3001'
  : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

const STATE_META = {
  idle:    { label: 'IDLE',    cssClass: 'idle'    },
  viewing: { label: 'VIEWING', cssClass: 'viewing' },
  editing: { label: 'EDITING', cssClass: 'editing' },
  deleted: { label: 'DELETED', cssClass: 'deleted' },
  new:     { label: 'NEW',     cssClass: 'new'     },
};

const HEAT_SCALE = 100; // touches to reach max brightness (keeps growing beyond this)

// Interpolate between two hex colors, returns rgb() string
function lerpColor(hex1, hex2, t) {
  const parse = h => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex1);
  const [r2, g2, b2] = parse(hex2);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
}

// Returns inline style override for idle blocks based on touch count
// Uses a sqrt curve so early touches are visible; fully bright at HEAT_SCALE touches
function heatStyle(count) {
  if (!count) return null;
  const t = Math.min(Math.sqrt(count / HEAT_SCALE), 1);
  return {
    backgroundColor: lerpColor('#111125', '#2d0d5e', t),
    color:           lerpColor('#5a5a8a', '#dd88ff', t),
    borderColor:     lerpColor('#1a1a38', '#7733cc', t),
  };
}

function FileBlock({ file, onSelect }) {
  const meta    = STATE_META[file.state] || STATE_META.idle;
  const glowing = file.state === 'viewing' || file.state === 'editing';
  const heat    = file.state === 'idle' ? heatStyle(file.heat) : null;

  return (
    <div
      className={`block ${meta.cssClass}${glowing ? ' glowing' : ''}`}
      style={heat}
      title={`${file.relativePath}${file.heat ? ` · touched ${file.heat}×` : ''}`}
      onClick={() => onSelect(file)}
    >
      {file.letter}
    </div>
  );
}

export default function App() {
  const reposRef    = useRef(new Map()); // root -> Map<path, fileEntry>
  const repoMetaRef = useRef(new Map()); // root -> { name, root }
  const heatRef     = useRef(new Map()); // path -> touch count (session only)

  const [repoList,   setRepoList]   = useState([]);
  const [activeRoot, setActiveRoot] = useState(null);
  const [files,      setFiles]      = useState([]);
  const [connected,  setConnected]  = useState(false);
  const [selected,   setSelected]   = useState(null);
  const wsRef = useRef(null);

  // Attach current heat counts to file entries before displaying
  const withHeat = useCallback((fileMap) => {
    return [...fileMap.values()].map(f => ({
      ...f,
      heat: heatRef.current.get(f.path) || 0,
    }));
  }, []);

  const refreshFiles = useCallback((root) => {
    const map = reposRef.current.get(root);
    setFiles(map ? withHeat(map) : []);
  }, [withHeat]);

  const applyInit = useCallback((reposPayload) => {
    const newMeta = new Map();
    for (const r of reposPayload) {
      const fileMap = new Map();
      for (const f of r.files) fileMap.set(f.path, f);
      reposRef.current.set(r.root, fileMap);
      newMeta.set(r.root, { root: r.root, name: r.name });
    }
    repoMetaRef.current = newMeta;
    const list = [...newMeta.values()];
    setRepoList(list);
    setActiveRoot(prev => {
      const chosen = (prev && reposRef.current.has(prev)) ? prev : (list[0]?.root ?? null);
      if (chosen) refreshFiles(chosen);
      return chosen;
    });
  }, [refreshFiles]);

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'init') {
        applyInit(msg.repos || []);

      } else if (msg.type === 'repo_added' || msg.type === 'repo_rescanned') {
        const fileMap = new Map();
        for (const f of msg.files) fileMap.set(f.path, f);
        reposRef.current.set(msg.root, fileMap);
        repoMetaRef.current.set(msg.root, { root: msg.root, name: msg.name });
        setRepoList([...repoMetaRef.current.values()]);
        setActiveRoot(prev => {
          const chosen = prev ?? msg.root;
          if (chosen === msg.root) refreshFiles(msg.root);
          return chosen;
        });

      } else if (msg.type === 'update') {
        const fileMap = reposRef.current.get(msg.root);
        if (!fileMap) return;
        const file = fileMap.get(msg.path);
        if (!file) return;

        // Increment heat on every touch (any state change counts)
        const newHeat = (heatRef.current.get(msg.path) || 0) + 1;
        heatRef.current.set(msg.path, newHeat);

        const updated = { ...file, state: msg.state };
        fileMap.set(msg.path, updated);

        setActiveRoot(prev => {
          if (prev === msg.root) setFiles(withHeat(fileMap));
          return prev;
        });
        setSelected(prev =>
          prev?.path === msg.path ? { ...updated, heat: newHeat } : prev
        );

      } else if (msg.type === 'add') {
        const fileMap = reposRef.current.get(msg.root);
        if (!fileMap) return;
        const entry = {
          path: msg.path, state: msg.state, extension: msg.extension,
          letter: msg.letter, relativePath: msg.relativePath, name: msg.name,
        };
        heatRef.current.set(msg.path, (heatRef.current.get(msg.path) || 0) + 1);
        fileMap.set(msg.path, entry);
        setActiveRoot(prev => {
          if (prev === msg.root) setFiles(withHeat(fileMap));
          return prev;
        });
      }
    };

    ws.onclose = () => { setConnected(false); setTimeout(connect, 2000); };
    ws.onerror = () => ws.close();
  }, [applyInit, refreshFiles, withHeat]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  const switchRepo = (root) => {
    setActiveRoot(root);
    setSelected(null);
    refreshFiles(root);
  };

  const rescan = () => {
    const params = activeRoot ? `?root=${encodeURIComponent(activeRoot)}` : '';
    fetch(`/api/repos/rescan${params}`, { method: 'POST' }).catch(console.error);
  };

  const counts = { idle: 0, viewing: 0, editing: 0, deleted: 0, new: 0 };
  for (const f of files) {
    if (counts[f.state] !== undefined) counts[f.state]++;
    else counts.idle++;
  }

  const activeName = activeRoot
    ? (repoMetaRef.current.get(activeRoot)?.name ?? activeRoot)
    : '—';

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="app-title">REPO VISUALIZER</span>
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          <span className="conn-label">{connected ? 'LIVE' : 'RECONNECTING'}</span>
        </div>

        <div className="header-center">
          {repoList.length > 0 ? (
            <select
              className="repo-select"
              value={activeRoot ?? ''}
              onChange={e => switchRepo(e.target.value)}
            >
              {repoList.map(r => (
                <option key={r.root} value={r.root}>{r.name}</option>
              ))}
            </select>
          ) : (
            <span className="repo-path">No repos yet — hit the API with ?root=/your/repo</span>
          )}
        </div>

        <div className="header-right">
          <span className="badge idle">{counts.idle} idle</span>
          <span className="badge viewing">{counts.viewing} view</span>
          <span className="badge editing">{counts.editing} edit</span>
          <span className="badge deleted">{counts.deleted} del</span>
          <span className="badge new">{counts.new} new</span>
          <button className="btn-rescan" onClick={rescan}>RESCAN</button>
        </div>
      </header>

      <div className="grid-wrap">
        <div className="grid">
          {files.map(f => (
            <FileBlock key={f.path} file={f} onSelect={setSelected} />
          ))}
        </div>
      </div>

      {selected && (
        <div className="info-bar" onClick={() => setSelected(null)}>
          <span className={`chip ${selected.state}`}>
            {STATE_META[selected.state]?.label ?? selected.state}
          </span>
          <span className="info-path">{selected.relativePath}</span>
          {selected.heat > 0 && (
            <span className="info-heat">touched {selected.heat}×</span>
          )}
          <span className="info-dismiss">click to dismiss</span>
        </div>
      )}

      <footer className="legend">
        <span className="leg idle">■ IDLE</span>
        <span className="leg heat">■ TOUCHED</span>
        <span className="leg viewing">■ VIEWING</span>
        <span className="leg editing">■ EDITING</span>
        <span className="leg deleted">■ DELETED</span>
        <span className="leg new">■ NEW</span>
        <span className="leg-sep" />
        <span className="leg-ext">
          T=TS &nbsp; J=JS &nbsp; C=CSS &nbsp;{'{'  }=JSON &nbsp; M=MD &nbsp; H=HTML &nbsp;
          V=SVG &nbsp; I=IMG &nbsp; Y=YAML &nbsp; S=SQL &nbsp; $=SH &nbsp; K=Kotlin &nbsp; R=Rust
        </span>
        <span className="leg-total">{files.length} files · {activeName}</span>
      </footer>
    </div>
  );
}
