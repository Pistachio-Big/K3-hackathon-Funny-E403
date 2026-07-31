from typing import Any
from urllib.parse import urljoin

import httpx

from . import config

COLLECTION = config.QDRANT_COLLECTION
VECTOR_DIM = config.VECTOR_DIM


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if config.QDRANT_API_KEY:
        headers["api-key"] = config.QDRANT_API_KEY
    return headers


async def call(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    url = urljoin(config.QDRANT_URL.rstrip("/") + "/", path.lstrip("/"))
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.request(method, url, headers=_headers(), json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"Qdrant HTTP {response.status_code}: {response.text[:300]}")
    if not response.text:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


async def collection_exists() -> bool:
    try:
        await call("GET", f"/collections/{COLLECTION}")
        return True
    except RuntimeError as exc:
        if "HTTP 404" in str(exc):
            return False
        raise


async def ensure_collection() -> dict[str, bool]:
    if await collection_exists():
        return {"created": False}
    await call("PUT", f"/collections/{COLLECTION}", {
        "vectors": {"size": VECTOR_DIM, "distance": "Cosine"},
        "optimizers_config": {"default_segment_number": 2},
    })
    return {"created": True}


async def upsert_points(points: list[dict[str, Any]]) -> int:
    batch_size = 256
    for start in range(0, len(points), batch_size):
        await call("PUT", f"/collections/{COLLECTION}/points", {"points": points[start:start + batch_size]})
    return len(points)


async def search(vector: list[float], top_k: int = 5, filter_: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"vector": vector, "limit": top_k, "with_payload": True}
    if filter_:
        body["filter"] = filter_
    data = await call("POST", f"/collections/{COLLECTION}/points/search", body)
    return [
        {"id": p.get("id"), "score": p.get("score", 0), "payload": p.get("payload", {})}
        for p in data.get("result", [])
    ]


async def count() -> int:
    data = await call("GET", f"/collections/{COLLECTION}")
    result = data.get("result", {}) if isinstance(data, dict) else {}
    return result.get("points_count") or result.get("vectors_count") or 0


async def delete_all() -> dict[str, bool]:
    await call("DELETE", f"/collections/{COLLECTION}/points")
    return {"reset": True}


async def health() -> dict[str, Any]:
    try:
        await call("GET", "/healthz")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
