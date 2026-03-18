'use strict';
const express    = require('express');
const expressWs  = require('express-ws');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors       = require('cors');
const multer     = require('multer');
const upload     = multer({ dest: '/tmp/cookies/' });

const app = express();
expressWs(app);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/content/downloads';
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync('/tmp/cookies', { recursive: true });

const jobs = {};
const wsClients = {};

function broadcast(jobId, msg) {
  const set = wsClients[jobId];
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) { try { ws.send(data); } catch (_) {} }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
app.ws('/ws/:jobId', (ws, req) => {
  const { jobId } = req.params;
  if (!wsClients[jobId]) wsClients[jobId] = new Set();
  wsClients[jobId].add(ws);
  if (jobs[jobId]) ws.send(JSON.stringify({ type: 'status', job: sanitizeJob(jobs[jobId]) }));
  ws.on('close', () => { if (wsClients[jobId]) wsClients[jobId].delete(ws); });
});

function sanitizeJob(j) {
  const { pid, ...rest } = j;
  return rest;
}

// ── GET /api/info ──────────────────────────────────────────────────────────
// Returns full metadata: formats, subtitles, audio tracks, thumbnails
app.get('/api/info', (req, res) => {
  const { url, cookiefile } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const args = ['--dump-json', '--no-playlist', '--no-warnings'];
  if (cookiefile && fs.existsSync(cookiefile)) args.push('--cookies', cookiefile);
  args.push(url);

  let out = '';
  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.on('close', code => {
    if (code !== 0) return res.status(400).json({ error: 'Could not fetch info. Check URL or try with cookies.' });
    try {
      const lines = out.trim().split('\n').filter(Boolean);
      const raw = JSON.parse(lines[lines.length - 1]);

      // Parse available video formats grouped by resolution
      const formatMap = {};
      const audioFormats = [];
      const seen = new Set();

      (raw.formats || []).forEach(f => {
        const vcodec = f.vcodec || 'none';
        const acodec = f.acodec || 'none';
        const isVideoOnly = vcodec !== 'none' && acodec === 'none';
        const isAudioOnly = vcodec === 'none' && acodec !== 'none';
        const isCombined = vcodec !== 'none' && acodec !== 'none';

        if (isAudioOnly) {
          audioFormats.push({
            format_id: f.format_id,
            ext: f.ext,
            acodec: acodec,
            abr: f.abr || 0,
            asr: f.asr || 0,
            filesize: f.filesize || f.filesize_approx || 0,
            language: f.language || null,
            note: f.format_note || ''
          });
        }

        if (isVideoOnly || isCombined) {
          const h = f.height || 0;
          const key = `${h}`;
          if (!formatMap[key]) formatMap[key] = { height: h, codecs: [] };
          const codec = normalizeCodec(vcodec);
          const ck = `${key}-${codec}`;
          if (!seen.has(ck)) {
            seen.add(ck);
            formatMap[key].codecs.push({
              format_id: f.format_id,
              codec: codec,
              vcodec: vcodec,
              ext: f.ext,
              fps: f.fps || 0,
              filesize: f.filesize || f.filesize_approx || 0,
              tbr: f.tbr || 0,
              hdr: (f.dynamic_range && f.dynamic_range !== 'SDR') ? f.dynamic_range : null
            });
          }
        }
      });

      // Sort resolutions descending
      const resolutions = Object.values(formatMap)
        .sort((a, b) => b.height - a.height)
        .map(r => ({
          ...r,
          codecs: r.codecs.sort((a, b) => b.tbr - a.tbr)
        }));

      // Parse subtitles
      const allSubs = {};
      const addSubs = (src, auto) => {
        Object.entries(src || {}).forEach(([lang, tracks]) => {
          if (!allSubs[lang]) allSubs[lang] = { lang, auto, formats: [] };
          (tracks || []).forEach(t => {
            if (!allSubs[lang].formats.includes(t.ext)) allSubs[lang].formats.push(t.ext);
          });
        });
      };
      addSubs(raw.subtitles, false);
      addSubs(raw.automatic_captions, true);

      // Thumbnails
      const thumbnails = (raw.thumbnails || [])
        .filter(t => t.url)
        .slice(-5)
        .map(t => ({ url: t.url, width: t.width || 0, height: t.height || 0, id: t.id }));

      res.json({
        id: raw.id,
        title: raw.title,
        uploader: raw.uploader,
        upload_date: raw.upload_date,
        duration: raw.duration,
        view_count: raw.view_count,
        like_count: raw.like_count,
        description: (raw.description || '').slice(0, 300),
        thumbnail: raw.thumbnail,
        webpage_url: raw.webpage_url,
        resolutions,
        audioFormats: audioFormats.sort((a, b) => b.abr - a.abr),
        subtitles: Object.values(allSubs).sort((a, b) => a.lang.localeCompare(b.lang)),
        thumbnails,
        chapters: raw.chapters || [],
        is_live: raw.is_live || false,
        extractor: raw.extractor
      });
    } catch (e) {
      res.status(500).json({ error: 'Parse error: ' + e.message });
    }
  });
});

