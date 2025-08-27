# Movie Streaming Server

A Node.js streaming server with HLS support for personal media files.

## Features

- HTTP Range streaming for direct video playback
- HLS (HTTP Live Streaming) generation with ffmpeg
- Token-based access control
- Docker support for easy deployment
- Auto-detection of video files in `movie/` directory

## Quick Start

### Local Development
```bash
npm install
npm run start
```

### Docker Deployment
```bash
docker build -t stream-app .
docker run -d -p 3000:3000 -e ACCESS_TOKEN=your_secret -v /path/to/movies:/app/movie stream-app
```

### VPS Deployment
```bash
cd /opt/stream
sudo ACCESS_TOKEN=your_secret bash install.sh
```

## Usage

- **Local**: http://localhost:3000/?token=your_secret
- **LAN**: http://YOUR_LAN_IP:3000/?token=your_secret
- **VPS**: http://SERVER_IP:3000/?token=your_secret

## Configuration

Set environment variables:
- `ACCESS_TOKEN`: Required token for access (optional if not set)
- `PORT`: Server port (default: 3000)
- `HOST`: Bind address (default: 0.0.0.0)
- `FORCE_HLS`: Force HLS regeneration (set to 1)

## File Structure

```
stream/
├── server.js          # Main server file
├── public/            # Frontend files
├── movie/             # Video files (not in repo)
├── hls/               # Generated HLS files (not in repo)
├── Dockerfile         # Docker configuration
├── install.sh         # VPS installer script
└── package.json       # Dependencies
```

## Notes

- Place your video files in the `movie/` directory
- HLS is generated once and reused (set FORCE_HLS=1 to regenerate)
- Supported formats: MKV, MP4, WebM, MOV
- Audio is transcoded to AAC for browser compatibility
