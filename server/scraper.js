'use strict';

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MEDIA_RE = /\.(m3u8|mp4|mpd)(\?|$)/i;

/** `//ashdi.vip/vod/158820` -> `https://ashdi.vip/vod/158820` */
function normalizeFile(file) {
  if (!file) return null;
  if (file.startsWith('//')) return 'https:' + file;
  if (/^https?:\/\//i.test(file)) return file;
  return 'https://' + file.replace(/^\/+/, '');
}

function sameTarget(frameUrl, embedUrl) {
  try {
    const a = new URL(frameUrl);
    const b = new URL(embedUrl);
    return a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * Read the <video> src out of a player frame. Players that use MSE expose a
 * blob: src, which is useless outside the page, so a blob is reported but the
 * sniffed network stream is kept alongside it as the usable URL.
 */
async function readVideoSrc(frame) {
  return frame
    .evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const src = v.getAttribute('src') || v.src || v.currentSrc || '';
      const sources = [...v.querySelectorAll('source')].map((s) => s.src).filter(Boolean);
      return { src: src || null, sources };
    })
    .catch(() => null);
}

/** Poll every frame that matches the embed URL until a <video> src shows up. */
async function waitForVideoSrc(page, embedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let blobSrc = null;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      if (!url || !sameTarget(url, embedUrl)) continue;

      const found = await readVideoSrc(frame);
      if (found) {
        if (found.src && !found.src.startsWith('blob:')) {
          return { src: found.src, frameUrl: url };
        }
        if (found.sources.length) return { src: found.sources[0], frameUrl: url };
        if (found.src) blobSrc = { src: found.src, frameUrl: url };
      }
    }
    await page.waitForTimeout(200);
  }
  return blobSrc;
}

/**
 * Make the lazy (IntersectionObserver-driven) playlist block render.
 * Returns false when this page simply has no playlist — a film page has a bare
 * player iframe instead — so the caller can fall back rather than time out.
 */
