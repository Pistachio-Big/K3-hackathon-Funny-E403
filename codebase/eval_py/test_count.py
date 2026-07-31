#!/usr/bin/env python3
"""Port of codebase/eval/test-count.js — Smoke test: query Qdrant vector count."""

import json
import os
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
PROJECT_ROOT = EVAL_DIR.parents[1]


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
    qdrant_url = os.getenv("QDRANT_URL", "http://localhost:6333")
    collection = os.getenv("QDRANT_COLLECTION", "vlearn_tutor")

    url = f"{qdrant_url}/collections/{collection}"
    req = Request(url, headers={"Content-Type": "application/json"})
    api_key = os.getenv("QDRANT_API_KEY", "")
    if api_key:
        req.add_header("api-key", api_key)

    try:
        with urlopen(req) as response:
            status = response.getcode()
            body = response.read().decode("utf-8")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)

    print(f"Status: {status}")
    data = json.loads(body)
    result = data.get("result", {})
    print(f"Result: {json.dumps(result, indent=2, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
