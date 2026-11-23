# ClipMaster Processor

External FFmpeg processing backend for the **ClipMaster AI** app.

The app runs on Vercel serverless, which cannot run FFmpeg. Heavy media
work is delegated here via `VIDEO_PROCESSING_BACKEND_URL`. This service
runs on **Render's free tier** ($0, no card): 512 MB RAM, 0.1 CPU, sleeps
after 15 min idle (~1 min wake-up).

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check (public, no auth) |
| `POST /api/process/probe` | Video metadata: duration, resolution, fps, codecs |
| `POST /api/process/thumbnail` | Extract a JPG/PNG frame |
| `POST /api/process/render-clip` | Cut a clip (`start`–`end`) and burn word-by-word captions |
| `POST /api/process/transcribe` | Transcribe audio with Groq Whisper (word timestamps) |

All endpoints accept the video **either** as a multipart file upload
(field `video`, `file`, `media` or `audio`) **or** as a `sourceUrl` in
the JSON body. Binary endpoints (thumbnail, render-clip) return the file
by default, or `{ ok, mimeType, filename, dataBase64 }` JSON when
`returnJson: true` (or `?format=json`).

Auth is optional: when `PROCESSING_API_KEY` is set, every
`/api/process/*` call must send `Authorization: Bearer <key>`.
`/health` is always public. **The key must match the `PROCESSING_API_KEY`
value set in Vercel**, otherwise the app's calls get 401.

## API examples

```bash
BASE=https://clipmaster-processor.onrender.com
AUTH="Authorization: Bearer $PROCESSING_API_KEY"

# Probe a remote video
curl -s -X POST $BASE/api/process/probe -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"sourceUrl": "https://example.com/video.mp4"}'
# -> {"ok":true,"durationSeconds":83.4,"width":1920,"height":1080,"fps":30,
#     "videoCodec":"h264","audioCodec":"aac","hasAudio":true,
#     "bitrateKbps":5200,"format":"mov,mp4,m4a,3gp,3g2,mj2","sizeBytes":54211328}

# Probe an uploaded file
curl -s -X POST $BASE/api/process/probe -H "$AUTH" -F video=@video.mp4

# Thumbnail (frame at 2s, 640px wide)
curl -s -X POST $BASE/api/process/thumbnail -H "$AUTH" \
  -F video=@video.mp4 -F time=2 -F width=640 -o thumb.jpg

# Render a clip with word-by-word captions (source-video timestamps)
curl -s -X POST $BASE/api/process/render-clip -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceUrl": "https://example.com/video.mp4",
    "start": 10, "end": 25,
    "captions": [
      {"word": "Hola", "start": 10.2, "end": 10.6},
      {"word": "mundo", "start": 10.6, "end": 11.0}
    ]
  }' -o clip.mp4

# Transcribe (returns words + grouped 3–5 word caption segments)
curl -s -X POST $BASE/api/process/transcribe -H "$AUTH" \
  -F video=@video.mp4 -F language=es
# -> {"ok":true,"text":"Hola mundo...","language":"es","durationSeconds":83.4,
#     "words":[{"word":"Hola","start":0.2,"end":0.6}, ...],
#     "segments":[{"text":"Hola mundo","start":0.2,"end":1.1,"words":[...]}, ...]}
```

Errors are always JSON: `{"ok":false,"error":{"code":"bad_request","message":"..."}}`.
Common codes: `bad_request` (400), `unauthorized` (401), `payload_too_large`
(413), `unsupported_media_type` (415), `transcription_not_configured` (503),
`timeout` (504), `probe_failed` / `render_failed` / `thumbnail_failed` /
`transcription_failed` (502).

## How captions work

1. `/api/process/transcribe` returns Whisper words with start/end times,
   grouped into segments of 3–5 words (breaks at sentence ends and pauses).
2. The app shows those segments on the page when a video is imported.
3. `/api/process/render-clip` accepts the same words in `captions`
   (source-video absolute timestamps), keeps the ones inside the clip
   window, and burns them with ffmpeg + ASS karaoke timing (`{\k}`):
   the current word lights up yellow while upcoming words stay white —
   the viral animated-captions style. Font size scales with video height.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `10000` | Render sets it automatically |