async function loadPlaylist(page, log) {
  const container = await page
    .waitForSelector('.playlists-ajax', { state: 'attached', timeout: 15000 })
    .catch(() => null);

  if (!container) {
    log('No playlist block on this page.');
    return false;
  }

  await page.$eval('.playlists-ajax', (el) => el.scrollIntoView({ block: 'center' }));

  const appeared = () =>
    page
      .waitForSelector('.playlists-items li[data-file]', { state: 'attached', timeout: 20000 })
      .then(() => true)
      .catch(() => false);

  if (await appeared()) {
    log('Playlist loaded (lazy scroll trigger).');
    return true;
  }

  // Fallback: call the module's own endpoint. The query param is `xfield`.
  log('Scroll trigger did not fire — calling the playlist endpoint directly.');
  const result = await page.evaluate(async () => {
    const el = document.querySelector('.playlists-ajax');
    if (!el) return { success: false, message: 'no .playlists-ajax element' };
    const params = new URLSearchParams({
      news_id: el.dataset.news_id || '',
      xfield: el.dataset.xfname || 'playlist',
      time: String(window.dle_edittime || ''),
    });
    const res = await fetch('/engine/ajax/playlists.php?' + params, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const data = await res.json();
    if (data.success && data.response) el.innerHTML = data.response;
    return { success: !!data.success, message: data.message || null };
  });

  if (!result.success) {
    log('Playlist endpoint returned nothing: ' + (result.message || 'unknown'));
    return false;
  }
  return appeared();
}

/**
 * Fallback for pages with no playlist (films): the player is a bare iframe that
 * is already in the markup. Collect every plausible player, skipping the
 * YouTube trailer that sits on the same page and the usual social/ad embeds.
 */
async function collectDirectPlayers(page) {
  return page.evaluate(() => {
    const EXCLUDE =
      /youtube\.com|youtu\.be|ytimg|telegram\.org|doubleclick|googlesyndication|googletagmanager|google\.com|facebook|vk\.com|disqus|criteo|adservice|recaptcha/i;

    const found = [];
    const seen = new Set();

    document.querySelectorAll('iframe').forEach((frame) => {
      const src = frame.src || frame.getAttribute('data-src') || '';
      if (!src || src === 'about:blank' || EXCLUDE.test(src)) return;
      if (seen.has(src)) return;
      seen.add(src);

      // Name it after the player tab it sits under ("UA #1", "Трейлер", …).
      let label = '';
      const section = frame.closest('.players-section');
      const pane = frame.closest('.box');
      if (section && pane) {
        const panes = [...section.querySelectorAll(':scope > .box')];
        const tabs = [...section.querySelectorAll(':scope > ul.tabs > li')];
        const index = panes.indexOf(pane);
        if (index >= 0 && tabs[index]) label = tabs[index].textContent.trim();
      }

      found.push({
        id: '',
        voice: '',
        label: label || (document.title.split('(')[0] || '').trim() || 'Video',
        file: src,
      });
    });

    return found;
  });
}

/**
 * Read the playlist model. The markup holds two `.playlists-items` blocks:
 * one of dub studios (no data-file) and one of episodes (data-file), tied
 * together by data-id.
 */
async function readPlaylistModel(page) {
  return page.evaluate(() => {
    const voices = [];
    const episodes = [];

    document.querySelectorAll('.playlists-items').forEach((block) => {
      block.querySelectorAll('li').forEach((li) => {
        const file = li.getAttribute('data-file');
        const id = li.getAttribute('data-id') || '';
        const label = (li.textContent || '').trim();
        if (file) {
          episodes.push({ id, label, file, voice: li.getAttribute('data-voice') || '' });
        } else if (label) {
          voices.push({ id, label });
        }
      });
    });

    return { voices, episodes };
  });
}

/** Click the dub-studio tab so its episodes become visible/clickable. */
async function selectVoice(page, voiceId) {
  const handle = await page.$(`.playlists-items li:not([data-file])[data-id="${voiceId}"]`);
  if (!handle) return false;
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  await handle.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

/**
 * Scrape one uakino page.
 *
 * @param {object}   opts
 * @param {string}   opts.url        page URL
 * @param {string}   [opts.mode]     'click' (drive the real UI) | 'fast' (open embeds directly)
 * @param {string}   [opts.voiceId]  restrict to one dub studio's data-id
 * @param {number}   [opts.limit]    max episodes
 * @param {number}   [opts.concurrency] parallel pages in fast mode
 * @param {Function} opts.onEvent    progress callback
 * @param {Function} [opts.isCancelled]
 */
async function scrape(opts) {
  const {
    url,
    mode = 'click',
    voiceId = null,
    limit = 0,
    concurrency = 4,
    onEvent = () => {},
    isCancelled = () => false,
  } = opts;

  const log = (message) => onEvent({ type: 'log', message });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--mute-audio'],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: 'uk-UA',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Safety net: if a player ever hands back a blob: src, the sniffed stream
    // request is the thing that is actually usable.
    const sniffed = [];
    context.on('request', (req) => {
      const u = req.url();
      if (MEDIA_RE.test(u)) sniffed.push(u);
    });

    const page = await context.newPage();
    log('Opening page (this also clears the Cloudflare check)…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    const hasPlaylist = await loadPlaylist(page, log);
    if (isCancelled()) return;

    let voices = [];
    let all = [];
    let source = 'playlist';

    if (hasPlaylist) {
      const model = await readPlaylistModel(page);
      voices = model.voices;
      all = model.episodes;
    }

    // Film pages carry a single embedded player instead of a playlist.
    if (!all.length) {
      source = 'single';
      log('Reading the player(s) embedded directly on the page…');
      all = await collectDirectPlayers(page);
      if (all.length) log(`Found ${all.length} player${all.length === 1 ? '' : 's'}.`);
    }

    if (!all.length) {
      throw new Error('This page has neither a playlist nor a recognisable player iframe.');
    }

    let episodes = all;
    if (voiceId) episodes = episodes.filter((e) => e.id === voiceId);
    if (limit > 0) episodes = episodes.slice(0, limit);

    // A bare player has no list item to click, so resolve it directly.
    const effectiveMode = source === 'single' ? 'fast' : mode;

    onEvent({
      type: 'meta',
      title: await page.title(),
      voices,
      totalEpisodes: all.length,
      selected: episodes.length,
      mode: effectiveMode,
      source,
    });

    if (effectiveMode === 'fast') {
      await runFast({
        context,
        episodes,
        url,
        onEvent,
        isCancelled,
        concurrency: Math.min(concurrency, episodes.length),
        sniffed,
      });
    } else {
      await runClicks({ page, episodes, voices, onEvent, isCancelled, sniffed });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Faithful path: click each <li> in the live page, like a person would. */
async function runClicks({ page, episodes, voices, onEvent, isCancelled, sniffed }) {
  // Episodes of a non-selected studio are display:none, so walk studio by studio.
  const groups = new Map();
  for (const ep of episodes) {
    if (!groups.has(ep.id)) groups.set(ep.id, []);
    groups.get(ep.id).push(ep);
  }

  let index = 0;
  const total = episodes.length;

  for (const [groupId, groupEpisodes] of groups) {
    if (isCancelled()) return;
    if (voices.length) await selectVoice(page, groupId);

    for (const ep of groupEpisodes) {
      if (isCancelled()) return;
      index += 1;
      const embed = normalizeFile(ep.file);
      onEvent({ type: 'progress', index, total, label: ep.label, voice: ep.voice });

      const before = sniffed.length;
      let error = null;

      try {
        const li = await page.$(`.playlists-items li[data-file="${ep.file}"][data-id="${ep.id}"]`);
        if (!li) throw new Error('list item vanished from the DOM');
        await li.scrollIntoViewIfNeeded().catch(() => {});
        await li.click({ timeout: 15000 });
      } catch (e) {
        error = 'click failed: ' + e.message.split('\n')[0];
      }

      let found = null;
      if (!error) found = await waitForVideoSrc(page, embed, 25000);

      emitItem({ onEvent, index, total, ep, embed, found, error, sniffed, before });
    }
  }
}

/** Fast path: skip the UI and open each player embed directly, in parallel. */
async function runFast({ context, episodes, url, onEvent, isCancelled, concurrency, sniffed }) {
  const total = episodes.length;
  const workers = Math.max(1, Math.min(concurrency, 8));
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    const page = await context.newPage();
    try {
      while (!isCancelled()) {
        const myIndex = cursor++;
        if (myIndex >= episodes.length) break;

        const ep = episodes[myIndex];
        const embed = normalizeFile(ep.file);
        const before = sniffed.length;
        let error = null;

        onEvent({ type: 'progress', index: ++done, total, label: ep.label, voice: ep.voice });

        try {
          await page.goto(embed, { referer: url, waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (e) {
          error = 'navigation failed: ' + e.message.split('\n')[0];
        }

        let found = null;
        if (!error) {
          const deadline = Date.now() + 25000;
          while (Date.now() < deadline && !found) {
            const got = await readVideoSrc(page.mainFrame());
            if (got && got.src && !got.src.startsWith('blob:')) found = { src: got.src, frameUrl: embed };
            else if (got && got.sources.length) found = { src: got.sources[0], frameUrl: embed };
            else if (got && got.src) found = { src: got.src, frameUrl: embed };
            if (!found) await page.waitForTimeout(200);
          }
        }

        emitItem({ onEvent, index: myIndex + 1, total, ep, embed, found, error, sniffed, before });
      }
    } finally {
      await page.close().catch(() => {});
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
}

function emitItem({ onEvent, index, total, ep, embed, found, error, sniffed, before }) {
  const src = found ? found.src : null;
  const isBlob = !!src && src.startsWith('blob:');
  const stream = sniffed.slice(before).find((u) => MEDIA_RE.test(u)) || null;

  onEvent({
    type: 'item',
    index,
    total,
    label: ep.label,
    voice: ep.voice,
    voiceId: ep.id,
    embed,
    src,
    // Only meaningful when the player hid the real URL behind a blob.
    streamUrl: isBlob ? stream : null,
    error: error || (src ? null : 'no <video> src appeared'),
  });
}

module.exports = { scrape, normalizeFile };
