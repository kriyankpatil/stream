const path = require('path');
const fs = require('fs');
const express = require('express');
const os = require('os');
const { spawn } = require('child_process');

// Use system-installed ffmpeg (installed via apt in Dockerfile)
let ffmpegExecutable = process.env.FFMPEG_PATH || 'ffmpeg';

// Verify ffmpeg is available
try {
  const { execSync } = require('child_process');
  execSync(`${ffmpegExecutable} -version`, { stdio: 'ignore' });
  console.log(`Using ffmpeg: ${ffmpegExecutable}`);
} catch (error) {
  console.error(`FFmpeg not found at ${ffmpegExecutable}. Please ensure ffmpeg is installed.`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const FORCE_HLS = process.env.FORCE_HLS === '1';

// Serve static client files from /public
app.use(express.static(path.join(__dirname, 'public')));
// Serve generated HLS assets
app.use('/hls', requireToken, express.static(path.join(__dirname, 'hls'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=60');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.mp4') || filePath.endsWith('.m4s')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Auto-detect the first video file in the ./movie directory
const MOVIE_DIR = path.join(__dirname, 'movie');
const SUPPORTED_EXTENSIONS = new Set(['.mkv', '.mp4', '.webm', '.mov']);
let MOVIE_FILE = null;

try {
  const entries = fs.readdirSync(MOVIE_DIR, { withFileTypes: true });
  const candidate = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .find((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()));
  if (candidate) {
    MOVIE_FILE = path.join(MOVIE_DIR, candidate);
    console.log(`Detected movie file: ${MOVIE_FILE}`);
  } else {
    console.warn(`No supported video files found in ${MOVIE_DIR}`);
  }
} catch (e) {
  console.warn(`Movie directory not found at ${MOVIE_DIR}`);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Optional auth: if ACCESS_TOKEN is set, require it for protected routes
function requireToken(req, res, next) {
  if (!ACCESS_TOKEN) return next();
  const authHeader = req.get('authorization');
  const bearer = authHeader && authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : null;
  // Read token from query or Authorization header only
  const token = bearer || req.query.token;
  if (token === ACCESS_TOKEN) return next();
  res.status(401).send('Unauthorized');
}

// Range-based streaming endpoint
app.get('/video', requireToken, (req, res) => {
  if (!MOVIE_FILE) {
    return res.status(404).send('No video available');
  }
  fs.stat(MOVIE_FILE, (err, stats) => {
    if (err) {
      console.error('Failed to read video file stats:', err);
      return res.status(404).send('Video not found');
    }

    const fileSize = stats.size;
    const range = req.headers.range;

    if (!range) {
      // No range header; stream entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/x-matroska',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(MOVIE_FILE).pipe(res);
      return;
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
      res.status(416).set({
        'Content-Range': `bytes */${fileSize}`,
      }).end();
      return;
    }

    const chunkSize = end - start + 1;
    const file = fs.createReadStream(MOVIE_FILE, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/x-matroska',
    });
    file.pipe(res);
  });
});

// HLS generation (non-blocking) using system ffmpeg inside Docker or host
function generateHls() {
  const hlsDir = path.join(__dirname, 'hls');
  const manifestPath = path.join(hlsDir, 'stream.m3u8');
  if (!MOVIE_FILE) {
    console.warn('No movie file found for HLS generation');
    return;
  }
  // Skip regeneration if manifest and at least one segment already exist (unless FORCE_HLS=1)
  try {
    const hasManifest = fs.existsSync(manifestPath);
    const hasAnySegment = fs.existsSync(hlsDir) && (fs.readdirSync(hlsDir).some((n) => n.startsWith('seg_') && n.endsWith('.ts')));
    if (!FORCE_HLS && hasManifest && hasAnySegment) {
      console.log('HLS already present; skipping regeneration. Set FORCE_HLS=1 to rebuild.');
      return;
    }
  } catch {}
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch {}

  console.log('Generating HLS (may take several minutes)...');
  if (!ffmpegExecutable) {
    console.warn('ffmpeg is not available. Skipping HLS generation.');
    return;
  }
  const args = [
    '-hide_banner', '-y',
    '-i', MOVIE_FILE,
    // Select first video and audio tracks
    '-map', '0:v:0', '-map', '0:a:0?',
    // Copy video as-is (no re-encode), transcode audio to AAC for browser support
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    // More resilient segmenting
    '-movflags', '+faststart',
    '-hls_time', '6',
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
    manifestPath
  ];
  const proc = spawn(ffmpegExecutable, args, { stdio: 'inherit' });
  proc.on('error', (err) => {
    console.warn('Failed to start ffmpeg for HLS generation:', err.message);
  });
  proc.on('exit', (code) => {
    if (code === 0) console.log('HLS generation complete.');
    else console.warn(`FFmpeg exited with code ${code}. HLS may be unavailable.`);
  });
}

// Protected endpoint to trigger HLS regeneration on demand
app.post('/api/admin/regenerate-hls', requireToken, (req, res) => {
  generateHls();
  res.json({ started: true });
});

function getLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

app.listen(PORT, HOST, () => {
  const lan = getLanIPv4();
  console.log(`Server listening on http://localhost:${PORT}`);
  if (lan) {
    console.log(`LAN access:        http://${lan}:${PORT}`);
  }
  
  // Check if HLS files already exist before generating
  const hlsDir = path.join(__dirname, 'hls');
  const hlsManifest = path.join(hlsDir, 'stream.m3u8');
  const hlsExists = fs.existsSync(hlsManifest) && fs.existsSync(hlsDir);

  if (hlsExists && !FORCE_HLS) {
    console.log('HLS already present; skipping regeneration. Set FORCE_HLS=1 to rebuild.');
  } else {
    // Kick off HLS generation in background
    generateHls();
  }
});


