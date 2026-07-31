#!/usr/bin/env python3
"""
ingest.py — Embed chunks bằng Jina và đẩy vào Qdrant.

Port của codebase/eval/ingest.js.
Nếu embeddings.json đã có sẵn thì dùng luôn, không embed lại.

Sử dụng:
    python codebase/eval_py/ingest.py
    python codebase/eval_py/ingest.py --reset
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from vlearn import config  # noqa: E402 — sys.path set above
from vlearn.qdrant_client import ensure_collection, upsert_points, count, delete_all

CHUNKS_PATH = ROOT / "eval" / "chunks.json"
EMBEDDINGS_PATH = ROOT / "eval" / "embeddings.json"
MODEL_EMBED = "jina-embeddings-v3"
DIM = 1024
BATCH = 32


async def embed_batch(texts: list[str]) -> list[list[float]]:
    body = {"model": MODEL_EMBED, "input": texts, "dimensions": DIM, "normalized": True, "task": "retrieval.passage"}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config.JINA_API_KEY}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post("https://api.jina.ai/v1/embeddings", headers=headers, json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"Jina embed HTTP {response.status_code}: {response.text[:200]}")
    return [item["embedding"] for item in response.json()["data"]]


def hash_id(s: str) -> int:
    h = 5381
    for ch in s.encode():
        h = ((h << 5) + h + ch) & 0xFFFFFFFF
    return h & 0x7FFFFFFF


async def main() -> None:
    should_reset = "--reset" in sys.argv
    if should_reset:
        print("→ --reset: xoá collection trước...")
        try:
            await delete_all()
        except Exception:
            pass

    print("→ Load chunks...")
    chunks = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))

    embeddings: dict[str, list[float]] = {}
    if EMBEDDINGS_PATH.exists():
        arr = json.loads(EMBEDDINGS_PATH.read_text(encoding="utf-8"))
        for entry in arr:
            embeddings[entry["code"]] = entry["embedding"]
        print(f"→ Đã có {len(embeddings)} embeddings trong cache.")

    missing = [c for c in chunks if c["code"] not in embeddings]
    if missing:
        if not config.JINA_API_KEY:
            print("⚠ JINA_API_KEY chưa set — không thể embed")
            sys.exit(1)
        print(f"→ Cần embed {len(missing)} đoạn mới...")
        done = 0
        for start in range(0, len(missing), BATCH):
            batch = missing[start:start + BATCH]
            for attempt in range(1, 4):
                try:
                    vecs = await embed_batch([c["text"] for c in batch])
                    for i, c in enumerate(batch):
                        embeddings[c["code"]] = vecs[i]
                    done += len(batch)
                    print(f"  {done}/{len(missing)}")
                    break
                except Exception as exc:
                    if attempt >= 3:
                        print(f"✗ Lỗi sau 3 lần: {exc}")
                        sys.exit(1)
                    print(f"  ! Retry {attempt}/3: {str(exc)[:100]}")
                    time.sleep(2 * attempt)
            time.sleep(0.2)
        out = [{"code": c["code"], "embedding": embeddings[c["code"]]} for c in chunks if c["code"] in embeddings]
        EMBEDDINGS_PATH.write_text(json.dumps(out), encoding="utf-8")

    await ensure_collection()
    before = await count()
    print(f"→ Qdrant collection: {before} vectors trước ingest")

    points = []
    missing_count = 0
    for c in chunks:
        vec = embeddings.get(c["code"])
        if not vec:
            missing_count += 1
            continue
        payload: dict = {"code": c["code"], "source": c.get("source", ""), "file": c.get("file", ""), "text": c["text"], "charCount": c.get("charCount", len(c["text"]))}
        if c.get("conversation_id"):
            payload["conversation_id"] = c["conversation_id"]
        if c.get("kind"):
            payload["kind"] = c["kind"]
        points.append({"id": hash_id(c["code"]), "vector": vec, "payload": payload})

    if missing_count:
        print(f"⚠ {missing_count} chunks thiếu embedding, bỏ qua")

    print(f"→ Upsert {len(points)} points...")
    await upsert_points(points)
    after = await count()
    print(f"→ Qdrant sau ingest: {after} vectors")
    print("✓ Done.")


if __name__ == "__main__":
    asyncio.run(main())
