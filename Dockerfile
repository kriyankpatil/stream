FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Create directories expected at runtime
RUN mkdir -p /app/public /app/movie

ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["npm", "run", "start"]


