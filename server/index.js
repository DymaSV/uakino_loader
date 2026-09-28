'use strict';

const express = require('express');
const cors = require('cors');
const { scrape } = require('./scraper');
const fsbrowse = require('./fsbrowse');
const downloads = require('./downloads');

const app = express();
const PORT = process.env.PORT || 8787;
// This API browses the filesystem and writes files, so it stays on loopback.
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

fsbrowse.register(app);
downloads.register(app);

function parseOptions(query) {
  const url = (query.url || '').trim();
  if (!url) throw new Error('A `url` query parameter is required.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported.');

  return {
    url,
    mode: query.mode === 'fast' ? 'fast' : 'click',
    voiceId: query.voice ? String(query.voice) : null,
    limit: Number.parseInt(query.limit, 10) > 0 ? Number.parseInt(query.limit, 10) : 0,
    concurrency: Number.parseInt(query.concurrency, 10) > 0 ? Number.parseInt(query.concurrency, 10) : 4,
  };
}

/** Streaming scrape: results show up one by one instead of after a long wait. */
app.get('/api/scrape', async (req, res) => {
  let options;
  try {
    options = parseOptions(req.query);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let cancelled = false;
  req.on('close', () => {
    cancelled = true;
  });

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({ type: 'log', message: `Starting (${options.mode} mode)…` });

  try {
    await scrape({ ...options, onEvent: send, isCancelled: () => cancelled });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'fatal', message: e.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/** Same thing, buffered, for curl/scripting. */
app.get('/api/scrape.json', async (req, res) => {
  let options;
  try {
    options = parseOptions(req.query);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const items = [];
  let meta = null;
  try {
    await scrape({
      ...options,
      onEvent: (event) => {
        if (event.type === 'item') items.push(event);
        if (event.type === 'meta') meta = event;
      },
    });
    res.json({ meta, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  const { ffmpeg } = require('./ffmpeg').tools();
  console.log(`uakino-loader API listening on http://${HOST}:${PORT}`);
  console.log(ffmpeg ? `ffmpeg: ${ffmpeg}` : 'ffmpeg: NOT FOUND (set FFMPEG_PATH)');
});
