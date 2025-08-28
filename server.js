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

// Verify fast download tools are available
const downloadTools = [
  { name: 'aria2c', command: 'aria2c --version' },
  { name: 'wget', command: 'wget --version' },
  { name: 'curl', command: 'curl --version' }
];

console.log('Checking download tools availability:');
downloadTools.forEach(tool => {
  try {
    execSync(tool.command, { stdio: 'ignore' });
    console.log(`✅ ${tool.name} is available`);
  } catch (error) {
    console.warn(`⚠️ ${tool.name} not found - some download methods may not work`);
  }
});

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

// Download movie endpoint
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
      try {
        fs.mkdirSync(MOVIES_DIR, { recursive: true, mode: 0o777 });
        console.log('Movies directory created successfully');
      } catch (mkdirError) {
        console.error('Failed to create movies directory:', mkdirError);
        // Try to create with different permissions
        try {
          fs.mkdirSync(MOVIES_DIR, { recursive: true, mode: 0o777 });
          console.log('Movies directory created with full permissions');
        } catch (retryError) {
          console.error('Failed to create movies directory even with full permissions:', retryError);
          throw new Error(`Cannot create movies directory: ${retryError.message}`);
        }
      }
    } else {
      // Ensure existing directory has proper permissions
      try {
        fs.accessSync(MOVIES_DIR, fs.constants.W_OK);
        console.log('Movies directory is writable');
      } catch (accessError) {
        console.log('Fixing movies directory permissions...');
        try {
          fs.chmodSync(MOVIES_DIR, 0o777);
          console.log('Movies directory permissions fixed');
        } catch (chmodError) {
          console.error('Failed to fix movies directory permissions:', chmodError);
          throw new Error(`Cannot write to movies directory: ${chmodError.message}`);
        }
      }
    }
    
    // Create movie folder
    if (!fs.existsSync(movieFolder)) {
      console.log('Creating movie folder:', movieFolder);
      try {
        fs.mkdirSync(movieFolder, { recursive: true, mode: 0o777 });
        console.log('Movie folder created successfully');
      } catch (mkdirError) {
        console.error('Failed to create movie folder:', mkdirError);
        // Try to create with different permissions
        try {
          fs.mkdirSync(movieFolder, { recursive: true, mode: 0o777 });
          console.log('Movie folder created with full permissions');
        } catch (retryError) {
          console.error('Failed to create movie folder even with full permissions:', retryError);
          throw new Error(`Cannot create movie folder: ${retryError.message}`);
        }
      }
    } else {
      // Ensure existing folder has proper permissions
      try {
        fs.accessSync(movieFolder, fs.constants.W_OK);
        console.log('Movie folder is writable');
      } catch (accessError) {
        console.log('Fixing movie folder permissions...');
        try {
          fs.chmodSync(movieFolder, 0o777);
          console.log('Movie folder permissions fixed');
        } catch (chmodError) {
          console.error('Failed to fix movie folder permissions:', chmodError);
          throw new Error(`Cannot write to movie folder: ${chmodError.message}`);
        }
      }
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
    
    // Use aria2c command for download
    console.log(`Starting fast download for ${title} to ${filePath}`);
    
    const downloadId = `${sanitizedTitle}_${Date.now()}`;
    const downloadInfo = {
      id: downloadId,
      title: title,
      status: 'starting',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: 0,
      startTime: new Date(),
      filePath: filePath,
      url: downloadUrl
    };
    
    activeDownloads.set(downloadId, downloadInfo);
    
    // Start download in background and respond immediately
    downloadWithProgress(downloadId, downloadUrl, filePath, title, sanitizedTitle);
    
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

// Download with progress tracking
async function downloadWithProgress(downloadId, downloadUrl, filePath, title, sanitizedTitle) {
  try {
    const downloadInfo = activeDownloads.get(downloadId);
    if (!downloadInfo) return;
    
    downloadInfo.status = 'downloading';
    activeDownloads.set(downloadId, downloadInfo);
    
    console.log(`Starting download for ${downloadId}...`);
    
    // Use aria2c for fast downloads with progress
    const aria2cProcess = spawn('aria2c', [
      '--max-connection-per-server=16',
      '--min-split-size=1M',
      '--split=16',
      '--continue=true',
      '--max-download-limit=0',
      '--file-allocation=none',
      '--console-log-level=error',
      '--summary-interval=1',
      '--progress-bar=true',
      '-o', path.basename(filePath),
      '-d', path.dirname(filePath),
      downloadUrl
    ]);

    let lastProgress = 0;
    let lastTime = Date.now();
    let lastSize = 0;

    aria2cProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`aria2c output: ${output}`);
      
      // Parse progress from aria2c output
      const progressMatch = output.match(/(\d+)%\|/);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1]);
        downloadInfo.progress = progress;
        
        // Calculate speed and ETA
        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / 1000; // seconds
        
        if (timeDiff > 0) {
          const currentSize = (progress / 100) * (downloadInfo.total || 1000000000); // Estimate total size
          const sizeDiff = currentSize - lastSize;
          downloadInfo.speed = sizeDiff / timeDiff; // bytes per second
          downloadInfo.downloaded = currentSize;
          
          if (downloadInfo.speed > 0) {
            const remaining = (100 - progress) / 100 * (downloadInfo.total || 1000000000);
            downloadInfo.eta = remaining / downloadInfo.speed; // seconds
          }
          
          lastTime = currentTime;
          lastSize = currentSize;
        }
        
        console.log(`Progress: ${progress}%`);
      }
    });

    aria2cProcess.stderr.on('data', (data) => {
      const error = data.toString();
      console.error(`aria2c error: ${error}`);
      
      // Check for file size info
      const sizeMatch = error.match(/Total Size: (\d+)/);
      if (sizeMatch) {
        downloadInfo.total = parseInt(sizeMatch[1]);
        console.log(`Total file size: ${(downloadInfo.total / 1024 / 1024).toFixed(2)} MB`);
      }
    });

    aria2cProcess.on('close', async (code) => {
      console.log(`aria2c process exited with code ${code}`);
      
      if (code === 0) {
        // Download completed successfully
        downloadInfo.status = 'completed';
        downloadInfo.progress = 100;
        downloadInfo.downloaded = downloadInfo.total;
        downloadInfo.speed = 0;
        downloadInfo.eta = 0;
        
        console.log(`Download completed for ${downloadId}`);
        
        // Verify file exists and has content
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          if (stats.size > 0) {
            console.log(`File verified: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            
            // Generate HLS
            downloadInfo.status = 'generating_hls';
            try {
              await generateHlsForMovie(sanitizedTitle);
              downloadInfo.status = 'completed';
              console.log(`HLS generated for ${title}`);
            } catch (hlsError) {
              console.error(`HLS generation failed for ${title}:`, hlsError);
              downloadInfo.status = 'hls_failed';
              downloadInfo.error = `HLS generation failed: ${hlsError.message}`;
            }
          } else {
            console.error(`Download completed but file is empty: ${filePath}`);
            downloadInfo.status = 'failed';
            downloadInfo.error = 'Download completed but file is empty';
          }
        } else {
          console.error(`Download completed but file not found: ${filePath}`);
          downloadInfo.status = 'failed';
          downloadInfo.error = 'Download completed but file not found';
        }
      } else {
        // Download failed
        downloadInfo.status = 'failed';
        downloadInfo.error = `aria2c exited with code ${code}`;
        console.error(`Download failed for ${downloadId} with code ${code}`);
        
        // Clean up partial file
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up partial file: ${filePath}`);
          } catch (cleanupError) {
            console.error(`Failed to cleanup partial file:`, cleanupError);
          }
        }
      }
      
      // Update movies list
      await rescanMovies();
    });

    aria2cProcess.on('error', (error) => {
      console.error(`Failed to start aria2c:`, error);
      downloadInfo.status = 'failed';
      downloadInfo.error = `Failed to start aria2c: ${error.message}`;
    });

  } catch (error) {
    console.error(`Download error for ${downloadId}:`, error);
    downloadInfo.status = 'failed';
    downloadInfo.error = error.message;
  }
}

