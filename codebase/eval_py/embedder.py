#!/usr/bin/env python3
"""Port of codebase/eval/embedder.js — Embed chunks with the Jina API."""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

import httpx

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
PROJECT_ROOT = EVAL_DIR.parents[1]
CHUNKS = EVAL_DIR / "chunks.json"
OUT = EVAL_DIR / "embeddings.json"
MODEL = "jina-embeddings-v3"
BATCH = 32
DIM = 1024


def load_env() -> None:
    for file in (EVAL_DIR / ".env", PROJECT_ROOT / ".env"):
        if not file.exists():
            continue
        loaded = []
        for raw_line in file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            match = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line, re.IGNORECASE)
            if not match:
                continue
            key, value = match.groups()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key not in os.environ:
                os.environ[key] = value
                loaded.append(key)
        print(f"[loadenv] loaded from {file}: {', '.join(loaded)}", file=sys.stderr)
        return
    print("[loadenv] no .env found — relying on process.env", file=sys.stderr)


async def post_batch(client: httpx.AsyncClient, texts: list[str], api_key: str) -> list[list[float]]:
    response = await client.post(
        "https://api.jina.ai/v1/embeddings",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json={
            "model": MODEL,
            "input": texts,
            "dimensions": DIM,
            "normalized": True,
            "task": "retrieval.passage",
        },
    )
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
    return [item["embedding"] for item in response.json()["data"]]


async def main() -> None:
    load_env()
    api_key = os.getenv("JINA_API_KEY", "")
    if not api_key:
        print("⚠ JINA_API_KEY chưa set — sẽ chạy FALLBACK TF-IDF (không cần API).", file=sys.stderr)
        raise SystemExit(1)

    chunks = json.loads(CHUNKS.read_text(encoding="utf-8"))
    cache: dict[str, dict] = {}
    if OUT.exists():
        try:
            existing = json.loads(OUT.read_text(encoding="utf-8"))
            for entry in existing:
                cache[entry["code"]] = entry
            print(f"→ Cache: {len(cache)} embeddings đã có.")
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            pass

    missing = [chunk for chunk in chunks if chunk["code"] not in cache]
    print(f"→ Cần embed {len(missing)} đoạn mới (tổng {len(chunks)}).")

    done = 0
    async with httpx.AsyncClient(timeout=60) as client:
        for start in range(0, len(missing), BATCH):
            batch = missing[start:start + BATCH]
            attempt = 0
            while True:
                try:
                    vecs = await post_batch(client, [chunk["text"] for chunk in batch], api_key)
                    for index, chunk in enumerate(batch):
                        code = chunk["code"]
                        cache[code] = {"code": code, "text": chunk["text"], "embedding": vecs[index]}
                    done += len(batch)
                    print(f"  {done}/{len(missing)}")
                    break
                except Exception as exc:
                    attempt += 1
                    if attempt >= 3:
                        print(f"✗ Lỗi sau 3 lần tại batch {start}: {exc}", file=sys.stderr)
                        raise SystemExit(1)
                    print(f"  ! Retry {attempt}/3: {str(exc)[:100]}")
                    await asyncio.sleep(2 * attempt)
            await asyncio.sleep(0.2)

    output = [cache[chunk["code"]] for chunk in chunks if chunk["code"] in cache]
    OUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"→ Đã ghi {len(output)} embeddings vào {OUT}")
    print(f"→ Vector dim: {DIM}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        raise SystemExit(1)
