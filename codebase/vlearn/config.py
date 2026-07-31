import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BASE_DIR.parent
EVAL_DIR = BASE_DIR / "eval"
TRACE_DIR = EVAL_DIR / "traces"

CANDIDATES = [PROJECT_ROOT / ".env", EVAL_DIR / ".env"]


def _parse_env(content: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        parsed[key] = value
    return parsed


def load_env() -> dict[str, object] | None:
    for file in CANDIDATES:
        if file.exists():
            parsed = _parse_env(file.read_text(encoding="utf-8"))
            loaded = []
            for key, value in parsed.items():
                if key not in os.environ:
                    os.environ[key] = value
                    loaded.append(key)
            return {"file": str(file), "loaded": loaded}
    return None


load_env()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
JINA_API_KEY = os.getenv("JINA_API_KEY", "")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", "")
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "vlearn_tutor")
VECTOR_DIM = int(os.getenv("VECTOR_DIM", "1024"))
PORT = int(os.getenv("PORT", "3000"))
EVAL_MODEL = os.getenv("EVAL_MODEL", "openai/gpt-4o-mini")