// Function to handle fast download using multiple methods
async function downloadWithFastMethod(downloadId, downloadUrl, filePath, title, sanitizedTitle) {
  try {
    const downloadInfo = activeDownloads.get(downloadId);
    if (!downloadInfo) return;
    
    downloadInfo.status = 'downloading';
    activeDownloads.set(downloadId, downloadInfo);
    
    console.log(`Starting fast download for ${title} to ${filePath}`);
    
    // Try multiple download methods in order of preference
    const downloadMethods = [
      { name: 'aria2c', command: 'aria2c', args: ['--max-connection-per-server=16', '--min-split-size=1M', '--split=16', '--continue=true', '--max-download-limit=0', '--file-allocation=none', '-o', path.basename(filePath), '-d', path.dirname(filePath), downloadUrl] },
      { name: 'wget', command: 'wget', args: ['--continue', '--tries=3', '--timeout=30', '--progress=bar', '-O', filePath, downloadUrl] },
      { name: 'curl', command: 'curl', args: ['-L', '-C', '-', '--connect-timeout', '30', '--max-time', '1800', '--retry', '3', '--retry-delay', '5', '-o', filePath, downloadUrl] }
    ];
    
    let downloadSuccess = false;
    let lastError = null;
    
    for (const method of downloadMethods) {
      try {
        console.log(`Trying download method: ${method.name}`);
        
        const downloadPromise = new Promise((resolve, reject) => {
          const downloadProcess = spawn(method.command, method.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: '/app'
          });
          
          let stdout = '';
          let stderr = '';
          
          downloadProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`${method.name} stdout:`, data.toString().trim());
          });
          
          downloadProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`${method.name} stderr:`, data.toString().trim());
          });
          
          downloadProcess.on('close', (code) => {
            console.log(`${method.name} process exited with code ${code}`);
            if (code === 0) {
              console.log(`Download completed with ${method.name}: ${title}`);
              resolve(filePath);
            } else {
              reject(new Error(`${method.name} failed with code ${code}. Stderr: ${stderr}`));
            }
          });
          
          downloadProcess.on('error', (err) => {
            console.error(`Failed to start ${method.name} process:`, err);
            reject(err);
          });
          
          // Set timeout for download process
          setTimeout(() => {
            if (!downloadProcess.killed) {
              console.log(`${method.name} process timeout, killing process`);
              downloadProcess.kill('SIGKILL');
              reject(new Error('Download timeout'));
            }
          }, 1800000); // 30 minutes timeout
        });
        
        // Wait for download to complete
        console.log(`Waiting for ${method.name} download to complete...`);
        await downloadPromise;
        console.log(`${method.name} download promise resolved`);
        
        downloadSuccess = true;
        break; // Exit loop on success
        
      } catch (error) {
        console.error(`${method.name} download failed:`, error);
        lastError = error;
        
        // Clean up partial file before trying next method
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up partial file from ${method.name}`);
          }
        } catch (cleanupError) {
          console.error('Failed to cleanup partial file:', cleanupError);
        }
        
        // Continue to next method
        continue;
      }
    }
    
    if (!downloadSuccess) {
      throw new Error(`All download methods failed. Last error: ${lastError?.message}`);
    }
    
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
  
  // Ensure all necessary directories exist with proper permissions
  try {
    console.log('Setting up directories with proper permissions...');
    
    // Create movies directory if it doesn't exist
    if (!fs.existsSync(MOVIES_DIR)) {
      console.log('Creating movies directory on startup:', MOVIES_DIR);
      fs.mkdirSync(MOVIES_DIR, { recursive: true, mode: 0o777 });
      console.log('Movies directory created successfully on startup');
    } else {
      // Ensure existing directory has proper permissions
      try {
        fs.accessSync(MOVIES_DIR, fs.constants.W_OK);
        console.log('Movies directory is writable');
      } catch (accessError) {
        console.log('Fixing movies directory permissions...');
        fs.chmodSync(MOVIES_DIR, 0o777);
        console.log('Movies directory permissions fixed');
      }
    }
    
    // Ensure public directory exists
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      console.log('Creating public directory on startup:', publicDir);
      fs.mkdirSync(publicDir, { recursive: true, mode: 0o777 });
      console.log('Public directory created successfully on startup');
    }
    
    // Test directory creation
    const testDir = path.join(MOVIES_DIR, 'test_permissions');
    try {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o777 });
      fs.rmdirSync(testDir);
      console.log('✅ Directory permissions test passed');
    } catch (testError) {
      console.error('❌ Directory permissions test failed:', testError);
      throw new Error('Cannot create directories - permission issue detected');
    }
    
    console.log('All necessary directories verified/created with proper permissions');
  } catch (dirError) {
    console.error('Failed to setup directories on startup:', dirError);
    console.error('Server may not work properly for downloads');
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


