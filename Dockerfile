# Use a stable Debian-based Node image (avoids some Alpine/DNS issues)
FROM node:20-bookworm-slim

# Create app directory
WORKDIR /app

# Install ffmpeg for HLS generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Environment
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Expose the app port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]


