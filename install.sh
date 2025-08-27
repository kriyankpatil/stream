#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/stream"
IMAGE="stream-app"
PORT="3000"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  apt-get update -y
  apt-get install -y docker.io
  systemctl enable --now docker
fi

mkdir -p "$APP_DIR"
cp -r . "$APP_DIR" || true
cd "$APP_DIR"

echo "Building Docker image..."
docker build -t "$IMAGE" .

ACCESS_TOKEN_VALUE=${ACCESS_TOKEN:-}
cat >/etc/systemd/system/stream.service <<EOF
[Unit]
Description=Stream Server
After=docker.service
Requires=docker.service

[Service]
Restart=always
ExecStart=/usr/bin/docker run --rm \
  --name stream \
  -p ${PORT}:3000 \
  -e HOST=0.0.0.0 \
  ${ACCESS_TOKEN_VALUE:+-e ACCESS_TOKEN=${ACCESS_TOKEN_VALUE}} \
  -v ${APP_DIR}/movie:/app/movie \
  ${IMAGE}
ExecStop=/usr/bin/docker stop stream

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now stream

echo "Service started. If you have a domain, point DNS to this server and proxy it."
echo "Direct access: http://$(hostname -I | awk '{print $1}'):${PORT}"
if [ -n "$ACCESS_TOKEN_VALUE" ]; then
  echo "Use token: ?token=$ACCESS_TOKEN_VALUE"
fi