function normalizeCodec(str) {
  if (!str || str === 'none') return 'unknown';
  const s = str.toLowerCase();
  if (s.startsWith('av01') || s.startsWith('av1')) return 'AV1';
  if (s.startsWith('vp9') || s.startsWith('vp09')) return 'VP9';
  if (s.startsWith('vp8') || s.startsWith('vp08')) return 'VP8';
  if (s.startsWith('avc') || s.startsWith('h264') || s.includes('264')) return 'H.264';
  if (s.startsWith('hvc') || s.startsWith('hevc') || s.includes('265')) return 'H.265';
  if (s.startsWith('hdr')) return 'HDR';
  return str.split('.')[0].toUpperCase();
}

// ── POST /api/download ─────────────────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const {
    url,
    mode,           // 'video' | 'audio' | 'silent' | 'mkv_multi'
    formatId,       // specific format_id for video stream
    audioFormatId,  // specific format_id for audio stream
    audioFormat,    // output audio codec (mp3, m4a, etc.)
    container,      // mp4 | mkv | webm | avi
    subtitleLangs,  // [] array of lang codes to embed
    audioLangs,     // [] array of audio lang codes for mkv multi
    embedThumbnail,
    sponsorBlock,
    playlist,
    cookiefile,
    filenameTemplate,
    rateLimit,
    startTime,      // e.g. "00:01:30"
    endTime,        // e.g. "00:02:45"
    writeSubtitles, // boolean
    embedSubs,      // boolean
    chaptersAsFiles // boolean - split by chapters
  } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL' });

  const jobId = uuidv4();
  const tmpl = filenameTemplate || '%(title)s [%(id)s].%(ext)s';
  const outTemplate = path.join(DOWNLOAD_DIR, tmpl);

  const args = ['--newline', '--progress', '--no-warnings', '-o', outTemplate];

  // ── Mode-specific args ──────────────────────────────────────────────────
  if (mode === 'audio') {
    args.push('-x', '--audio-format', audioFormat || 'mp3', '--audio-quality', '0');
    if (audioFormatId) args.push('-f', audioFormatId);
  } else if (mode === 'silent') {
    // Video only, no audio
    if (formatId) {
      args.push('-f', formatId);
    } else {
      args.push('-f', 'bestvideo');
    }
    if (container) args.push('--merge-output-format', container);
  } else if (mode === 'mkv_multi') {
    // MKV with multiple selected audio + subtitle tracks
    let fmtStr = formatId || 'bestvideo';
    if (audioLangs && audioLangs.length > 0) {
      // Multiple audio: append each audio format
      const audioFmts = audioLangs.join('+');
      fmtStr = fmtStr + '+' + audioFmts;
    } else if (audioFormatId) {
      fmtStr = fmtStr + '+' + audioFormatId;
    } else {
      fmtStr = fmtStr + '+bestaudio';
    }
    args.push('-f', fmtStr);
    args.push('--merge-output-format', 'mkv');
    if (subtitleLangs && subtitleLangs.length > 0) {
      args.push('--write-subs', '--write-auto-subs');
      args.push('--sub-langs', subtitleLangs.join(','));
      args.push('--embed-subs');
    }
  } else {
    // Standard video download
    if (formatId && audioFormatId) {
      args.push('-f', `${formatId}+${audioFormatId}`);
    } else if (formatId) {
      args.push('-f', `${formatId}+bestaudio`);
    } else {
      args.push('-f', 'bestvideo+bestaudio/best');
    }
    if (container && container !== 'auto') args.push('--merge-output-format', container);
  }

  // ── Common options ──────────────────────────────────────────────────────
  if (!playlist) args.push('--no-playlist');
  if (cookiefile && fs.existsSync(cookiefile)) args.push('--cookies', cookiefile);
  if (rateLimit) args.push('-r', rateLimit);
  if (embedThumbnail) args.push('--embed-thumbnail');
  if (sponsorBlock) args.push('--sponsorblock-remove', 'all');
  if (chaptersAsFiles) args.push('--split-chapters');

  // Subtitles (non-mkv_multi mode)
  if (mode !== 'mkv_multi') {
    if (writeSubtitles && subtitleLangs && subtitleLangs.length > 0) {
      args.push('--write-subs', '--write-auto-subs');
      args.push('--sub-langs', subtitleLangs.join(','));
      if (embedSubs) args.push('--embed-subs');
    }
  }

  // Time range (clip)
  if (startTime || endTime) {
    const st = startTime || '0';
    const et = endTime || 'inf';
    args.push('--download-sections', `*${st}-${et}`);
    args.push('--force-keyframes-at-cuts');
  }

  args.push('--ffmpeg-location', '/usr/bin/ffmpeg');
  args.push(url);

  const job = {
    id: jobId, url, status: 'running',
    progress: 0, speed: '', eta: '', filename: '',
    log: [], args: args.join(' '), mode,
    startTime: Date.now()
  };
  jobs[jobId] = job;
  res.json({ jobId });

  const proc = spawn('yt-dlp', args);
  job.pid = proc.pid;

  const handleLine = line => {
    if (!line.trim()) return;
    job.log.push(line);
    if (job.log.length > 500) job.log.shift();
    const m = line.match(/\[download\]\s+([\d.]+)%.*?([\d.]+\s*\w+\/s).*?ETA\s+([\d:]+)/);
    if (m) { job.progress = parseFloat(m[1]); job.speed = m[2]; job.eta = m[3]; }
    const dest = line.match(/Destination:\s+(.+)/);
    if (dest) job.filename = path.basename(dest[1].trim());
    const merged = line.match(/Merging formats into "(.+)"/);
    if (merged) job.filename = path.basename(merged[1].trim());
    broadcast(jobId, { type: 'log', line, progress: job.progress, speed: job.speed, eta: job.eta });
  };

  proc.stdout.on('data', d => d.toString().split('\n').forEach(handleLine));
  proc.stderr.on('data', d => d.toString().split('\n').forEach(l => {
    if (!l.trim()) return;
    const el = '[ERR] ' + l;
    job.log.push(el);
    if (job.log.length > 500) job.log.shift();
    broadcast(jobId, { type: 'log', line: el, progress: job.progress });
  }));
  proc.on('close', code => {
    job.status = code === 0 ? 'done' : 'error';
    if (code === 0) job.progress = 100;
    job.endTime = Date.now();
    broadcast(jobId, { type: 'done', status: job.status, filename: job.filename });
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  try { process.kill(job.pid, 'SIGTERM'); } catch (_) {}
  job.status = 'cancelled';
  broadcast(req.params.jobId, { type: 'done', status: 'cancelled' });
  res.json({ ok: true });
});

