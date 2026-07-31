import json
import re
from pathlib import Path
from typing import Any

import httpx

from . import config

CHUNKS_PATH = Path(__file__).resolve().parents[1] / "eval" / "chunks.json"

_code_to_chunk: dict[str, dict[str, Any]] = {}


def _load_chunks() -> int:
    global _code_to_chunk
    try:
        chunks = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))
        _code_to_chunk = {c["code"]: c for c in chunks}
        return len(chunks)
    except Exception as exc:
        print(f"[tools] Cannot load chunks: {exc}")
        return 0


_load_chunks()

TOOL_DEFINITIONS = [
    {
        "name": "search_web",
        "description": "Tìm kiếm thông tin trên Internet. Dùng khi câu hỏi không có trong tài liệu khoá học hoặc cần thông tin bổ sung từ bên ngoài. Kết quả trả về gồm: tiêu đề, URL, và nội dung tóm tắt từ các trang web liên quan.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Câu truy vấn tìm kiếm. Nên ngắn gọn, tập trung vào từ khóa chính.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "lookup_document",
        "description": "Tra cứu nội dung cụ thể trong tài liệu bài giảng. Dùng khi bạn cần xác nhận thông tin từ tài liệu hoặc tìm thêm chi tiết về một chủ đề cụ thể. Trả về các đoạn văn bản liên quan từ transcript.",
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Chủ đề hoặc từ khóa cần tra cứu trong tài liệu.",
                }
            },
            "required": ["topic"],
        },
    },
]

SYSTEM_PROMPT = """Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.

## NHIỆM VỤ
Trả lời câu hỏi của học viên một cách chính xác, dựa trên tài liệu bài giảng và thông tin tìm kiếm được.

## NGUYÊN TẮC VÀNG

### 1. LUÔN kiểm tra tài liệu TRƯỚC
- Khi được hỏi về nội dung bài giảng, LUÔN dùng tool lookup_document để tra cứu
- Chỉ trả lời khi có căn cứ từ tài liệu hoặc nguồn đáng tin

### 2. KHÔNG ĐƯỢC bịa đặt
- Tuyệt đối không tạo thông tin không có trong tài liệu
- Nếu không tìm thấy, thừa nhận rõ ràng: "Mình không tìm thấy nội dung này trong tài liệu"

### 3. Trích dẫn — BẮT BUỘC, KHÔNG ĐƯỢC BỎ QUA
- Mọi nhận định, khái niệm, hoặc phát biểu có nội dung từ tài liệu **phải** kèm mã trích dẫn ngay trong câu.
- Đoạn bài giảng: dùng mã **[Txx-NNN]** (ví dụ: [T02-045])
- Hội thoại học viên: dùng **[Cxxxx-Tyyyy-Q]** hoặc **[Cxxxx-Tyyyy-A]**
- Nguồn web: ghi rõ (Nguồn: tiêu đề - url)
- Đặt mã trích dẫn **ở cuối câu** chứa thông tin đó, ví dụ: "...AI là khả năng máy tính thực hiện các tác vụ giống con người [T01-002]."
- **CẤM** tuyệt đối:
  - Trả lời dài mà **0 trích dẫn** khi câu hỏi nằm trong phạm vi tài liệu.
  - Dùng **[Txx-NNN]** hoặc **[Cxxxx]** nếu không có thật trong kết quả tra cứu.

### 4. Khi tài liệu không đủ
- Dùng tool search_web để tìm thông tin bổ sung
- Khi dùng thông tin web, ghi rõ nguồn
- Nêu rõ đây là thông tin bổ sung, không phải từ tài liệu khoá học

### 5. Văn phong
- Thân thiện, tiếng Việt tự nhiên, xưng "mình"
- Giải thích rõ ràng, có ví dụ khi cần
- Nếu câu hỏi mơ hồ, hỏi lại để hiểu đúng ý

Hãy bắt đầu bằng cách tra cứu tài liệu cho mỗi câu hỏi."""


