const path = require('path');
const fs = require('fs');
const express = require('express');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const url = require('url');

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

// Middleware for parsing JSON
app.use(express.json({ limit: '10mb' }));

// Serve static client files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Auto-detect movies in the ./movies directory
const MOVIES_DIR = path.join(__dirname, 'movies');
const SUPPORTED_EXTENSIONS = new Set(['.mkv', '.mp4', '.webm', '.mov']);
let MOVIES = [];

// Function to scan and update movies list
function scanMovies() {
  try {
    if (fs.existsSync(MOVIES_DIR)) {
      const movieFolders = fs.readdirSync(MOVIES_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(folder => {
          const folderPath = path.join(MOVIES_DIR, folder.name);
          const movieFiles = fs.readdirSync(folderPath, { withFileTypes: true })
            .filter(e => e.isFile())
            .filter(e => SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
            .map(f => ({
              name: path.parse(f.name).name,
              path: path.join(folderPath, f.name),
              extension: path.extname(f.name),
              size: fs.statSync(path.join(folderPath, f.name)).size
            }));
          
          return {
            id: folder.name,
            name: folder.name,
            folder: folderPath,
            movies: movieFiles,
            hlsPath: path.join(folderPath, 'hls'),
            createdAt: fs.statSync(folderPath).birthtime
          };
        })
        .filter(movie => movie.movies.length > 0);
      
      MOVIES = movieFolders;
      console.log(`Found ${MOVIES.length} movie folders:`, MOVIES.map(m => `${m.name} (${m.movies.length} movies)`));
    } else {
      console.warn(`Movies directory not found at ${MOVIES_DIR}`);
      // Create movies directory if it doesn't exist
      try {
        fs.mkdirSync(MOVIES_DIR, { recursive: true });
        console.log('Created movies directory');
      } catch (e) {
        console.error('Failed to create movies directory:', e);
      }
    }
  } catch (e) {
    console.warn(`Error reading movies directory:`, e);
  }
}

// Initial scan
scanMovies();

// Serve HLS files for each movie
MOVIES.forEach(movie => {
  app.use(`/hls/${movie.id}`, requireToken, express.static(movie.hlsPath, {
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
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/movies', (req, res) => {
  // Rescan movies before returning list
  scanMovies();
  res.json(MOVIES.map(movie => ({
    id: movie.id,
    name: movie.name,
    movies: movie.movies.map(m => ({
      name: m.name,
      extension: m.extension,
      size: m.size
    })),
    createdAt: movie.createdAt,
    hasHls: fs.existsSync(movie.hlsPath) && fs.existsSync(path.join(movie.hlsPath, 'stream.m3u8'))
  })));
});

// Download movie endpoint
app.post('/api/download', requireToken, async (req, res) => {
  const { downloadUrl, title } = req.body;
  
  if (!downloadUrl || !title) {
    return res.status(400).json({ error: 'Download URL and title are required' });
  }
  
  // Sanitize title for folder name
  const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '_').trim();
  const movieFolder = path.join(MOVIES_DIR, sanitizedTitle);
  
  try {
    // Create movie folder
    if (!fs.existsSync(movieFolder)) {
      fs.mkdirSync(movieFolder, { recursive: true });
    }
    
    // Determine file extension from URL
    const urlPath = url.parse(downloadUrl).pathname;
    const extension = path.extname(urlPath) || '.mp4';
    const fileName = `movie${extension}`;
    const filePath = path.join(movieFolder, fileName);
    
    // Start download
    console.log(`Starting download: ${title} from ${downloadUrl}`);
    
    const downloadPromise = new Promise((resolve, reject) => {
      const protocol = downloadUrl.startsWith('https:') ? https : http;
      
      const request = protocol.get(downloadUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }
        
        const fileStream = fs.createWriteStream(filePath);
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          // You could emit progress here if needed
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`Download completed: ${title}`);
          resolve(filePath);
        });
        
        fileStream.on('error', (err) => {
          fs.unlink(filePath, () => {}); // Delete partial file
          reject(err);
        });
      });
      
      request.on('error', (err) => {
        reject(err);
      });
      
      request.setTimeout(300000, () => { // 5 minute timeout
        request.destroy();
        reject(new Error('Download timeout'));
      });
    });
    
    // Wait for download to complete
    await downloadPromise;
    
    // Rescan movies to include the new one
    scanMovies();
    
    // Generate HLS for the new movie
    const newMovie = MOVIES.find(m => m.id === sanitizedTitle);
    if (newMovie && newMovie.movies.length > 0) {
      generateHls(newMovie, newMovie.movies[0]);
    }
    
    res.json({ 
      success: true, 
      message: `Movie "${title}" downloaded successfully`,
      movieId: sanitizedTitle
    });
    
  } catch (error) {
    console.error(`Download failed for ${title}:`, error);
    
    // Clean up partial download
    try {
      if (fs.existsSync(movieFolder)) {
        fs.rmSync(movieFolder, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error('Failed to cleanup partial download:', cleanupError);
    }
    
    res.status(500).json({ 
      error: 'Download failed', 
      details: error.message 
    });
  }
});

// Delete movie endpoint
app.delete('/api/movies/:movieId', requireToken, (req, res) => {
  const { movieId } = req.params;
  const movie = MOVIES.find(m => m.id === movieId);
  
  if (!movie) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  
  try {
    // Remove the entire movie folder
    fs.rmSync(movie.folder, { recursive: true, force: true });
    console.log(`Deleted movie: ${movie.name}`);
    
    // Rescan movies
    scanMovies();
    
    res.json({ success: true, message: `Movie "${movie.name}" deleted successfully` });
  } catch (error) {
    console.error(`Failed to delete movie ${movie.name}:`, error);
    res.status(500).json({ error: 'Failed to delete movie', details: error.message });
  }
});

// Regenerate HLS for specific movie
app.post('/api/movies/:movieId/regenerate-hls', requireToken, (req, res) => {
  const { movieId } = req.params;
  const movie = MOVIES.find(m => m.id === movieId);
  
  if (!movie) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  
  if (movie.movies.length === 0) {
    return res.status(400).json({ error: 'No movie files found' });
  }
  
  // Force HLS regeneration
  generateHls(movie, movie.movies[0], true);
  
  res.json({ success: true, message: `HLS regeneration started for "${movie.name}"` });
});

// Optional auth: if ACCESS_TOKEN is set, require it for protected routes
function requireToken(req, res, next) {
  if (!ACCESS_TOKEN) {
    console.log('No ACCESS_TOKEN set, allowing request');
    return next();
  }
  
  const authHeader = req.get('authorization');
  const bearer = authHeader && authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : null;
  // Read token from query or Authorization header only
  const token = bearer || req.query.token;
  
  console.log(`Token validation: expected=${ACCESS_TOKEN}, received=${token}, path=${req.path}`);
  
  if (token === ACCESS_TOKEN) {
    console.log('Token validation successful');
    return next();
  }
  
  console.log('Token validation failed, sending 401');
  res.status(401).send('Unauthorized');
}

// Range-based streaming endpoint for specific movie
app.get('/video/:movieId/:movieName', requireToken, (req, res) => {
  const { movieId, movieName } = req.params;
  const movie = MOVIES.find(m => m.id === movieId);
  
  if (!movie) {
    return res.status(404).send('Movie not found');
  }
  
  const movieFile = movie.movies.find(m => m.name === movieName);
  if (!movieFile) {
    return res.status(404).send('Movie file not found');
  }
  
  fs.stat(movieFile.path, (err, stats) => {
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
      fs.createReadStream(movieFile.path).pipe(res);
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
    const file = fs.createReadStream(movieFile.path, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/x-matroska',
    });
    file.pipe(res);
  });
});

