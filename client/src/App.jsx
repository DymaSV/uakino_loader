import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FolderPicker from './FolderPicker.jsx';

const DEFAULT_URL =
  'https://uakino.best/animeukr/anime-series/25998-tilky-ia-vizmu-novyi-riven-2-sezon.html';

const keyOf = (item) => `${item.voiceId}|${item.embed}`;

/** "Серіал X (2025) 2 сезон дивитися онлайн …" -> "X (2025) 2 сезон" */
function deriveBaseName(title) {
  if (!title) return '';
  return title
    .replace(/^(Серіал|Фільм|Аніме|Мультсеріал|Мультфільм)\s+/i, '')
    // Series titles trail "… дивитися онлайн …", film titles just "… онлайн …".
    .split(/\s+(?:дивитися|онлайн)\s+/i)[0]
    .trim();
}

function sanitize(name) {
  return (
    (name || 'video')
      // Mirrors sanitizeName() in server/ffmpeg.js: strip only what Windows
      // forbids, so spaces and hyphens survive and the preview matches disk.
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 120) || 'video'
  );
}

const formatBytes = (n) =>
  !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

/** Mirrors parseTimeSpec() in server/ffmpeg.js: 130, "2:10" and "1:02:10" all work. */
function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    seconds = seconds * 60 + Number.parseFloat(part);
  }
  return Number.isFinite(seconds) ? seconds : null;
}

