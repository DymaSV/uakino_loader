'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  download,
  sanitizeName,
  tools,
  probeFile,
  concatFiles,
  compareParts,
  cutRange,
  parseTimeSpec,
} = require('./ffmpeg');
const { isWritable } = require('./fsbrowse');

const jobs = new Map();

/** Queue position drives the suffix: base_1.mp4, base_2.mp4, … */
function buildFilename(baseName, position) {
  return `${sanitizeName(baseName)}_${position}.mp4`;
}

function emit(job, event) {
  const payload = { ...event, at: Date.now() };
  job.events.push(payload);
  for (const res of job.listeners) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function combinedFilenameFor(baseName) {
  return `${sanitizeName(baseName)}.mp4`;
}

/**
 * Validate the trim range the client asked for. Applies to every item in the
 * job, so one bad value should stop the whole thing rather than quietly
 * producing a mix of cut and uncut files.
 */
function normalizeTrim(trim) {
  if (!trim) return null;

  const from = parseTimeSpec(trim.from ?? 0) ?? 0;
  const to = parseTimeSpec(trim.to);
  if (to === null) throw new Error('Trim: enter the second the cut ends at.');
  if (to <= from) throw new Error('Trim: the end has to be later than the start.');
  return { from, to };
}

function createJob({ items, dir, baseName, quality, overwrite, referer, combine, trim }) {
  if (!Array.isArray(items) || !items.length) throw new Error('The load list is empty.');
  if (!dir) throw new Error('Pick a destination folder first.');

  const cut = normalizeTrim(trim);

  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir)) throw new Error(`Folder does not exist: ${resolvedDir}`);
  if (!fs.statSync(resolvedDir).isDirectory()) throw new Error('Destination is not a folder.');
  if (!isWritable(resolvedDir)) throw new Error(`Folder is not writable: ${resolvedDir}`);
  if (!tools().ffmpeg) throw new Error('ffmpeg was not found. Set FFMPEG_PATH or add it to PATH.');

  const job = {
    id: crypto.randomUUID(),
    dir: resolvedDir,
    baseName,
    quality: quality || 'best',
    overwrite: !!overwrite,
    referer: referer || null,
    combine: !!combine,
    trim: cut,
    combinedFilename: combinedFilenameFor(baseName),
    status: 'running',
    cancelled: false,
    currentChild: null,
    events: [],
    listeners: new Set(),
    items: items.map((item, i) => ({
      position: i + 1,
      label: item.label || `item ${i + 1}`,
      voice: item.voice || '',
      src: item.src,
      filename: buildFilename(baseName, i + 1),
      status: 'pending',
      percent: 0,
      bytes: 0,
      error: null,
    })),
  };

  jobs.set(job.id, job);
  setImmediate(() => runJob(job));
  return job;
}

