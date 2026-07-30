#!/bin/sh
# entrypoint.sh — Khởi động app + auto-ingest nếu Qdrant rỗng
#
# Flow:
#   1. Đợi Qdrant healthy
#   2. Kiểm tra collection: nếu rỗng → chạy ingest
#   3. Khởi động server

set -e

echo "[entrypoint] Waiting for Qdrant..."
for i in $(seq 1 30); do
  if wget -qO- http://qdrant:6333/healthz > /dev/null 2>&1; then
    echo "[entrypoint] Qdrant ready."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[entrypoint] Qdrant timeout — starting anyway"
  fi
  sleep 1
done

# Kiểm tra collection — nếu không có hoặc rỗng, chạy ingest
if [ -n "$JINA_API_KEY" ]; then
  echo "[entrypoint] Checking collection..."
  COUNT=$(wget -qO- http://qdrant:6333/collections/${QDRANT_COLLECTION:-vlearn_tutor} 2>/dev/null \
    | grep -oE '"(points|vectors)_count":[0-9]*' \
    | grep -oE '[0-9]+' \
    | head -1)
  COUNT=${COUNT:-0}
  echo "[entrypoint] Collection has ${COUNT} vectors."

  if [ "$COUNT" = "0" ]; then
    echo "[entrypoint] Collection empty — running ingest..."
    node eval/ingest.js
    echo "[entrypoint] Ingest done."
  fi
else
  echo "[entrypoint] ⚠ No JINA_API_KEY — skipping auto-ingest"
fi

echo "[entrypoint] Starting server..."
exec node server.js