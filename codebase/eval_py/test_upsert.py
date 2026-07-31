#!/usr/bin/env python3
"""Port of codebase/eval/test-upsert.js — Smoke test: upsert a single test point into Qdrant."""

import json
import os
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
PROJECT_ROOT = EVAL_DIR.parents[1]

QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.getenv("QDRANT_COLLECTION", "vlearn_tutor")


def load_env() -> None:
    for file in (EVAL_DIR / ".env", PROJECT_ROOT / ".env"):
        if not file.exists():
            continue
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
        return


def main() -> None:
    load_env()
    qdrant_url = os.getenv("QDRANT_URL", QDRANT_URL)
    collection = os.getenv("QDRANT_COLLECTION", COLLECTION)

    body = json.dumps({
        "points": [{
            "id": 999,
            "vector": [0.01] * 10,
            "payload": {"code": "TEST", "text": "test"},
        }]
    }).encode("utf-8")

    url = f"{qdrant_url}/collections/{collection}/points"
    req = Request(url, data=body, method="PUT")
    req.add_header("Content-Type", "application/json")
    req.add_header("Content-Length", str(len(body)))
    api_key = os.getenv("QDRANT_API_KEY", "")
    if api_key:
        req.add_header("api-key", api_key)

    print("Request URL:", url)
    print("Body:", body.decode()[:200])

    try:
        with urlopen(req) as response:
            status = response.getcode()
            buf = response.read().decode("utf-8")
    except URLError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)

    print("Status:", status)
    print("Response:", buf[:500])


if __name__ == "__main__":
    main()
