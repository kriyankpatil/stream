# Multi-Movie Streaming Server

A Node.js streaming server with HLS support for multiple movies, each organized in individual folders.

## Features

* **Multi-movie support** with individual folders for each movie
* HTTP Range streaming for direct video playback
* HLS (HTTP Live Streaming) generation with ffmpeg
* Token-based access control
* Docker support for easy deployment
* Auto-detection of movie folders in `movies/` directory
* Movie selection interface in the frontend

## Directory Structure

```
stream/
├── movies/                    # Main movies directory
│   ├── Movie1/               # Movie folder (use descriptive names)
│   │   ├── movie.mp4         # Movie file (any supported format)
│   │   └── hls/              # Auto-generated HLS files
│   │       ├── stream.m3u8   # HLS manifest
│   │       ├── seg_000.ts    # Video segments
│   │       └── ...
│   ├── Movie2/
│   │   ├── another_movie.mkv
│   │   └── hls/
│   └── ...
├── public/                    # Frontend files
├── server.js                  # Main server file
├── Dockerfile                 # Docker configuration
├── docker-compose.yml         # Multi-service setup
├── nginx.conf                 # Nginx proxy configuration
└── package.json               # Dependencies
```

## Quick Start

### Local Development

```bash
npm install
npm run start
```

### Docker Deployment

```bash
docker compose up -d --build
```

### VPS Deployment

```bash
cd /opt/stream
git pull
docker compose down
docker compose up -d --build
```

## Movie Organization

1. **Create movie folders** in the `movies/` directory
2. **Name folders descriptively** (e.g., "The Matrix", "Inception")
3. **Place movie files** directly in each folder
4. **Supported formats**: MKV, MP4, WebM, MOV
5. **HLS is auto-generated** for each movie on first access

### Example Setup

```bash
mkdir -p movies
cd movies

# Create folder for first movie
mkdir "The Matrix"
# Copy movie file to the folder
cp /path/to/matrix.mkv "The Matrix/"

# Create folder for second movie
mkdir "Inception"
cp /path/to/inception.mp4 "Inception/"

# The server will auto-detect and generate HLS for each
```

## Usage

* **Local**: http://localhost:8080/?token=kriyank2024
* **LAN**: http://YOUR_LAN_IP:8080/?token=kriyank2024
* **VPS**: http://SERVER_IP:8080/?token=kriyank2024
* **Public**: https://mymovies.loca.lt/?token=kriyank2024

## Configuration

Set environment variables:

* `ACCESS_TOKEN`: Required token for access (default: kriyank2024)
* `PORT`: Server port (default: 3000)
* `HOST`: Bind address (default: 0.0.0.0)
* `FORCE_HLS`: Force HLS regeneration (set to 1)

## API Endpoints

* `GET /api/movies` - List all available movies
* `GET /api/health` - Server health check
* `GET /hls/{movieId}/stream.m3u8` - HLS manifest for specific movie
* `GET /video/{movieId}/{movieName}` - Direct video streaming

## Notes

* Each movie folder gets its own HLS stream
* HLS is generated once and reused (set FORCE_HLS=1 to regenerate)
* Audio is transcoded to AAC for browser compatibility
* Frontend automatically loads available movies
* Token authentication required for all streaming endpoints

## Troubleshooting

### HLS Not Working
- Check if ffmpeg is installed: `docker compose logs backend`
- Verify movie files exist in correct folders
- Check token authentication: `curl "http://localhost:3000/api/movies?token=kriyank2024"`

### Movies Not Loading
- Ensure movie folders are in `./movies/` directory
- Check file permissions: `ls -la movies/`
- Verify supported video formats: MKV, MP4, WebM, MOV

### Token Issues
- Default token: `kriyank2024`
- Set custom token: `ACCESS_TOKEN=your_token` in `.env`
- Check backend logs for token validation details