const formatClock = (total) => {
  const whole = Math.round(total);
  const minutes = Math.floor(whole / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

export default function App() {
  // --- scraping -----------------------------------------------------------
  const [url, setUrl] = useState(DEFAULT_URL);
  const [mode, setMode] = useState('click');
  const [limit, setLimit] = useState('');
  const [voice, setVoice] = useState('');
  const [scraping, setScraping] = useState(false);
  const [meta, setMeta] = useState(null);
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [error, setError] = useState(null);
  const scrapeSource = useRef(null);

  // --- load list ----------------------------------------------------------
  const [selected, setSelected] = useState(() => new Set());
  const [queue, setQueue] = useState([]);
  const [dir, setDir] = useState('');
  const [baseName, setBaseName] = useState('');
  const [quality, setQuality] = useState('best');
  const [overwrite, setOverwrite] = useState(false);
  const [combine, setCombine] = useState(false);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimFrom, setTrimFrom] = useState('0');
  const [trimTo, setTrimTo] = useState('');
  const [combined, setCombined] = useState({ filename: '', exists: false });
  const [combineState, setCombineState] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [existing, setExisting] = useState({});

  // --- downloading --------------------------------------------------------
  const [jobId, setJobId] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [summary, setSummary] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const jobSource = useRef(null);

  const stopScrape = useCallback(() => {
    scrapeSource.current?.close();
    scrapeSource.current = null;
    setScraping(false);
    setProgress(null);
  }, []);

  useEffect(
    () => () => {
      scrapeSource.current?.close();
      jobSource.current?.close();
    },
    []
  );

  const startScrape = (event) => {
    event.preventDefault();
    stopScrape();
    setMeta(null);
    setResults([]);
    setSelected(new Set());
    setError(null);
    setLogLines([]);
    setScraping(true);

    const params = new URLSearchParams({ url, mode });
    if (limit) params.set('limit', limit);
    if (voice) params.set('voice', voice);

    const source = new EventSource(`/api/scrape?${params}`);
    scrapeSource.current = source;

    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.type === 'log') setLogLines((prev) => [...prev, event.message]);
      else if (event.type === 'meta') {
        setMeta(event);
        setBaseName((prev) => prev || deriveBaseName(event.title));
      } else if (event.type === 'progress') setProgress(event);
      else if (event.type === 'item')
        // Fast mode resolves items in parallel, so they arrive out of order.
        // Keep playlist order — it decides the queue, the _N suffixes and the
        // order parts are joined in.
        setResults((prev) => [...prev, event].sort((a, b) => a.index - b.index));
      else if (event.type === 'fatal') {
        setError(event.message);
        stopScrape();
      } else if (event.type === 'done') stopScrape();
    };
    source.onerror = () => {
      setError((prev) => prev || 'Lost the connection to the scraper API. Is the server running?');
      stopScrape();
    };
  };

  // --- queue helpers ------------------------------------------------------
  const usable = useMemo(() => results.filter((r) => r.src), [results]);
  const queueKeys = useMemo(() => new Set(queue.map((q) => q.key)), [queue]);

  const addToQueue = (rows) => {
    setQueue((prev) => {
      const have = new Set(prev.map((p) => p.key));
      const additions = rows
        .filter((r) => r.src && !have.has(keyOf(r)))
        .map((r) => ({
          key: keyOf(r),
          label: r.label,
          voice: r.voice,
          src: r.streamUrl || r.src,
        }));
      return [...prev, ...additions];
    });
  };

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const removeFromQueue = (key) => setQueue((prev) => prev.filter((q) => q.key !== key));
  const move = (index, delta) =>
    setQueue((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  // Ask the server which target filenames already exist, so "Load" never
  // silently clobbers anything.
  useEffect(() => {
    if (!dir || !queue.length || !baseName) {
      setExisting({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/download/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: queue, baseName, dir }),
        });
        const data = await res.json();
        if (cancelled) return;
        const map = {};
        for (const row of data.rows || []) map[row.position] = row.exists;
        setExisting(map);
        setCombined({ filename: data.combinedFilename || '', exists: !!data.combinedExists });
      } catch {
        /* preview is advisory only */
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dir, baseName, queue]);

  const collisions = Object.values(existing).filter(Boolean).length;

  // An empty "From" reads as 0 — the intro case, which is what the box is for.
  const trimFromSec = parseTime(trimFrom.trim() || '0');
  const trimToSec = parseTime(trimTo);
  const trimValid =
    !trimEnabled || (trimFromSec !== null && trimToSec !== null && trimToSec > trimFromSec);

  // --- download -----------------------------------------------------------
  const startDownload = async () => {
    setDownloadError(null);
    setSummary(null);
    setStatuses({});
    setCombineState(null);
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: queue.map((q) => ({ label: q.label, voice: q.voice, src: q.src })),
          dir,
          baseName,
          quality,
          overwrite,
          combine,
          trim: trimEnabled ? { from: trimFrom.trim() || '0', to: trimTo.trim() } : null,
          referer: url,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the download.');

      setJobId(data.jobId);
      setDownloading(true);

      const source = new EventSource(`/api/download/${data.jobId}/events`);
      jobSource.current = source;

      source.onmessage = (message) => {
        const event = JSON.parse(message.data);
        if (event.type === 'job-start') {
          const initial = {};
          for (const item of event.items)
            initial[item.position] = { filename: item.filename, status: 'pending', percent: 0 };
          setStatuses(initial);
        } else if (event.type === 'item-start') {
          setStatuses((prev) => ({
            ...prev,
            [event.position]: { ...prev[event.position], status: 'downloading', percent: 0 },
          }));
        } else if (event.type === 'item-progress') {
          setStatuses((prev) => ({
            ...prev,
            [event.position]: {
              ...prev[event.position],
              status: 'downloading',
              percent: event.percent ?? prev[event.position]?.percent ?? 0,
              bytes: event.bytes,
            },
          }));
        } else if (event.type === 'item-trim') {
          setStatuses((prev) => ({
            ...prev,
            [event.position]: { ...prev[event.position], status: 'trimming', percent: 100 },
          }));
        } else if (event.type === 'item-done') {
          setStatuses((prev) => ({
            ...prev,
            [event.position]: {
              ...prev[event.position],
              status: event.status,
              error: event.error || null,
              bytes: event.bytes ?? prev[event.position]?.bytes,
              percent: event.status === 'done' ? 100 : prev[event.position]?.percent ?? 0,
            },
          }));
        } else if (event.type === 'combine-start') {
          setCombineState({
            status: 'combining',
            percent: 0,
            filename: event.filename,
            count: event.count,
          });
        } else if (event.type === 'combine-progress') {
          setCombineState((prev) => ({
            ...prev,
            percent: event.percent ?? prev?.percent ?? 0,
          }));
        } else if (event.type === 'combine-done') {
          setCombineState((prev) => ({
            ...prev,
            status: event.status,
            error: event.error || null,
            bytes: event.bytes,
            filename: event.filename || prev?.filename,
            percent: event.status === 'done' ? 100 : prev?.percent ?? 0,
          }));
        } else if (event.type === 'job-done') {
          setSummary(event.summary);
          setDownloading(false);
          source.close();
          jobSource.current = null;
        }
      };
      source.onerror = () => {
        setDownloadError('Lost the connection to the download stream.');
        setDownloading(false);
        source.close();
      };
    } catch (e) {
      setDownloadError(e.message);
    }
  };

  const cancelDownload = async () => {
    if (!jobId) return;
    await fetch(`/api/download/${jobId}/cancel`, { method: 'POST' });
  };

  const pct = progress ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <div className="wrap">
      <header>
        <h1>uakino playlist → video src → mp4</h1>
        <p>
          Extract the <code>src</code> of every playlist item, pick the ones you want, choose a
          folder, and download them to MP4 one after another.
        </p>
      </header>

      <form className="panel" onSubmit={startScrape}>
        <div className="row">
          <label className="field grow">
            Page URL
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </label>
          <label className="field">
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="click">Click each item</option>
              <option value="fast">Fast (open embeds)</option>
            </select>
          </label>
          <label className="field">
            Limit
            <input
              type="number"
              min="0"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              style={{ width: 78 }}
            />
          </label>
          {meta?.voices?.length > 0 && (
            <label className="field">
              Dub
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                <option value="">All</option>
                {meta.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            &nbsp;
            <div className="row">
              <button type="submit" disabled={scraping}>
                {scraping ? 'Working…' : 'Extract'}
              </button>
              {scraping && (
                <button type="button" className="ghost" onClick={stopScrape}>
                  Stop
                </button>
              )}
            </div>
          </label>
        </div>

        {scraping && (
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={`status${error ? ' err' : ''}`}>
          {error ||
            (progress
              ? `${progress.index}/${progress.total} — ${progress.label}`
              : meta
                ? meta.source === 'single'
                  ? `No playlist here — ${meta.totalEpisodes} embedded player${
                      meta.totalEpisodes === 1 ? '' : 's'
                    } read directly.`
                  : `${meta.totalEpisodes} items in the playlist, ${meta.selected} selected.`
                : scraping
                  ? 'Loading the page…'
                  : '')}
        </div>
      </form>

      <div className="cols">
        {/* ---------------- results ---------------- */}
        <section className="col">
          <div className="col-head">
            <h2>Results {usable.length > 0 && <span className="count">{usable.length}</span>}</h2>
            {usable.length > 0 && (
              <div className="row">
                <button type="button" className="ghost small" onClick={() => addToQueue(usable)}>
                  Add all →
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={!selected.size}
                  onClick={() => addToQueue(usable.filter((r) => selected.has(keyOf(r))))}
                >
                  Add selected ({selected.size}) →
                </button>
              </div>
            )}
          </div>

          {results.length === 0 ? (
            <div className="empty">Nothing extracted yet.</div>
          ) : (
            <ul className="results">
              {results.map((item) => {
                const key = keyOf(item);
                const queued = queueKeys.has(key);
                return (
                  <li key={`${key}-${item.index}`} className={item.src ? '' : 'bad'}>
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      disabled={!item.src}
                      onChange={() => toggle(key)}
                    />
                    <span className="idx">{item.index}</span>
                    <div className="body">
                      <div className="label">
                        {item.label}
                        {item.voice && <span className="voice">{item.voice}</span>}
                        {queued && <span className="tag">in list</span>}
                      </div>
                      <div className={item.src ? 'src' : 'src none'}>
                        {item.src || item.error || 'not found'}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ---------------- load list ---------------- */}
        <section className="col">
          <div className="col-head">
            <h2>List to load {queue.length > 0 && <span className="count">{queue.length}</span>}</h2>
            {queue.length > 0 && !downloading && (
              <button type="button" className="ghost small" onClick={() => setQueue([])}>
                Clear
              </button>
            )}
          </div>

          <div className="panel dest">
            <div className="row">
              <button type="button" className="ghost" onClick={() => setPickerOpen(true)}>
                Load to…
              </button>
              <input
                type="text"
                className="dest-path"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="no folder chosen — pick one, or paste a path"
              />
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <label className="field grow">
                File name
                <input
                  type="text"
                  value={baseName}
                  onChange={(e) => setBaseName(e.target.value)}
                  placeholder="base name"
                />
              </label>
              <label className="field">
                Quality
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                  <option value="best">Best</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>
            </div>

            {baseName && (
              <div className="hint">
                Files will be named <code>{sanitize(baseName)}_1.mp4</code>,{' '}
                <code>{sanitize(baseName)}_2.mp4</code>, …
              </div>
            )}

            <label className="check">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite files that already exist
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={trimEnabled}
                disabled={downloading}
                onChange={(e) => setTrimEnabled(e.target.checked)}
              />
              Remove intro — cut a range out of every file
            </label>

            {trimEnabled && (
              <>
                <div className="row trim-row">
                  <label className="field">
                    Cut from
                    <input
                      type="text"
                      value={trimFrom}
                      disabled={downloading}
                      onChange={(e) => setTrimFrom(e.target.value)}
                      placeholder="0"
                      style={{ width: 92 }}
                    />
                  </label>
                  <label className="field">
                    to
                    <input
                      type="text"
                      value={trimTo}
                      disabled={downloading}
                      onChange={(e) => setTrimTo(e.target.value)}
                      placeholder="130"
                      style={{ width: 92 }}
                    />
                  </label>
                  <span className="units">seconds — or mm:ss, e.g. 2:10</span>
                </div>

                {trimValid ? (
                  <div className="hint">
                    Every file loses {formatClock(trimToSec - trimFromSec)} (
                    {trimToSec - trimFromSec}s)
                    {trimFromSec > 0
                      ? ` from ${formatClock(trimFromSec)} to ${formatClock(trimToSec)}; what is left on either side is rejoined.`
                      : ' from its start — those seconds are never downloaded at all.'}
                    {combine && ' Each part is cut before they are joined.'}{' '}
                    The cut lands on the nearest keyframe, so it can be off by a second or two.
                  </div>
                ) : (
                  <div className="warn-line">
                    {trimToSec === null
                      ? 'Enter the second the cut ends at — 130 or 2:10.'
                      : trimFromSec === null
                        ? 'The start is not a time — use 0, 30 or 0:30.'
                        : 'The end has to be later than the start.'}
                  </div>
                )}
              </>
            )}

            <label className="check">
              <input
                type="checkbox"
                checked={combine}
                disabled={downloading}
                onChange={(e) => setCombine(e.target.checked)}
              />
              Combine everything into one file afterwards
            </label>
            {combine && combined.filename && (
              <div className="hint">
                Joined into <code>{combined.filename}</code> once all parts finish; the numbered
                parts are kept.
                {combined.exists && !overwrite && ' That file already exists and will be skipped.'}
              </div>
            )}
            {collisions > 0 && !overwrite && (
              <div className="warn-line">
                {collisions} target file{collisions === 1 ? '' : 's'} already exist in that folder and
                will be skipped.
              </div>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={!queue.length || !dir || !baseName || downloading || !trimValid}
                onClick={startDownload}
              >
                {downloading ? 'Loading…' : `Load ${queue.length || ''}`}
              </button>
              {downloading && (
                <button type="button" className="ghost" onClick={cancelDownload}>
                  Cancel
                </button>
              )}
            </div>

            {combineState && (
              <div className={`combine-box${combineState.status === 'error' ? ' bad' : ''}`}>
                <div className="label">
                  Combined file
                  {combineState.count && <span className="voice">{combineState.count} parts</span>}
                </div>
                {combineState.filename && <div className="filename">{combineState.filename}</div>}
                <div className="bar thin">
                  <i
                    className={combineState.status}
                    style={{ width: `${Math.round(combineState.percent || 0)}%` }}
                  />
                </div>
                <div className="sub">
                  {combineState.status}
                  {combineState.percent ? ` · ${Math.round(combineState.percent)}%` : ''}
                  {combineState.bytes ? ` · ${formatBytes(combineState.bytes)}` : ''}
                  {combineState.error ? ` · ${combineState.error}` : ''}
                </div>
              </div>
            )}

            {downloadError && <div className="modal-error">{downloadError}</div>}
            {summary && (
              <div className="hint">
                Finished — {Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(', ')}.
              </div>
            )}
          </div>

          {queue.length === 0 ? (
            <div className="empty">Add items from the results.</div>
          ) : (
            <ul className="results queue">
              {queue.map((item, index) => {
                const position = index + 1;
                const state = statuses[position];
                const status = state?.status || 'pending';
                return (
                  <li key={item.key} className={status === 'error' ? 'bad' : ''}>
                    <span className="idx">{position}</span>
                    <div className="body">
                      <div className="label">
                        {item.label}
                        {item.voice && <span className="voice">{item.voice}</span>}
                      </div>
                      <div className="filename">
                        {sanitize(baseName || 'video')}_{position}.mp4
                        {existing[position] && !overwrite && <span className="tag warn">exists</span>}
                      </div>
                      {status !== 'pending' && (
                        <>
                          <div className="bar thin">
                            <i
                              className={status}
                              style={{ width: `${Math.round(state?.percent || 0)}%` }}
                            />
                          </div>
                          <div className="sub">
                            {status}
                            {state?.percent ? ` · ${Math.round(state.percent)}%` : ''}
                            {state?.bytes ? ` · ${formatBytes(state.bytes)}` : ''}
                            {state?.error ? ` · ${state.error}` : ''}
                          </div>
                        </>
                      )}
                    </div>
                    {!downloading && (
                      <div className="qbtns">
                        <button type="button" className="copy" onClick={() => move(index, -1)}>
                          ↑
                        </button>
                        <button type="button" className="copy" onClick={() => move(index, 1)}>
                          ↓
                        </button>
                        <button type="button" className="copy" onClick={() => removeFromQueue(item.key)}>
                          ✕
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {logLines.length > 0 && (
        <div className="log">
          {logLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {pickerOpen && (
        <FolderPicker
          initialPath={dir}
          onClose={() => setPickerOpen(false)}
          onPick={(path) => {
            setDir(path);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
