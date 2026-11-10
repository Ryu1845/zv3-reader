# ZV3 Reader

A Chromium extension (built for Helium) that reads web pages aloud with [ZONOS3](https://github.com/Zyphra/ZONOS3-Mini).
Audio streams in live; the sentence being read is highlighted and kept in view. Two engines:

- **Local** (default): ZONOS3's in-browser engine (`servers/web` of ZONOS3-Mini), running on WebGPU in this browser.
  Nothing is sent anywhere.
- **Server**: a ZONOS3 HTTP server (MLX, ggml or CUDA), by default `http://127.0.0.1:1919`, e.g. ZONOS3-Mini's
  `servers/mlx/scripts/serve.sh` on Apple silicon.

Both engines speak the ZONOS3 v2 API (`POST /v2/generate`, streamed float32 PCM), use their built-in voices through
speaker embeddings, and decode with the full-size codec decoder (`full_mr`) when they serve it. The reader supports all
22 ZONOS3 languages.

## Install

Needs a Chromium browser (123 or later) with WebGPU for the local engine, plus Node, pnpm and the Hugging Face CLI
(`hf`) to set it up.

1. For the local engine, check out ZONOS3-Mini next to this folder, then build its engine and copy its models in
   (about 2.6 GB):
   ```bash
   git clone https://github.com/Zyphra/ZONOS3-Mini.git ../ZONOS3
   pnpm --dir ../ZONOS3 install
   scripts/vendor-zonos3.sh
   ```
   The models come from the checkout's own export (`pnpm --dir servers/web export`) when it has one, otherwise from
   the `web/` folder of [Zyphra/ZONOS3-Mini on Hugging Face](https://huggingface.co/Zyphra/ZONOS3-Mini). Pass another
   checkout's path as the first argument; `MODELS_FROM=hf` forces the download. Run it again whenever ZONOS3 changes.
   The server engine works without this step.
2. Open `chrome://extensions` in Helium and turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Optional: check or change the shortcuts at `chrome://extensions/shortcuts` (a key that clashes with another
   extension or the browser is silently left unassigned).
5. Optional: Options → **Check local engine** confirms WebGPU and the model files.

There is no build step for the extension itself. After editing files, click the reload icon on the extension card.

## Use

| Action | How |
|---|---|
| Read the article, or the selection if there is one | **Alt+Shift+R** (Option+Shift+R on Mac), or the toolbar popup |
| Pause / resume | **Alt+Shift+R** again (works from any tab), or ⏯ in the floating bar |
| Back / forward 10 s | **Alt+Shift+,** / **Alt+Shift+.**, or −10s / +10s in the bar |
| Stop | **Alt+Shift+S**, or ■ in the bar |
| Read a selection | Right-click → **Read selection aloud** (also works in the PDF viewer and frames, audio only) |
| Speed (0.75–2×, pitch kept) | 1× button in the bar, or the popup |
| Engine | Popup or Options: **Local** or **Server**. Applies from the next read. |
| Voice | Popup: search, ▶ preview, click to use it for the page's language, ☆ to add to the bar's quick-switch list. A switch mid-article applies from the next paragraph. Local mode lists the engine's built-in voices (`models/voices/voices.json`); server mode lists the server's voices that take an embedding (`GET /v2/speakers`). |
| Download | ⬇ in the bar, or the popup: **Save audio so far**, or **Generate all & save** (one part at a time; can take minutes) |

Switching tabs keeps it playing. Navigating away or closing the tab stops it.

## Privacy

**Local engine:** the text never leaves the computer.

**Server engine:** the text read aloud is sent to the ZONOS3 server set in Options. 127.0.0.1 and localhost are
allowed by default; any other server asks for host access when you save it.

- Sites on the denylist (Options) are never read, by either engine. Gmail, Google Docs/Drive/Calendar, Outlook and
  Slack are pre-filled.

## How it works

```
popup / shortcuts / context menu
        │
        ▼
sw.js (stateless) ── injects ──► content script (page): extract → sentences → chunks; highlight, scroll, bar
        │                                 │  port "zv3:tab"
        └── creates ──► offscreen document (the session):
                          prefetch jobs, stream float32 audio, WSOLA AudioWorklet, seek, export
                          └── local engine: ZONOS3 web Worker (WebGPU), models read from models/
```

- **Extraction** (`content/extract.js`): Readability on a clone of the page. Text nodes are mapped back to the
  live DOM so ranges can be highlighted with the CSS Custom Highlight API, which doesn't change the DOM. Footnote
  markers and hidden text are skipped; `<br>`, soft hyphens and zero-width characters are normalized. If
  Readability fails, it falls back to text matching and then to the page's visible text.
- **Chunks** (`shared/chunker.js`): sentences are packed by estimated audio length. The first part is about 8 s,
  then about 18 s, then whole paragraphs up to about 40 s; never more than 1500 characters. Each request sends
  its own `max_tokens` (at most 2000 frames, about 133 s), so long or CJK text isn't cut off. Speech rates per voice
  and language are learned as you listen.
- **Session** (`offscreen/session.js`): keeps the current part and the next one generated (the next two at 1.5×
  and faster), with at most 2 jobs outstanding. A failed part is retried once, then skipped.
- **Audio** (`offscreen/engine.js`, `wsola-*.js`):
  - The live stream is stored as Int16 per part. Parts more than 30 s behind the playhead are dropped and fetched
    again from the final WAV if you seek back.
  - Speed changes use a streaming WSOLA time-stretch in an AudioWorklet; at 1× it passes audio through unchanged.
  - Sentence timing comes from detecting pauses in the audio, matched to the sentences' expected times.
- **Backend adapter** (`backend/`): everything above it talks about "jobs" (`config`, `synthesize`, `status`,
  `liveUrl`, `wavUrl`, `previewUrl`, `fetch`, `cancel`); `getBackend` returns the local or the server backend.
  - `ZonosBackend` (`backend/zonos.js`) runs jobs one at a time through a v2 API function: `POST /v2/generate` with
    `speaker_mode: 'embedding'`, `stream: true`, `format: 'pcm'`, and `decoder: 'full_mr'` when the engine lists the
    full-size codec decoder in `GET /v2/capabilities` (`decoders`); otherwise the engine's default decoder (the pruned
    `keep2_plain`) is used. Each job's stream is kept so a late reader still gets every sample, then compacted to a WAV
    Blob. Its `zv3-job:` live and WAV URLs are served by its own `fetch`. Jobs are cancelled when a voice switch or
    stop makes them useless.
  - `localBackend` lists `models/voices/voices.json` and loads the vendored engine (`vendor/zonos3/engine.js`, which
    spawns its workers) the first time a part is generated; the API function is the engine's `localFetch`.
  - `serverBackend` lists `GET /v2/speakers` (after checking `GET /v2/capabilities` offers embeddings) and calls the
    server over HTTP.

Helium specifics:
- The session lives in the offscreen document because Helium freezes background tabs.
- The reading tab is marked non-discardable during a session, because Memory Saver is on by default.
- The offscreen document is created with the `WORKERS` and `BLOBS` reasons as well as `AUDIO_PLAYBACK`, so a long
  pause doesn't close it.

## Tests

```bash
npm test
```

```bash
node scripts/smoke.mjs
```

- `npm test` runs the unit tests: chunker, language mapping, sentence splitting, stream decoding, WAV, timeline
  seeking, WSOLA (exact at 1×, length, pitch and loudness at other speeds) and the sentence aligner.
- `npm test` also covers the ZONOS3 job backend against a fake v2 API (`test/zonos.test.mjs`): voice lists for both
  engines, the generate request, job order, cancellation, late readers, WAV compaction, the length cap, API error
  details, and fatal errors (engine start failure, GPU loss, unreachable server).
- `node scripts/smoke.mjs [serverUrl]` runs one streamed part against a running ZONOS3 server (default
  `http://127.0.0.1:1919`). It checks the live stream and the final WAV.
- `node scripts/serve.mjs 8798` serves the browser harnesses:
  - `test/harness.html` checks extraction and highlight ranges.
  - `test/engine.html` runs the engine and worklet against a fake streaming backend; click its buttons.
  - `test/local.html` runs the real local engine (needs `scripts/vendor-zonos3.sh`; add `?auto` to start it without
    a click). It reports model load time, TTFB and RTF for two built-in voices and French, then plays a part
    through the Engine.

### Manual checklist

- [ ] Wikipedia article with Alt+Shift+R: first audio within about 6 s, and the highlight follows and scrolls.
- [ ] ±10 s across a part boundary; 1.5× and 2× keep the pitch with no gaps.
- [ ] Pause for 2+ minutes, then resume. Switch to another tab for 5+ minutes; it keeps playing.
- [ ] Navigating away or closing the tab stops it.
- [ ] Right-click → Read selection aloud. Switch the voice from the bar; it applies from the next paragraph.
- [ ] Local: no consent prompt; the bar shows "Loading the local model (N%)…" on the first read.
- [ ] Server: with `servers/mlx/scripts/serve.sh` running, the popup lists the server's voices and reading plays;
      with it stopped, the bar shows "Can't reach the ZONOS3 server at …".
- [ ] A denylisted site is blocked in both modes.
- [ ] Both download modes produce a WAV that plays.
- [ ] No errors on `chrome://extensions`. Inspect the offscreen document from the service worker's DevTools
      (Inspect views).

## Known limitations

- Local: the first read after the offscreen document starts loads the model onto the GPU (about 3 s on an
  Apple-silicon Mac), and its first part loads the full decoder (about 3 s more). The offscreen document closes after
  10 idle minutes and frees that memory.
- The full decoder takes about twice the generation time of the engines' default one (on an M-series Mac, about 0.25×
  realtime locally instead of 0.1×), for better audio.
- Local: there is no text normalization (HTTP servers normalize when their normalizer is installed), so numbers and
  abbreviations can read less well.
- Local: after a GPU device loss the session stops with an error; the next read starts a fresh engine.
- Parts are generated one at a time for both engines; a server never gets concurrent requests from the reader.
- Reference and footnote lists at the end of articles (e.g. Wikipedia's) are read, because they are part of the
  article content.
- Text inside shadow DOM components isn't extracted in article mode; select it and use **Read selection aloud**.
- The extension can't run on `chrome://` pages or the Web Store.

## License

MIT (see `LICENSE`). `vendor/Readability*.js` is Mozilla's Readability (Apache 2.0, `vendor/Readability-LICENSE.md`).
The ZONOS3 engine built into `vendor/zonos3/` is MIT and the ZONOS3-Mini model files copied into `models/` are
Apache 2.0; neither is part of this repository.