async function runJob(job) {
  emit(job, {
    type: 'job-start',
    dir: job.dir,
    total: job.items.length,
    trim: job.trim,
    items: job.items.map((i) => ({ position: i.position, label: i.label, filename: i.filename })),
  });

  for (const item of job.items) {
    if (job.cancelled) break;

    const outPath = path.join(job.dir, item.filename);

    if (!job.overwrite && fs.existsSync(outPath)) {
      item.status = 'skipped';
      item.error = 'file already exists';
      emit(job, { type: 'item-done', position: item.position, status: 'skipped', error: item.error });
      continue;
    }

    item.status = 'downloading';
    emit(job, { type: 'item-start', position: item.position, filename: item.filename, label: item.label });

    let lastPush = 0;
    const result = await download({
      url: item.src,
      outPath,
      quality: job.quality,
      referer: job.referer,
      // A cut that starts at 0 is a head trim: skipping it during the fetch
      // costs nothing and saves downloading the bytes at all. Anything else has
      // to be carved out of the finished file below.
      startAt: job.trim && job.trim.from === 0 ? job.trim.to : 0,
      registerChild: (child) => {
        job.currentChild = child;
      },
      onProgress: ({ percent, seconds, bytes }) => {
        item.percent = percent ?? item.percent;
        item.bytes = bytes;
        const now = Date.now();
        if (now - lastPush < 500) return; // throttle: ffmpeg reports very often
        lastPush = now;
        emit(job, { type: 'item-progress', position: item.position, percent, seconds, bytes });
      },
    });

    job.currentChild = null;

    if (job.cancelled) {
      item.status = 'cancelled';
      fs.promises.rm(outPath, { force: true }).catch(() => {});
      emit(job, { type: 'item-done', position: item.position, status: 'cancelled' });
      break;
    }

    if (result.ok) {
      // Mid-file cuts need the finished file, so they run here rather than
      // during the fetch. Head trims were already applied by `startAt`.
      if (job.trim && job.trim.from > 0) {
        const cut = await applyTrim(job, item, outPath);
        if (!cut.ok) {
          item.status = 'error';
          item.error = cut.error;
          fs.promises.rm(outPath, { force: true }).catch(() => {});
          emit(job, { type: 'item-done', position: item.position, status: 'error', error: cut.error });
          continue;
        }
        if (job.cancelled) {
          item.status = 'cancelled';
          fs.promises.rm(outPath, { force: true }).catch(() => {});
          emit(job, { type: 'item-done', position: item.position, status: 'cancelled' });
          break;
        }
      }

      item.status = 'done';
      item.percent = 100;
      item.bytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : result.bytes || 0;
      emit(job, {
        type: 'item-done',
        position: item.position,
        status: 'done',
        bytes: item.bytes,
        path: outPath,
      });
    } else {
      item.status = 'error';
      item.error = result.error;
      // A failed remux leaves an unusable stub behind.
      fs.promises.rm(outPath, { force: true }).catch(() => {});
      emit(job, { type: 'item-done', position: item.position, status: 'error', error: result.error });
    }
  }

  if (job.combine && !job.cancelled) await runCombine(job);

  job.status = job.cancelled ? 'cancelled' : 'done';
  const summary = job.items.reduce(
    (acc, i) => ({ ...acc, [i.status]: (acc[i.status] || 0) + 1 }),
    {}
  );
  emit(job, { type: 'job-done', status: job.status, summary });

  for (const res of job.listeners) if (!res.writableEnded) res.end();
  job.listeners.clear();

  // Keep the record around briefly so a late subscriber can still read the outcome.
  setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref?.();
}

/**
 * Cut the trim range out of a finished part, in place.
 *
 * ffmpeg cannot rewrite the file it is reading, so the result goes to a sibling
 * temp file that then replaces the original — same folder, so the swap is a
 * rename rather than a copy, and a failure leaves the untrimmed file untouched.
 */
