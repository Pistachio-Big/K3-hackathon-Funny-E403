#!/usr/bin/env python3
"""Port of codebase/eval/chunker.js — Merge corpus: transcript + chatlog."""

import json
import re
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
TRANSCRIPT_DIR = EVAL_DIR.parents[1] / "data" / "vlearn-pack" / "transcript"
CHATLOG = EVAL_DIR / "chatlog-chunks.json"
OUT = EVAL_DIR / "chunks.json"

FILES = [
    "transcript-01-clean.md",
    "transcript-02-clean.md",
    "transcript-03-clean.md",
    "transcript-04-clean.md",
    "transcript-05-clean.md",
    "transcript-06-clean.md",
]

RE_CHUNK_START = re.compile(r"^\*\*\[(T\d{2}-\d{1,3})\]\*\*\s*(.*)$")


def js_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def chunk_transcript(file_path: Path, file_name: str) -> list[dict]:
    raw = file_path.read_text(encoding="utf-8")
    lines = re.split(r"\r?\n", raw)
    chunks = []
    cur: dict | None = None

    for line in lines:
        m = RE_CHUNK_START.match(line)
        if m:
            if cur:
                chunks.append(cur)
            cur = {"code": m.group(1), "source": "transcript", "file": file_name, "text": m.group(2).strip()}
        elif cur:
            t = line.strip()
            if not t:
                continue
            if t.startswith("#"):
                continue
            if t.startswith(">"):
                continue
            cur["text"] += " " + t

    if cur:
        chunks.append(cur)

    result = []
    for c in chunks:
        normalized = re.sub(r"\s+", " ", c["text"]).strip()
        if normalized:
            result.append({
                "code": c["code"],
                "source": "transcript",
                "file": c["file"],
                "text": normalized,
                "charCount": js_length(c["text"]),
            })
    return result


def load_chatlog() -> list[dict]:
    if not CHATLOG.exists():
        print(f"⚠ Không thấy {CHATLOG} — chạy chatlog_chunker.py trước.", file=sys.stderr)
        return []

    raw = json.loads(CHATLOG.read_text(encoding="utf-8"))
    return [
        {
            "code": f"{c['conversation_id']}-{c['turn_id']}-{c['kind']}",
            "source": "chatlog",
            "file": "chat_history_anonymized_for_hackathon.csv",
            "conversation_id": c["conversation_id"],
            "turn_id": c["turn_id"],
            "kind": c["kind"],
            "text": c["text"],
            "charCount": len(c["text"]),
        }
        for c in raw
    ]


def main() -> None:
    all_chunks: list[dict] = []

    transcript_count = 0
    for fname in FILES:
        full = TRANSCRIPT_DIR / fname
        if not full.exists():
            print(f"⚠ Không tìm thấy: {full}", file=sys.stderr)
            continue
        chunks = chunk_transcript(full, fname)
        print(f"✓ {fname}: {len(chunks)} đoạn")
        all_chunks.extend(chunks)
        transcript_count += len(chunks)

    chatlog_chunks = load_chatlog()
    print(f"✓ chatlog: {len(chatlog_chunks)} chunk (Q + A)")
    all_chunks.extend(chatlog_chunks)

    seen: dict[str, str] = {}
    for c in all_chunks:
        if c["code"] in seen:
            print(f"⚠ MÃ TRÙNG: {c['code']} (file: {c['file']})", file=sys.stderr)
        else:
            seen[c["code"]] = c["file"]

    OUT.write_text(json.dumps(all_chunks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n→ Tổng: {len(all_chunks)} chunks (transcript {transcript_count} + chatlog {len(chatlog_chunks)})")
    print(f"→ Đã ghi vào {OUT}")


if __name__ == "__main__":
    main()
