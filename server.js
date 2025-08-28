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
          try {
            const folderPath = path.join(MOVIES_DIR, folder.name);
            const movieFiles = fs.readdirSync(folderPath, { withFileTypes: true })
              .filter(e => e.isFile())
              .filter(e => SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
              .map(f => {
                try {
                  const filePath = path.join(folderPath, f.name);
                  const stats = fs.statSync(filePath);
                  return {
                    name: path.parse(f.name).name,
                    path: filePath,
                    extension: path.extname(f.name),
                    size: stats.size
                  };
                } catch (fileError) {
                  console.warn(`Error reading file ${f.name}:`, fileError);
                  return null;
                }
              })
              .filter(f => f !== null); // Remove any failed files
            
            if (movieFiles.length === 0) {
              return null; // Skip folders with no valid movie files
            }
            
            return {
              id: folder.name,
              name: folder.name,
              folder: folderPath,
              movies: movieFiles,
              hlsPath: path.join(folderPath, 'hls'),
              createdAt: fs.statSync(folderPath).birthtime
            };
          } catch (folderError) {
            console.warn(`Error reading folder ${folder.name}:`, folderError);
            return null;
          }
        })
        .filter(movie => movie !== null); // Remove any failed folders
      
      MOVIES = movieFolders;
      console.log(`Found ${MOVIES.length} movie folders:`, MOVIES.map(m => `${m.name} (${m.movies.length} movies)`));
    } else {
      console.warn(`Movies directory not found at ${MOVIES_DIR}`);
      // Create movies directory if it doesn't exist
      try {
        fs.mkdirSync(MOVIES_DIR, { recursive: true });
        console.log('Created movies directory');
        MOVIES = []; // Initialize empty movies array
      } catch (e) {
        console.error('Failed to create movies directory:', e);
        MOVIES = []; // Initialize empty movies array even if creation fails
      }
    }
  } catch (e) {
    console.warn(`Error reading movies directory:`, e);
    MOVIES = []; // Initialize empty movies array on any error
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

// Test endpoint for debugging
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Server is working',
    timestamp: new Date().toISOString(),
    moviesCount: MOVIES.length,
    moviesDir: MOVIES_DIR,
    moviesDirExists: fs.existsSync(MOVIES_DIR)
  });
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

// Download status tracking
let activeDownloads = new Map();

