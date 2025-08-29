FROM node:20-bookworm-slim

# Install system dependencies including fast download tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    aria2 \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /app/public /app/movies /app/hls && \
    chmod 777 /app/movies /app/hls /app/public && \
    chown -R root:root /app || true

# Set environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the application
CMD ["npm", "start"]


