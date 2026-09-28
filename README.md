# uakino loader

Paste a uakino page URL, get back the list of `<video>` `src` URLs for every item in the
playlist.

## Why there is a backend

A browser-only React app cannot do this:

- **Cloudflare.** uakino sits behind a managed challenge. A plain `fetch`/`curl` gets
  `403 Just a moment...`. Only a real browser engine gets through.
- **CORS.** Even past the challenge, `fetch('https://uakino.best/...')` from a page on
  `localhost` is blocked — no CORS headers.
- **The playlist is not in the HTML.** The page ships an empty
  `<div id="pre" class="playlists-ajax" data-news_id="25998">`. An IntersectionObserver
  fills it from `/engine/ajax/playlists.php?news_id=…&xfield=playlist` only once the div
  scrolls into view.
- **The `<video>` is cross-origin.** Clicking a list item builds an `ashdi.vip` iframe.
  Same-origin policy blocks reading into it from JS; a browser automation driver is not
  bound by that.

So: **React frontend + Node/Playwright backend** that drives a headless Chromium.

## Run it

```bash
npm run install:all   # installs both packages + downloads Chromium
npm run dev           # API on :8787, UI on http://localhost:5173
```

Open http://localhost:5173.

## What it does

1. Opens the URL in headless Chromium and waits out the Cloudflare check.
2. Scrolls `.playlists-ajax` into view to trigger the lazy playlist load. If the observer
   does not fire, it calls the `playlists.php` endpoint directly and injects the markup —
   the site's click handlers are delegated on `body`, so injected items stay clickable.
3. Reads the playlist model. `.playlists-lists` holds two `.playlists-items` blocks: dub
   studios (no `data-file`) and episodes (`data-file`), joined by `data-id`.
4. Clicks each `<li>`, waits for the `ashdi.vip` player frame, and reads the `src` off its
   `<video>` tag.
5. Streams every result to the UI over SSE as it lands.

Episodes belonging to a non-selected studio are `display:none`, so the scraper walks studio
by studio: select the dub tab, then click its episodes.

### Pages with no playlist (films)

Film pages have no `.playlists-ajax` block at all — the player is a bare iframe already in
the markup, e.g. `<iframe id="pre" src="https://ashdi.vip/vod/281126">`. Waiting for a
playlist there just times out.

So the playlist wait is short and non-fatal. When no playlist turns up, the scraper reads
the embedded players directly, naming each after its player tab (`UA #1`, …) and reporting
`source: "single"`. Clicking is skipped for these, since there is no list item to click.

The same page also carries a **YouTube trailer** in an identical `id="pre"` iframe, so
YouTube, Telegram and the usual ad/social embeds are filtered out — otherwise the trailer
would be picked up as if it were the film.

If a page has neither, it fails quickly with
`This page has neither a playlist nor a recognisable player iframe.`

### Modes

- **Click each item** (default) — drives the real UI exactly as described above.
- **Fast** — skips the UI and opens each `data-file` embed directly, 4 pages in parallel.
  Same `<video>` src, several times quicker on an 83-episode list.

### Blob fallback

These players expose a direct `.m3u8` in `video.src`. If a player ever uses MSE instead,
`src` would be a useless `blob:` URL — the scraper also sniffs network traffic for
`.m3u8`/`.mp4` and reports that as `streamUrl`.

## API

```bash
# streaming (SSE) — used by the UI
curl -N "http://localhost:8787/api/scrape?url=<PAGE_URL>&mode=click&limit=5"

# buffered JSON — for scripting
curl "http://localhost:8787/api/scrape.json?url=<PAGE_URL>&mode=fast&limit=5"
```

| Param | Meaning |
| --- | --- |
| `url` | page to scrape (required) |
| `mode` | `click` (default) or `fast` |
| `voice` | restrict to one dub studio's `data-id`, e.g. `0_2` |
| `limit` | max items, `0`/omitted = all |
| `concurrency` | parallel pages in `fast` mode (default 4, max 8) |

