#!/bin/sh
# Khởi động FastAPI và auto-ingest nếu Qdrant rỗng.

set -e

echo "[entrypoint] Waiting for Qdrant..."
for i in $(seq 1 30); do
  if wget -qO- http://qdrant:6333/healthz > /dev/null 2>&1; then
    echo "[entrypoint] Qdrant ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] Qdrant timeout — starting anyway"
  fi
  sleep 1
done

if [ -n "$JINA_API_KEY" ]; then
  echo "[entrypoint] Checking collection..."
  COUNT=$(wget -qO- "http://qdrant:6333/collections/${QDRANT_COLLECTION:-vlearn_tutor}" 2>/dev/null \
    | grep -oE '"(points|vectors)_count":[0-9]*' \
    | grep -oE '[0-9]+' \
    | head -1)
  COUNT=${COUNT:-0}
  echo "[entrypoint] Collection has ${COUNT} vectors."

  if [ "$COUNT" = "0" ]; then
    echo "[entrypoint] Collection empty — running ingest..."
    python eval_py/ingest.py
    echo "[entrypoint] Ingest done."
  fi
else
  echo "[entrypoint] ⚠ No JINA_API_KEY — skipping auto-ingest"
fi

echo "[entrypoint] Starting FastAPI server..."
exec "$@"