| `PROCESSING_API_KEY` | no | — | Shared secret; must match Vercel's value. Unset = no auth |
| `GROQ_API_KEY` | for transcribe | — | Free key from https://console.groq.com/keys (no card) |
| `GROQ_MODEL` | no | `whisper-large-v3-turbo` | |
| `MAX_UPLOAD_MB` | no | `500` | Multipart upload cap |
| `MAX_DOWNLOAD_MB` | no | `500` | `sourceUrl` download cap |
| `MAX_CLIP_SECONDS` | no | `300` | Max clip length |
| `PROBE_TIMEOUT_MS` | no | `60000` | |
| `THUMBNAIL_TIMEOUT_MS` | no | `120000` | |
| `RENDER_TIMEOUT_MS` | no | `600000` | |
| `TRANSCRIBE_TIMEOUT_MS` | no | `300000` | |
| `DOWNLOAD_TIMEOUT_MS` | no | `120000` | |

Copy `.env.example` to `.env` for local dev. Never commit a real `.env`.

## Local development

```bash
npm install
npm run build
npm start          # or: npm run dev (watch mode, needs tsx)
curl http://localhost:10000/health
```

Requires Node 20+ and system `ffmpeg` + `ffprobe` in `PATH`.

## Deploy on Render (free tier)

1. **Push this folder to a GitHub repo** (public or private — Render
   connects via GitHub; private repos work on the free tier).
2. **Create the Groq key** (free, no card): https://console.groq.com/keys
   → create an API key and copy it.
3. **Render Dashboard → New → Blueprint** → select the repo.
   Render reads `render.yaml` and creates the `clipmaster-processor`
   web service (Docker, free plan, region Virginia, health check
   `/health`). When prompted, paste:
   - `GROQ_API_KEY` — the key from step 2.
   - `PROCESSING_API_KEY` — pick a random secret (or leave empty to
     run without auth). **Use the same value in Vercel** (next step).
4. Wait for the first deploy (~3–5 min: Docker build + ffmpeg install).
   Verify: `curl https://clipmaster-processor.onrender.com/health`
   should return `{"ok":true,"status":"ok",...}`.
5. **Connect the app:** in Vercel (project `clipmaster-ai`), set
   `VIDEO_PROCESSING_BACKEND_URL=https://clipmaster-processor.onrender.com`
   (production + preview + development) and, if you set a secret,
   `PROCESSING_API_KEY` with the **same** value. Redeploy to production.
6. Verify from the app: `GET https://clipmaster-ai-eight.vercel.app/api/workspace`
   should now show `externalProcessorConfigured: true`.

Notes:
- Free services sleep after 15 min idle; the first request after sleep
  takes ~1 min to wake. The app should tolerate that (or warm up with
  a `/health` call before processing).
- Free tier = 750 instance-hours/month, 5 GB/month bandwidth, 512 MB RAM.
  Renders are serialized (one at a time) to fit 0.1 CPU.
- If the deploy fails on the health check, check the Render logs:
  a 503 from `/health` means ffmpeg/ffprobe are missing from the image.

## Contract status

The exact request/response JSON the app expects is defined in the app's
`server/media.ts` and is still being read. All shape mapping lives in
**`src/adapter.ts`** — aliases are accepted for every field, so minor
differences (e.g. `startTime` vs `start`, `url` vs `sourceUrl`) are
already handled. If the real contract differs (different field names,
different response keys, or a different return type for thumbnails /
clips), adjust **only `src/adapter.ts`** and redeploy.

## Known limitations

- Groq caps each audio upload at 25 MB. Audio is extracted at 16 kHz
  mono 32 kbps (~14 MB/hour), so videos up to ~1.5 h usually fit;
  longer videos return a clear 413 error (audio chunking is not
  implemented yet).
- Clips are capped at 300 s by default (`MAX_CLIP_SECONDS`).
- 4K/long renders on the free tier may be slow or run out of memory;
  for production use, a paid Render instance is recommended.
- Temp files live in the container's ephemeral `/tmp` and are deleted
  after each request; nothing is persisted on this service.