## Downloading to MP4

Extracted rows can be checked individually or pushed over with **Add all →** into the
**List to load** panel. Pick a destination with **Load to…**, set the base file name, then
hit **Load**. Items download **one at a time**, in list order, with live progress.

Files are named `<base name>_1.mp4`, `<base name>_2.mp4`, … by queue position. The base
name is derived from the page title (`Серіал X … дивитися онлайн …` → `X (2025) 2 сезон`)
and is editable. Only characters Windows forbids are stripped, so spaces survive.

### Why remux instead of convert

The HLS streams are already H.264 video + AAC audio — exactly what MP4 holds. So this uses:

```
ffmpeg -i <stream>.m3u8 -c copy -bsf:a aac_adtstoasc -movflags +faststart out.mp4
```

`-c copy` rewrites the container **without re-encoding**: a 23-minute episode finishes in
about a minute and is bit-for-bit identical to the source. A real transcode
(`-c:v libx264`) would take far longer and lose quality for no benefit. `+faststart`
moves the index to the front so the file plays before it is fully copied, and
`aac_adtstoasc` fixes AAC headers coming from MPEG-TS (with an automatic retry without it
if a stream does not need it).

### ffmpeg discovery

ffmpeg is found automatically: `FFMPEG_PATH`, then `PATH`, then the usual install spots
(winget, chocolatey, scoop, `C:\ffmpeg`, Shotcut). On this machine it resolved to the
winget build. `GET /api/ffmpeg` reports what it found.

### Quality

The playlists are master playlists offering 1080p / 720p / 480p. **Best** (default) takes
the highest. Choosing an explicit height maps to that variant's program with `-map 0:p:N`.

### Combining into one file

Tick **Combine everything into one file afterwards**. Once every part has downloaded, they
are joined in queue order into `<base name>.mp4` (no number suffix, so it never collides
with the parts). The numbered parts are kept.

The join is another stream copy — ffmpeg's concat demuxer with `-c copy` — so it costs a
disk pass, not a re-encode, and loses nothing:

```
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4
```

**Every part is probed before joining, and a mismatch aborts the join.** This check is not
optional paranoia: joining a 480p part with a 1080p part *succeeds* — ffmpeg exits 0 and
the file decodes without a single error — but the result genuinely switches resolution
partway through while the MP4 header still advertises the first one. ffmpeg and VLC cope;
browsers and most hardware players do not. Since the exit code cannot be trusted here, the
codec, resolution, audio codec, sample rate and channel count of every part are compared up
front, and the join is refused with the exact mismatch named.

This matters in practice with **Best** quality: different episodes or dub studios can top
out at different resolutions. If a join is refused, re-download with an explicit quality
(720p, say) so every part matches.

### Safety details

- Target files that already exist are **skipped** unless **Overwrite** is ticked; the queue
  marks them `exists` before you start.
- **Cancel** kills the running ffmpeg and deletes the partial file, leaving remaining items
  untouched.
- A failed remux deletes its unusable stub rather than leaving a broken MP4.
- The API binds to **127.0.0.1** only. It browses the filesystem and writes files, so it
  must not be reachable from the network.

### Download API

```bash
POST /api/download            # { items, dir, baseName, quality, overwrite, referer } -> { jobId }
GET  /api/download/:id/events # SSE progress (replays from the start if you attach late)
POST /api/download/:id/cancel
POST /api/download/preview    # filename preview + which targets already exist
GET  /api/fs/roots            # Desktop/Downloads/Videos/Documents/Home + drives
GET  /api/fs/list?path=…      # sub-folders, parent, writability
POST /api/fs/mkdir            # { parent, name }
```

Windows known folders are resolved through the OS, because a Desktop can be
OneDrive-redirected *and* localized — here it is `C:\Users\dymas\OneDrive\Рабочий стол`,
which no amount of appending `"Desktop"` to the home directory would ever find.