// ── Jobs list ─────────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs).map(sanitizeJob).reverse());
});

// ── Files list ────────────────────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(DOWNLOAD_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ files, dir: DOWNLOAD_DIR });
  } catch (e) {
    res.json({ files: [], dir: DOWNLOAD_DIR });
  }
});

// ── Download file to browser ──────────────────────────────────────────────
app.get('/api/file/:filename', (req, res) => {
  const fpath = path.join(DOWNLOAD_DIR, req.params.filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Not found' });
  res.download(fpath);
});

// ── Delete file ───────────────────────────────────────────────────────────
app.delete('/api/file/:filename', (req, res) => {
  const fpath = path.join(DOWNLOAD_DIR, req.params.filename);
  try { fs.unlinkSync(fpath); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cookie upload ─────────────────────────────────────────────────────────
app.post('/api/cookies', upload.single('cookiefile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ path: req.file.path, name: req.file.originalname });
});

// ── Sites count ───────────────────────────────────────────────────────────
app.get('/api/sites-count', (req, res) => {
  const proc = spawn('yt-dlp', ['--list-extractors']);
  let count = 0;
  proc.stdout.on('data', d => { count += d.toString().split('\n').filter(Boolean).length; });
  proc.on('close', () => res.json({ count }));
});

// ── Version info ──────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  const proc = spawn('yt-dlp', ['--version']);
  let v = '';
  proc.stdout.on('data', d => { v += d.toString(); });
  proc.on('close', () => res.json({ version: v.trim() }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('yt-dlp WebUI v2 running on port ' + PORT));
