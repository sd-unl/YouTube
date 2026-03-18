# yt-dlp Studio v2

A professional video downloader running on Google Colab with a skeuomorphic Web UI.

## Repository Structure

```
├── server/
│   ├── server.js       ← Node.js Express backend
│   └── package.json    ← Node dependencies
├── public/
│   └── index.html      ← Web UI (skeuomorphic red & white theme)
└── yt_dlp_studio_v2.ipynb  ← Google Colab notebook
```

## Quick Start

### Option A — GitHub (Recommended)
1. Fork / push this repo to your GitHub account
2. Open `yt_dlp_studio_v2.ipynb` in Google Colab
3. In Cell 1, set `GITHUB_REPO = 'https://github.com/YOUR_USER/YOUR_REPO'`
4. Run all cells → click the printed URL

### Option B — Upload ZIP
1. Upload `ytdlp-studio.zip` to Colab files panel
2. Run in a Colab cell:
   ```python
   !unzip ytdlp-studio.zip -d /tmp/ytdlp-src
   !mkdir -p /content/ytdlp-studio/public
   !cp /tmp/ytdlp-src/server/server.js /content/ytdlp-studio/
   !cp /tmp/ytdlp-src/server/package.json /content/ytdlp-studio/
   !cp /tmp/ytdlp-src/public/index.html /content/ytdlp-studio/public/
   ```
3. Then run Cells 2, 3, 5

## Features

| Feature | Details |
|---|---|
| Video download | Resolution picker, codec selector (AV1 / VP9 / H.264 / H.265) |
| Audio download | MP3, M4A, Opus, FLAC, WAV, AAC |
| Silent video | Video stream only, no audio |
| MKV multi-track | Embed multiple audio tracks + subtitles |
| Time clip | Download a specific time range with ffmpeg keyframe cuts |
| Subtitles | View available languages, select & embed |
| Audio tracks | View & select from separate audio streams |
| Thumbnails | Preview all available thumbnail resolutions |
| File download | One-click download to your local device |
| Google Drive | Optional output to MyDrive |
| Cookie support | Upload cookies.txt for private/age-restricted content |
| SponsorBlock | Auto-remove sponsor segments |
| Chapter split | Split video by chapters |
| Rate limit | Optional bandwidth cap |

## Dependencies

- Python: `yt-dlp`
- System: `ffmpeg`, `nodejs`, `npm`
- Node.js: `express`, `express-ws`, `multer`, `uuid`, `cors`

## Notes

- The Colab tunnel URL changes each session — re-run Cell 5 to get a new URL
- Downloads to Google Drive persist between sessions
- Local `/content/downloads` is wiped when the Colab runtime disconnects