async function applyTrim(job, item, outPath) {
  const temp = path.join(job.dir, `.${item.filename}.cut.mp4`);

  item.status = 'trimming';
  emit(job, { type: 'item-trim', position: item.position, from: job.trim.from, to: job.trim.to });

  try {
    const result = await cutRange({
      inPath: outPath,
      outPath: temp,
      from: job.trim.from,
      to: job.trim.to,
      registerChild: (child) => {
        job.currentChild = child;
      },
    });
    job.currentChild = null;

    if (job.cancelled) return { ok: true };
    if (!result.ok) return result;

    await fs.promises.rm(outPath, { force: true });
    await fs.promises.rename(temp, outPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    job.currentChild = null;
    fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

/** Join the freshly downloaded parts into one MP4, in queue order. */
async function runCombine(job) {
  const finished = job.items.filter((i) => i.status === 'done');

  if (finished.length < 2) {
    emit(job, {
      type: 'combine-done',
      status: 'skipped',
      error: finished.length
        ? 'only one file downloaded — nothing to join'
        : 'no files downloaded',
    });
    return;
  }

  emit(job, { type: 'combine-start', filename: job.combinedFilename, count: finished.length });

  const outPath = path.join(job.dir, job.combinedFilename);
  if (!job.overwrite && fs.existsSync(outPath)) {
    emit(job, { type: 'combine-done', status: 'skipped', error: `${job.combinedFilename} already exists` });
    return;
  }

  // Inspect every part first: mismatched parts still join with exit 0 but
  // produce a file that changes resolution partway through.
  const parts = [];
  for (const item of finished) {
    const full = path.join(job.dir, item.filename);
    const info = await probeFile(full);
    if (!info) {
      emit(job, { type: 'combine-done', status: 'error', error: `could not read ${item.filename}` });
      return;
    }
    parts.push({ filename: item.filename, path: full, info });
  }

  const match = compareParts(parts);
  if (!match.ok) {
    emit(job, {
      type: 'combine-done',
      status: 'error',
      error:
        `Parts do not share the same format, so they cannot be joined without re-encoding: ${match.reason}. ` +
        `Pick an explicit quality instead of "Best" so every episode matches.`,
    });
    return;
  }

  const totalDuration = parts.reduce((sum, p) => sum + p.info.durationSec, 0);
  let lastPush = 0;

  const result = await concatFiles({
    files: parts.map((p) => p.path),
    outPath,
    listPath: path.join(os.tmpdir(), `uakino-concat-${job.id}.txt`),
    totalDuration,
    registerChild: (child) => {
      job.currentChild = child;
    },
    onProgress: ({ percent, seconds }) => {
      const now = Date.now();
      if (now - lastPush < 500) return;
      lastPush = now;
      emit(job, { type: 'combine-progress', percent, seconds });
    },
  });

  job.currentChild = null;

  if (job.cancelled) {
    fs.promises.rm(outPath, { force: true }).catch(() => {});
    emit(job, { type: 'combine-done', status: 'cancelled' });
    return;
  }

  if (!result.ok) {
    fs.promises.rm(outPath, { force: true }).catch(() => {});
    emit(job, { type: 'combine-done', status: 'error', error: result.error });
    return;
  }

  const bytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  emit(job, {
    type: 'combine-done',
    status: 'done',
    filename: job.combinedFilename,
    path: outPath,
    bytes,
    durationSec: totalDuration,
    parts: parts.length,
  });
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  if (job.currentChild) {
    try {
      job.currentChild.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return true;
}

function subscribe(id, res) {
  const job = jobs.get(id);
  if (!job) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Replay anything that already happened so nothing is missed.
  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (job.status !== 'running') {
    res.end();
    return true;
  }

  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
  return true;
}

function register(app) {
  app.get('/api/ffmpeg', (_req, res) => {
    const { ffmpeg, ffprobe } = tools();
    res.json({ ffmpeg, ffprobe, ok: !!ffmpeg });
  });

  app.post('/api/download', (req, res) => {
    try {
      const job = createJob(req.body || {});
      res.json({ jobId: job.id, items: job.items.map((i) => ({ position: i.position, filename: i.filename })) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/download/:id/events', (req, res) => {
    if (!subscribe(req.params.id, res)) res.status(404).json({ error: 'No such job.' });
  });

  app.post('/api/download/:id/cancel', (req, res) => {
    res.json({ cancelled: cancelJob(req.params.id) });
  });

  /** Filename preview without starting anything. */
  app.post('/api/download/preview', (req, res) => {
    const { items = [], baseName = '', dir = '' } = req.body || {};
    const rows = items.map((item, i) => {
      const filename = buildFilename(baseName, i + 1);
      let exists = false;
      try {
        exists = !!dir && fs.existsSync(path.join(path.resolve(dir), filename));
      } catch {
        /* unreadable dir */
      }
      return { position: i + 1, filename, exists };
    });

    const combinedFilename = combinedFilenameFor(baseName);
    let combinedExists = false;
    try {
      combinedExists = !!dir && fs.existsSync(path.join(path.resolve(dir), combinedFilename));
    } catch {
      /* unreadable dir */
    }

    res.json({ rows, combinedFilename, combinedExists });
  });
}

module.exports = { register, buildFilename };