// Download movie endpoint using curl command
app.post('/api/download', requireToken, async (req, res) => {
  console.log('Download endpoint called with:', { 
    body: req.body, 
    headers: req.headers,
    url: req.url 
  });
  
  try {
    const { downloadUrl, title } = req.body;
    
    if (!downloadUrl || !title) {
      console.log('Missing required fields:', { downloadUrl: !!downloadUrl, title: !!title });
      return res.status(400).json({ error: 'Download URL and title are required' });
    }
    
    console.log('Processing download request:', { title, downloadUrl });
    
    // Sanitize title for folder name
    const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '_').trim();
    const movieFolder = path.join(MOVIES_DIR, sanitizedTitle);
    
    console.log('Sanitized title and paths:', { 
      originalTitle: title, 
      sanitizedTitle, 
      movieFolder,
      moviesDir: MOVIES_DIR 
    });
    
    // Ensure movies directory exists
    if (!fs.existsSync(MOVIES_DIR)) {
      console.log('Creating movies directory:', MOVIES_DIR);
      fs.mkdirSync(MOVIES_DIR, { recursive: true });
      console.log('Movies directory created successfully');
    }
    
    // Create movie folder
    if (!fs.existsSync(movieFolder)) {
      console.log('Creating movie folder:', movieFolder);
      fs.mkdirSync(movieFolder, { recursive: true });
      console.log('Movie folder created successfully');
    }
    
    // Determine file extension from URL
    const urlPath = url.parse(downloadUrl).pathname;
    const extension = path.extname(urlPath) || '.mp4';
    const fileName = `movie${extension}`;
    const filePath = path.join(movieFolder, fileName);
    
    console.log('File details:', { 
      urlPath, 
      extension, 
      fileName, 
      filePath 
    });
    
    // Use curl command for download
    console.log(`Starting curl download: ${title} from ${downloadUrl}`);
    
    const downloadId = `${sanitizedTitle}_${Date.now()}`;
    const downloadInfo = {
      id: downloadId,
      title: title,
      status: 'starting',
      progress: 0,
      startTime: new Date(),
      filePath: filePath,
      url: downloadUrl
    };
    
    activeDownloads.set(downloadId, downloadInfo);
    
    // Start download in background and respond immediately
    downloadWithCurl(downloadId, downloadUrl, filePath, title, sanitizedTitle);
    
    res.json({ 
      success: true, 
      message: `Download started for "${title}"`,
      downloadId: downloadId,
      status: 'started'
    });
    
  } catch (error) {
    console.error(`Download setup failed with error:`, error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Download setup failed', 
      details: error.message
    });
  }
});
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/app' // Ensure we're in the right directory
      });
      
      let stdout = '';
      let stderr = '';
      
      curlProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log('Curl stdout:', data.toString().trim());
      });
      
      curlProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('Curl stderr:', data.toString().trim());
      });
      
      curlProcess.on('close', (code) => {
        console.log(`Curl process exited with code ${code}`);
        if (code === 0) {
          console.log(`Download completed: ${title}`);
          resolve(filePath);
        } else {
          reject(new Error(`Curl failed with code ${code}. Stderr: ${stderr}`));
        }
      });
      
      curlProcess.on('error', (err) => {
        console.error('Failed to start curl process:', err);
        reject(err);
      });
      
      // Set timeout for curl process
      setTimeout(() => {
        if (!curlProcess.killed) {
          console.log('Curl process timeout, killing process');
          curlProcess.kill('SIGKILL');
          reject(new Error('Download timeout'));
        }
      }, 1800000); // 30 minutes timeout
    });
    
    // Wait for download to complete
    console.log('Waiting for curl download to complete...');
    await downloadPromise;
    console.log('Curl download promise resolved');
    
    // Verify file was downloaded
    if (!fs.existsSync(filePath)) {
      throw new Error('File was not downloaded successfully');
    }
    
    const fileStats = fs.statSync(filePath);
    console.log(`File downloaded successfully: ${filePath} (${fileStats.size} bytes)`);
    
    // Update download status
    downloadInfo.status = 'completed';
    downloadInfo.progress = 100;
    downloadInfo.completionTime = new Date();
    downloadInfo.fileSize = fileStats.size;
    activeDownloads.set(downloadId, downloadInfo);
    
    // Rescan movies to include the new one
    console.log('Rescanning movies...');
    scanMovies();
    console.log('Movies rescanned');
    
    // Generate HLS for the new movie
    const newMovie = MOVIES.find(m => m.id === sanitizedTitle);
    console.log('Looking for new movie:', { 
      sanitizedTitle, 
      found: !!newMovie, 
      moviesCount: MOVIES.length 
    });
    
    if (newMovie && newMovie.movies.length > 0) {
      console.log('Starting HLS generation for new movie');
      generateHls(newMovie, newMovie.movies[0]);
    } else {
      console.log('No new movie found or no movie files');
    }
    
    console.log('Download process completed successfully');
    
  } catch (error) {
    console.error(`Download failed with error:`, error);
    console.error('Error stack:', error.stack);
    
    // Update download status
    const downloadInfo = activeDownloads.get(downloadId);
    if (downloadInfo) {
      downloadInfo.status = 'failed';
      downloadInfo.error = error.message;
      downloadInfo.completionTime = new Date();
      activeDownloads.set(downloadId, downloadInfo);
    }
    
    // Clean up partial download
    try {
      if (fs.existsSync(filePath)) {
        console.log('Cleaning up partial download file:', filePath);
        fs.unlinkSync(filePath);
        console.log('Cleanup completed');
      }
    } catch (cleanupError) {
      console.error('Failed to cleanup partial download:', cleanupError);
    }
  }
}

// Get download status
app.get('/api/download/:downloadId/status', requireToken, (req, res) => {
  const { downloadId } = req.params;
  const downloadInfo = activeDownloads.get(downloadId);
  
  if (!downloadInfo) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  res.json(downloadInfo);
});

// Get all active downloads
app.get('/api/downloads', requireToken, (req, res) => {
  const downloads = Array.from(activeDownloads.values());
  res.json(downloads);
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


