import { useCallback, useEffect, useState } from 'react';

/** Browses folders through the local API — the downloads happen server-side, so
 *  the destination has to be a real path on this machine, not a browser handle. */
export default function FolderPicker({ initialPath, onPick, onClose }) {
  const [roots, setRoots] = useState({ shortcuts: [], drives: [] });
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState('');

  const open = useCallback(async (path) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open that folder.');
      setListing(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/fs/roots');
      const data = await res.json();
      setRoots(data);
      const start = initialPath || data.shortcuts[0]?.path;
      if (start) open(start);
    })();
  }, [initialPath, open]);

  const createFolder = async () => {
    if (!newFolder.trim() || !listing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: listing.path, name: newFolder.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the folder.');
      setListing(data);
      setNewFolder('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Choose a destination folder</h3>
          <button type="button" className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="shortcuts">
          {roots.shortcuts.map((s) => (
            <button key={s.path} type="button" className="chip" onClick={() => open(s.path)}>
              {s.label}
            </button>
          ))}
          {roots.drives.map((d) => (
            <button key={d.path} type="button" className="chip drive" onClick={() => open(d.path)}>
              {d.label}
            </button>
          ))}
        </div>

        <div className="path-bar">
          <button
            type="button"
            className="ghost small"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && open(listing.parent)}
          >
            ↑ Up
          </button>
          <code className="cur-path">{listing?.path || '…'}</code>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="dir-list">
          {busy && <div className="dim">Loading…</div>}
          {!busy && listing?.dirs.length === 0 && <div className="dim">No sub-folders here.</div>}
          {!busy &&
            listing?.dirs.map((d) => (
              <button key={d.path} type="button" className="dir-row" onDoubleClick={() => open(d.path)} onClick={() => open(d.path)}>
                <span className="folder-ico">📁</span>
                {d.name}
              </button>
            ))}
        </div>

        <div className="modal-foot">
          <div className="row">
            <input
              type="text"
              value={newFolder}
              placeholder="New folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
            />
            <button type="button" className="ghost" onClick={createFolder} disabled={!newFolder.trim() || busy}>
              Create
            </button>
          </div>
          <button
            type="button"
            disabled={!listing || !listing.writable}
            onClick={() => onPick(listing.path)}
            title={listing && !listing.writable ? 'This folder is not writable' : undefined}
          >
            {listing && !listing.writable ? 'Not writable' : 'Use this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
