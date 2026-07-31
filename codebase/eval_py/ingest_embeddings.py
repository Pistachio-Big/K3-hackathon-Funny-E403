#!/usr/bin/env python3
"""Port of codebase/eval/ingest-embeddings.js — Ingest embeddings into Qdrant."""

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
PROJECT_ROOT = EVAL_DIR.parents[1]
CHUNKS = EVAL_DIR / "chunks.json"
EMBEDDINGS = EVAL_DIR / "embeddings.json"
BATCH = 256


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


def hash_id(value: str) -> int:
    h = 5381
    utf16 = value.encode("utf-16-le", "surrogatepass")
    for index in range(0, len(utf16), 2):
        code_unit = utf16[index] | (utf16[index + 1] << 8)
        h = ((h << 5) + h + code_unit) & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
    return abs(h)


class QdrantClient:
    def __init__(self) -> None:
        self.url = os.getenv("QDRANT_URL", "http://localhost:6333")
        self.api_key = os.getenv("QDRANT_API_KEY", "")
        self.collection = os.getenv("QDRANT_COLLECTION", "vlearn_tutor")
        self.vector_dim = int(os.getenv("VECTOR_DIM", "1024"))

    def headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["api-key"] = self.api_key
        return headers

    async def call(self, client: httpx.AsyncClient, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        response = await client.request(
            method,
            urljoin(self.url.rstrip("/") + "/", path.lstrip("/")),
            headers=self.headers(),
            json=body,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Qdrant HTTP {response.status_code}: {response.text[:300]}")
        if not response.text:
            return None
        try:
            return response.json()
        except ValueError:
            if len(response.text) < 200 and response.status_code == 200:
                return response.text
            raise RuntimeError(f"Qdrant JSON parse: {response.text[:200]}")

    async def ensure_collection(self, client: httpx.AsyncClient) -> None:
        try:
            await self.call(client, "GET", f"/collections/{self.collection}")
            return
        except RuntimeError as exc:
            if "HTTP 404" not in str(exc):
                raise
        await self.call(client, "PUT", f"/collections/{self.collection}", {
            "vectors": {"size": self.vector_dim, "distance": "Cosine"},
            "optimizers_config": {"default_segment_number": 2},
        })

    async def upsert_points(self, client: httpx.AsyncClient, points: list[dict[str, Any]]) -> None:
        for start in range(0, len(points), BATCH):
            await self.call(
                client,
                "PUT",
                f"/collections/{self.collection}/points",
                {"points": points[start:start + BATCH]},
            )

    async def count(self, client: httpx.AsyncClient) -> int:
        data = await self.call(client, "GET", f"/collections/{self.collection}")
        result = data.get("result", {})
        if result.get("points_count") is not None:
            return result["points_count"]
        if result.get("vectors_count") is not None:
            return result["vectors_count"]
        return 0


async def main() -> None:
    load_env()
    print("→ Load chunks và embeddings...")
    chunks = json.loads(CHUNKS.read_text(encoding="utf-8"))
    embeddings = json.loads(EMBEDDINGS.read_text(encoding="utf-8"))

    embed_map = {entry["code"]: entry["embedding"] for entry in embeddings}
    print(f"  chunks: {len(chunks)}, embeddings: {len(embeddings)}")

    qdrant = QdrantClient()
    async with httpx.AsyncClient(timeout=30) as client:
        await qdrant.ensure_collection(client)
        before = await qdrant.count(client)
        print(f"→ Qdrant collection: {before} vectors")

        points = []
        missing = 0
        for chunk in chunks:
            vector = embed_map.get(chunk["code"])
            if vector is None:
                missing += 1
                continue

            payload = {
                "code": chunk["code"],
                "source": chunk.get("source") or "",
                "file": chunk.get("file") or "",
                "text": chunk["text"],
                "charCount": chunk.get("charCount") or len(chunk["text"]),
            }
            if chunk.get("conversation_id"):
                payload["conversation_id"] = chunk["conversation_id"]
            if chunk.get("kind"):
                payload["kind"] = chunk["kind"]

            points.append({"id": hash_id(chunk["code"]), "vector": vector, "payload": payload})

        if missing > 0:
            print(f"⚠ {missing} chunks không có embedding, bỏ qua")

        print(f"→ Upsert {len(points)} points...")
        await qdrant.upsert_points(client, points)
        after = await qdrant.count(client)
        print(f"→ Qdrant sau ingest: {after} vectors")
        print("✓ Done.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
