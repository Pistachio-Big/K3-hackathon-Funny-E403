#!/usr/bin/env python3
"""Port of codebase/eval/chatlog_chunker.js."""

import json
import re
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
CSV = EVAL_DIR.parents[1] / "data" / "vlearn-pack" / "chatlog" / "chat_history_anonymized_for_hackathon.csv"
OUT = EVAL_DIR / "chatlog-chunks.json"


def parse_csv(text: str) -> list[dict[str, str]]:
    lines = re.split(r"\r?\n", text)
    header = lines[0].split(",")
    rows = []

    for line in lines[1:]:
        if not line.strip():
            continue

        fields = []
        current = ""
        in_quote = False
        index = 0
        while index < len(line):
            char = line[index]
            if char == '"':
                if in_quote and index + 1 < len(line) and line[index + 1] == '"':
                    current += '"'
                    index += 1
                else:
                    in_quote = not in_quote
            elif char == "," and not in_quote:
                fields.append(current)
                current = ""
            else:
                current += char
            index += 1

        fields.append(current)
        rows.append({name: fields[i] if i < len(fields) and fields[i] else "" for i, name in enumerate(header)})

    return rows


def clean_content(value: str) -> str:
    if not value:
        return ""
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"^\(.*?\)\s*", "", value)
    return value.strip()


def main() -> None:
    if not CSV.exists():
        print(f"⚠ Không thấy {CSV}", file=sys.stderr)
        raise SystemExit(1)

    rows = parse_csv(CSV.read_text(encoding="utf-8"))
    print(f"→ Đọc {len(rows)} dòng CSV.")

    turns: dict[str, dict[str, str]] = {}
    for row in rows:
        turn_id = row.get("turn_id", "")
        if turn_id not in turns:
            turns[turn_id] = {
                "turn_id": turn_id,
                "conversation_id": row.get("conversation_id", ""),
                "day_code": row.get("day_code", ""),
                "student": "",
                "tutor": "",
                "rating": row.get("rating", ""),
            }

        turn = turns[turn_id]
        if row.get("role") == "student":
            turn["student"] = clean_content(row.get("content", ""))
        elif row.get("role") == "tutor":
            turn["tutor"] = clean_content(row.get("content", ""))

    print(f"→ {len(turns)} turn duy nhất.")

    chunks = []
    skipped_empty = 0
    for turn in turns.values():
        code = turn["conversation_id"]
        if turn["student"] and len(turn["student"]) > 5:
            chunks.append({
                "code": code,
                "kind": "Q",
                "conversation_id": turn["conversation_id"],
                "turn_id": turn["turn_id"],
                "text": turn["student"],
            })
        else:
            skipped_empty += 1

        if turn["tutor"] and len(turn["tutor"]) > 5:
            chunks.append({
                "code": code,
                "kind": "A",
                "conversation_id": turn["conversation_id"],
                "turn_id": turn["turn_id"],
                "text": turn["tutor"],
                "rating": turn["rating"],
            })
        else:
            skipped_empty += 1

    OUT.write_text(json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Đã ghi {len(chunks)} chatlog chunks (bỏ qua {skipped_empty} rỗng) vào {OUT}")
    print(f"→ {len({chunk['code'] for chunk in chunks})} hội thoại duy nhất được index.")


if __name__ == "__main__":
    main()