async def _search_tavily(query: str, limit: int = 5) -> list[dict[str, Any]]:
    if not config.TAVILY_API_KEY:
        raise RuntimeError("No TAVILY_API_KEY")
    body = {
        "api_key": config.TAVILY_API_KEY,
        "query": query,
        "search_depth": "basic",
        "max_results": limit,
        "include_answer": True,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post("https://api.tavily.com/search", json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"Tavily HTTP {response.status_code}")
    data = response.json()
    results = [
        {"title": item.get("title", ""), "url": item.get("url", ""), "snippet": (item.get("content") or item.get("snippet") or "")}
        for item in (data.get("results") or [])[:limit]
    ]
    return results


async def _search_duckduckgo(query: str, limit: int = 5) -> list[dict[str, Any]]:
    from urllib.parse import quote_plus
    url = f"https://ddg-api.duckduckgo-stream.com/search?q={quote_plus(query)}&format=json&limit={limit}"
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(url)
    results: list[dict[str, Any]] = []
    for line in response.text.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            results.append({"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("description") or item.get("snippet") or ""})
        except json.JSONDecodeError:
            continue
        if len(results) >= limit:
            break
    return results


def _format_search_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    if not results:
        return {"status": "success", "message": "Không tìm thấy kết quả nào cho truy vấn này.", "results": []}
    return {
        "status": "success",
        "message": f"Tìm thấy {len(results)} kết quả:",
        "results": [{"index": i + 1, "title": r["title"], "url": r["url"], "snippet": r["snippet"][:250]} for i, r in enumerate(results)],
    }


async def handle_search_web(query: str) -> dict[str, Any]:
    print(f"[tools] search_web called: \"{query[:60]}...\"")
    if config.TAVILY_API_KEY:
        try:
            results = await _search_tavily(query, 5)
            if results:
                return _format_search_results(results)
        except Exception as exc:
            print(f"[tools] Tavily failed: {exc}")
    try:
        results = await _search_duckduckgo(query, 5)
        return _format_search_results(results)
    except Exception as exc:
        print(f"[tools] DuckDuckGo failed: {exc}")
    return {"status": "error", "message": "Không thể kết nối đến máy chủ tìm kiếm.", "results": []}


VIETNAMESE_STOPWORDS = {
    "thế", "nào", "khác", "gì", "như", "sao", "được", "cho", "với", "về", "là", "của", "và",
    "trong", "khi", "có", "không", "thầy", "ơi", "em", "mình", "giải", "thích", "hỏi", "bài",
}


async def handle_lookup_document(topic: str) -> dict[str, Any]:
    print(f"[tools] lookup_document called: \"{topic[:60]}...\"")
    topic_lower = topic.lower()
    raw_words = [w for w in re.split(r"\s+", topic_lower) if len(w) > 1]
    filtered_words = [w for w in raw_words if w not in VIETNAMESE_STOPWORDS]
    topic_words = filtered_words if filtered_words else raw_words
    matched: list[dict[str, Any]] = []
    for code, chunk in _code_to_chunk.items():
        text_lower = (chunk.get("text") or "").lower()
        match_count = sum(1 for w in topic_words if w in text_lower)
        if match_count > 0:
            matched.append({"code": code, "score": match_count / max(len(topic_words), 1), "text": chunk.get("text", ""), "title": code})
    matched.sort(key=lambda x: x["score"], reverse=True)
    top = matched[:5]
    if not top:
        return {"status": "success", "message": f"Không tìm thấy nội dung nào liên quan đến \"{topic}\" trong tài liệu.", "documents": [], "suggestion": "Thử tìm kiếm trên web hoặc hỏi giảng viên trực tiếp."}
    return {
        "status": "success",
        "message": f"Tìm thấy {len(top)} đoạn liên quan:",
        "documents": [{"code": d["code"], "title": d["title"], "relevance": f"{round(d['score'] * 100)}%", "excerpt": d["text"][:300] + ("..." if len(d["text"]) > 300 else "")} for d in top],
    }


async def process_tool_calls(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for call in tool_calls:
        name = call.get("name", "")
        args = call.get("args") or {}
        try:
            if name == "search_web":
                result = await handle_search_web(args.get("query", ""))
            elif name == "lookup_document":
                result = await handle_lookup_document(args.get("topic", ""))
            else:
                result = {"status": "error", "message": f"Unknown tool: {name}"}
        except Exception as exc:
            result = {"status": "error", "message": f"Tool error: {exc}"}
        results.append({"toolCallId": call.get("id"), "toolName": name, "result": result})
    return results
