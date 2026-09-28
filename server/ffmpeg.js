'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = (name) => (IS_WIN ? `${name}.exe` : name);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Directories worth checking when ffmpeg is not on PATH. */
function candidateDirs() {
  const dirs = [];
  const local = process.env.LOCALAPPDATA;

  // winget installs into a versioned folder, so walk one level down.
  if (local) {
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of fs.readdirSync(packages)) {
        if (!/ffmpeg/i.test(entry)) continue;
        const pkg = path.join(packages, entry);
        for (const build of fs.readdirSync(pkg)) {
          dirs.push(path.join(pkg, build, 'bin'));
        }
      }
    } catch {
      /* not installed via winget */
    }
    dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
  }

  dirs.push(
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\Program Files\\Shotcut',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin'
  );
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, 'scoop', 'shims'));
  return dirs;
}

function locate(name, override) {
  if (override && fs.existsSync(override)) return override;

  const exe = EXE(name);
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...candidateDirs()]) {
    try {
      const full = path.join(dir, exe);
      if (fs.existsSync(full)) return full;
    } catch {
      /* unreadable dir */
    }
  }
  return null;
}

let cached = null;
function tools() {
  if (cached) return cached;
  const ffmpeg = locate('ffmpeg', process.env.FFMPEG_PATH);
  const ffprobe =
    locate('ffprobe', process.env.FFPROBE_PATH) ||
    (ffmpeg ? path.join(path.dirname(ffmpeg), EXE('ffprobe')) : null);
  cached = {
    ffmpeg,
    ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null,
  };
  return cached;
}

function run(bin, args, { onStdout, onStderr, registerChild } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    registerChild && registerChild(child);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => onStdout && onStdout(d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      onStderr && onStderr(d);
    });
    child.on('error', (e) => resolve({ code: -1, stderr: e.message, child }));
    child.on('close', (code) => resolve({ code, stderr, child }));
    resolve.child = child;
  });
}

/** Duration plus the ordered list of video-variant heights in the master playlist. */
async function probe(url) {
  const { ffprobe } = tools();
  if (!ffprobe) return { durationSec: 0, heights: [] };

  let out = '';
  const { code } = await run(
    ffprobe,
    [
      '-v', 'error',
      '-user_agent', USER_AGENT,
      '-show_entries', 'format=duration:stream=index,codec_type,height',
      '-of', 'json',
      url,
    ],
    { onStdout: (d) => (out += d) }
  );
  if (code !== 0) return { durationSec: 0, heights: [] };

  try {
    const parsed = JSON.parse(out);
    const durationSec = Number.parseFloat(parsed.format?.duration) || 0;
    const heights = (parsed.streams || [])
      .filter((s) => s.codec_type === 'video' && s.height)
      .map((s) => s.height);
    return { durationSec, heights };
  } catch {
    return { durationSec: 0, heights: [] };
  }
}

/**
 * Accepts 130, "130", "2:10" or "1:02:10" and returns seconds.
 * Returns null for anything unusable, so callers can tell "empty" from "zero".
 */
function parseTimeSpec(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
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

function sanitizeName(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120) || 'video';
}

/**
 * Remux an HLS stream into MP4. The source is already H.264/AAC, so `-c copy`
 * rewrites the container without re-encoding: far faster than a transcode and
 * lossless. Re-encoding would only be needed for a codec change.
 */
function buildArgs({ url, outPath, programIndex, referer, withBsf, startAt }) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-progress', 'pipe:1',
    '-user_agent', USER_AGENT,
  ];
  if (referer) args.push('-referer', referer);
  // Before -i, so ffmpeg seeks the playlist instead of fetching and discarding
  // the skipped segments. With -c copy the cut snaps to the nearest keyframe,
  // which on these streams is within a couple of seconds of the number asked for.
  if (startAt > 0) args.push('-ss', String(startAt));
  args.push('-i', url);
  if (programIndex != null) args.push('-map', `0:p:${programIndex}`);
  args.push('-c', 'copy');
  if (withBsf) args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-movflags', '+faststart', '-y', outPath);
  return args;
}

/**
 * Download one stream to disk.
 * Returns { ok, error, bytes }. `onProgress({ percent, seconds, speed, bytes })`
 * fires as ffmpeg reports.
 */
