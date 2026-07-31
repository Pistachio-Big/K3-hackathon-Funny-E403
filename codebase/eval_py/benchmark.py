#!/usr/bin/env python3
"""Run a JSONL golden set through ask_tutor, ported from eval/benchmark.js."""

import asyncio
import csv
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from vlearn.rag import ask_tutor  # noqa: E402

GOLDEN = ROOT / "eval" / "golden-set.json"
OUT_DIR = ROOT / "eval"
FIELDS = [
    "id", "layer", "question", "mode", "retrieved_top1",
    "retrieved_top1_score", "verified_citations", "hallucinated_count",
    "isFailure", "failSafe", "latency_ms",
]


def find_next_run_file() -> Path:
    index = 1
    while (OUT_DIR / f"run-{index}.csv").exists():
        index += 1
    return OUT_DIR / f"run-{index}.csv"


async def main() -> None:
    if not GOLDEN.exists():
        print(f"⚠ Không thấy {GOLDEN}", file=sys.stderr)
        print("  Tạo file golden-set.json với format mỗi dòng 1 JSON object:", file=sys.stderr)
        print('  {"id":"...","layer":"①","question":"...","expected_codes":["T01-001"]}', file=sys.stderr)
        raise SystemExit(1)

    lines = [line for line in GOLDEN.read_text(encoding="utf-8").splitlines() if line.strip()]
    cases = [json.loads(line) for line in lines]
    print(f"→ Chạy {len(cases)} test case...\n")

    output = find_next_run_file()
    summary = {"total": 0, "byLayer": {}, "hallucinated": [], "noCitation": []}
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for case in cases:
            print(f"  [{case['id']}] {case['layer']} ... ", end="", flush=True)
            started = time.perf_counter()
            try:
                response = await ask_tutor(case["question"])
            except Exception as exc:
                latency = round((time.perf_counter() - started) * 1000)
                print(f"ERROR: {str(exc)[:80]}")
                writer.writerow({
                    "id": case["id"], "layer": case["layer"],
                    "question": case["question"], "mode": "ERROR",
                    "retrieved_top1": "", "retrieved_top1_score": "",
                    "verified_citations": "", "hallucinated_count": "",
                    "isFailure": "", "failSafe": str(exc)[:200],
                    "latency_ms": latency,
                })
                continue

            latency = round((time.perf_counter() - started) * 1000)
            trace = response.get("trace") or {}
            retrieved = trace.get("retrieved") or []
            top1 = retrieved[0] if retrieved else {}
            verified_data = trace.get("verified") or {}
            verified = "|".join(response.get("citations") or [])
            hallucinated_count = len(verified_data.get("hallucinated") or [])
            is_failure = "yes" if response.get("isFailure") else "no"
            fail_safe = verified_data.get("failSafe") or ""
            score = top1.get("score")
            writer.writerow({
                "id": case["id"], "layer": case["layer"],
                "question": case["question"], "mode": trace.get("mode", ""),
                "retrieved_top1": top1.get("code", ""),
                "retrieved_top1_score": f"{score:.4f}" if isinstance(score, (int, float)) else "",
                "verified_citations": verified,
                "hallucinated_count": hallucinated_count,
                "isFailure": is_failure, "failSafe": fail_safe,
                "latency_ms": latency,
            })
            summary["total"] += 1
            summary["byLayer"][case["layer"]] = summary["byLayer"].get(case["layer"], 0) + 1
            if hallucinated_count:
                summary["hallucinated"].append(case["id"])
            if response.get("isFailure"):
                summary["noCitation"].append(case["id"])
            print(f"{'FAIL' if response.get('isFailure') else 'OK'} · cite={verified or '(none)'} · {latency}ms")

    print(f"\n→ Đã ghi kết quả: {output}")
    print("\n=== Tổng kết ===")
    print(f"Tổng: {summary['total']} case")
    for layer, count in summary["byLayer"].items():
        print(f"  {layer}: {count} case")
    if summary["hallucinated"]:
        print(f"⚠ {len(summary['hallucinated'])} case có hallucination: {', '.join(summary['hallucinated'])}")
    else:
        print("✓ 0 case hallucination")
    print(f"Failure path: {len(summary['noCitation'])}/{summary['total']} case")


if __name__ == "__main__":
    asyncio.run(main())