// HLS generation for all movies (non-blocking)
function generateHlsForAll() {
  MOVIES.forEach(movie => {
    if (movie.movies.length > 0) {
      // Generate HLS for the first movie in each folder
      const movieFile = movie.movies[0];
      generateHls(movie, movieFile);
    }
  });
}

// HLS generation for a specific movie
function generateHls(movie, movieFile, force = false) {
  const hlsDir = movie.hlsPath;
  const manifestPath = path.join(hlsDir, 'stream.m3u8');
  
  // Skip regeneration if manifest and at least one segment already exist (unless forced)
  if (!force) {
    try {
      const hasManifest = fs.existsSync(manifestPath);
      const hasAnySegment = fs.existsSync(hlsDir) && (fs.readdirSync(hlsDir).some((n) => n.startsWith('seg_') && n.endsWith('.ts')));
      if (hasManifest && hasAnySegment) {
        console.log(`HLS already present for ${movie.name}; skipping regeneration.`);
        return;
      }
    } catch {}
  }
  
  try { 
    fs.mkdirSync(hlsDir, { recursive: true }); 
  } catch {}

  console.log(`Generating HLS for ${movie.name} (${movieFile.name})...`);
  if (!ffmpegExecutable) {
    console.warn('ffmpeg is not available. Skipping HLS generation.');
    return;
  }
  
  const args = [
    '-hide_banner', '-y',
    '-i', movieFile.path,
    // Select first video and audio tracks
    '-map', '0:v:0', '-map', '0:a:0?',
    // Copy video as-is (no re-encode), transcode audio to AAC for browser support
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    // HLS settings
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
    manifestPath
  ];

  const ffmpeg = spawn(ffmpegExecutable, args);
  
  ffmpeg.stdout.on('data', (data) => {
    console.log(`[${movie.name}] ${data.toString().trim()}`);
  });
  
  ffmpeg.stderr.on('data', (data) => {
    console.log(`[${movie.name}] ${data.toString().trim()}`);
  });
  
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      console.log(`HLS generation completed for ${movie.name}`);
    } else {
      console.error(`HLS generation failed for ${movie.name} with code ${code}`);
    }
  });
  
  ffmpeg.on('error', (err) => {
    console.error(`Failed to start ffmpeg for ${movie.name}:`, err);
  });
}

// Start server
app.listen(PORT, HOST, () => {
  const lan = getLanIPv4();
  console.log(`Server listening on http://localhost:${PORT}`);
  if (lan) {
    console.log(`LAN access:        http://${lan}:${PORT}`);
  }
  
  // Generate HLS for all movies
  if (MOVIES.length > 0) {
    generateHlsForAll();
  } else {
    console.log('No movies found. Create folders in ./movies/ with movie files or use the download interface.');
  }
});

// Helper function to get LAN IP
function getLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}