async function download({ url, outPath, quality = 'best', referer, startAt = 0, onProgress, registerChild }) {
  const { ffmpeg } = tools();
  if (!ffmpeg) return { ok: false, error: 'ffmpeg binary not found' };

  const { durationSec, heights } = await probe(url);
  // Input seeking rebases output timestamps to zero, so progress is measured
  // against what actually gets written, not the length of the source.
  const outDuration = Math.max(0, durationSec - startAt);

  // Programs appear in the same order as the video variants, so the position of
  // the requested height in `heights` is the program index.
  let programIndex = null;
  if (quality !== 'best' && heights.length > 1) {
    const wanted = Number.parseInt(quality, 10);
    const at = heights.indexOf(wanted);
    if (at >= 0) programIndex = at;
  }

  const attempt = (withBsf) =>
    new Promise((resolve) => {
      const args = buildArgs({ url, outPath, programIndex, referer, withBsf, startAt });
      const child = spawn(ffmpeg, args, { windowsHide: true });
      registerChild && registerChild(child);

      let stderr = '';
      let bytes = 0;
      let carry = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        carry += chunk;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=');
          if (!key || value === undefined) continue;
          if (key === 'total_size') bytes = Number.parseInt(value, 10) || bytes;
          if (key === 'out_time_ms' || key === 'out_time_us') {
            // Both keys are microseconds in practice despite the _ms name.
            const seconds = (Number.parseInt(value, 10) || 0) / 1_000_000;
            onProgress &&
              onProgress({
                seconds,
                percent: outDuration ? Math.min(99, (seconds / outDuration) * 100) : null,
                bytes,
              });
          }
        }
      });

      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on('error', (e) => resolve({ ok: false, error: e.message, bytes }));
      child.on('close', (code) => {
        if (code === 0) return resolve({ ok: true, bytes, durationSec });
        resolve({ ok: false, error: (stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`), bytes, code });
      });
    });

  let result = await attempt(true);
  // aac_adtstoasc only applies to ADTS AAC; retry without it if it was the problem.
  if (!result.ok && /aac_adtstoasc|bitstream filter/i.test(result.error || '')) {
    result = await attempt(false);
  }
  return { ...result, durationSec: outDuration };
}

/** Stream parameters of a finished file, used to decide whether parts can be joined. */
async function probeFile(filePath) {
  const { ffprobe } = tools();
  if (!ffprobe) return null;

  let out = '';
  const { code } = await run(
    ffprobe,
    [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels',
      '-of', 'json',
      filePath,
    ],
    { onStdout: (d) => (out += d) }
  );
  if (code !== 0) return null;

  try {
    const parsed = JSON.parse(out);
    const video = (parsed.streams || []).find((s) => s.codec_type === 'video') || {};
    const audio = (parsed.streams || []).find((s) => s.codec_type === 'audio') || {};
    return {
      durationSec: Number.parseFloat(parsed.format?.duration) || 0,
      video: { codec: video.codec_name || '', width: video.width || 0, height: video.height || 0 },
      audio: {
        codec: audio.codec_name || '',
        sampleRate: audio.sample_rate || '',
        channels: audio.channels || 0,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Do all parts share the codec/geometry the concat demuxer requires?
 *
 * This has to be checked up front: joining mismatched parts with `-c copy`
 * still exits 0 and still decodes, but the result switches resolution partway
 * through while the MP4 header advertises only the first one. ffmpeg and VLC
 * cope; browsers and most hardware players do not.
 */
function compareParts(parts) {
  const [first, ...rest] = parts;
  for (const part of rest) {
    const v = part.info.video;
    const w = first.info.video;
    if (v.codec !== w.codec || v.width !== w.width || v.height !== w.height) {
      return {
        ok: false,
        reason:
          `"${first.filename}" is ${w.width}x${w.height} ${w.codec} but ` +
          `"${part.filename}" is ${v.width}x${v.height} ${v.codec}`,
      };
    }
    const a = part.info.audio;
    const b = first.info.audio;
    if (a.codec !== b.codec || a.sampleRate !== b.sampleRate || a.channels !== b.channels) {
      return {
        ok: false,
        reason:
          `"${first.filename}" audio is ${b.codec} ${b.sampleRate}Hz/${b.channels}ch but ` +
          `"${part.filename}" is ${a.codec} ${a.sampleRate}Hz/${a.channels}ch`,
      };
    }
  }
  return { ok: true };
}

// The concat list quotes each path; a literal apostrophe closes the quote and
// must become '\'' . Built from char codes so no escape sequence is ambiguous.
const QUOTE = String.fromCharCode(39);
const ESCAPED_QUOTE = QUOTE + String.fromCharCode(92) + QUOTE + QUOTE;

/** Join already-downloaded MP4s into one, without re-encoding. */
async function concatFiles({ files, outPath, listPath, totalDuration, onProgress, registerChild }) {
  const { ffmpeg } = tools();
  if (!ffmpeg) return { ok: false, error: 'ffmpeg binary not found' };

  const body = files
    .map((f) => 'file ' + QUOTE + f.split(QUOTE).join(ESCAPED_QUOTE) + QUOTE)
    .join('\n');
  await fs.promises.writeFile(listPath, body + '\n', 'utf8');

  try {
    return await new Promise((resolve) => {
      const args = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-progress', 'pipe:1',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', outPath,
      ];
      const child = spawn(ffmpeg, args, { windowsHide: true });
      registerChild && registerChild(child);

      let stderr = '';
      let carry = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        carry += chunk;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=');
          if (key === 'out_time_ms' || key === 'out_time_us') {
            const seconds = (Number.parseInt(value, 10) || 0) / 1_000_000;
            onProgress &&
              onProgress({
                seconds,
                percent: totalDuration ? Math.min(99, (seconds / totalDuration) * 100) : null,
              });
          }
        }
      });
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) =>
        code === 0
          ? resolve({ ok: true })
          : resolve({ ok: false, error: stderr.trim().split('\n').pop() || `ffmpeg exited ${code}` })
      );
    });
  } finally {
    fs.promises.rm(listPath, { force: true }).catch(() => {});
  }
}

/** Copy [start, stop) of a local MP4 into its own file. stop <= start means "to the end". */
async function copySegment({ ffmpeg, inPath, outPath, start, stop, registerChild }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', inPath);
  if (stop > start) args.push('-t', String(stop - start));
  args.push(
    '-c', 'copy',
    // Input seeking can leave the first packets with negative timestamps, which
    // makes the pieces overlap once they are joined. Rebase them to zero.
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-y', outPath
  );

  const { code, stderr } = await run(ffmpeg, args, { registerChild });
  return code === 0
    ? { ok: true }
    : { ok: false, error: stderr.trim().split('\n').pop() || `ffmpeg exited ${code}` };
}

/**
 * Write `inPath` to `outPath` with the range [from, to) removed.
 *
 * Only needed when `from` is past the start of the file — a cut that begins at
 * 0 is just a head trim, and `download()` does that with `-ss` while fetching,
 * for free. Here the file already exists, so the two surviving pieces are cut
 * out and joined; `-c copy` keeps it fast and lossless, at the cost of the seam
 * landing on the nearest keyframe rather than the exact second.
 *
 * `inPath` and `outPath` must differ — ffmpeg cannot rewrite a file it is reading.
 */
async function cutRange({ inPath, outPath, from, to, registerChild }) {
  const { ffmpeg } = tools();
  if (!ffmpeg) return { ok: false, error: 'ffmpeg binary not found' };

  const info = await probeFile(inPath);
  const duration = info?.durationSec || 0;
  const head = Math.max(0, from);
  const tail = Math.max(head, to);

  const keepHead = head > 0;
  // A cut running to (or past) the end leaves no tail — that is a plain truncate.
  const keepTail = !duration || tail < duration - 0.1;

  if (!keepHead && !keepTail) return { ok: false, error: 'the cut would remove the whole file' };
  if (keepHead && !keepTail)
    return copySegment({ ffmpeg, inPath, outPath, start: 0, stop: head, registerChild });
  if (!keepHead && keepTail)
    return copySegment({ ffmpeg, inPath, outPath, start: tail, stop: 0, registerChild });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partA = path.join(os.tmpdir(), `uakino-cut-${stamp}-a.mp4`);
  const partB = path.join(os.tmpdir(), `uakino-cut-${stamp}-b.mp4`);

  try {
    const a = await copySegment({ ffmpeg, inPath, outPath: partA, start: 0, stop: head, registerChild });
    if (!a.ok) return a;
    const b = await copySegment({ ffmpeg, inPath, outPath: partB, start: tail, stop: 0, registerChild });
    if (!b.ok) return b;

    return await concatFiles({
      files: [partA, partB],
      outPath,
      listPath: path.join(os.tmpdir(), `uakino-cut-${stamp}.txt`),
      registerChild,
    });
  } finally {
    fs.promises.rm(partA, { force: true }).catch(() => {});
    fs.promises.rm(partB, { force: true }).catch(() => {});
  }
}

module.exports = {
  tools,
  probe,
  probeFile,
  download,
  concatFiles,
  cutRange,
  compareParts,
  parseTimeSpec,
  sanitizeName,
  USER_AGENT,
};
