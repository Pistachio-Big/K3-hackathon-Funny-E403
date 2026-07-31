import json
import re
from typing import Any

import httpx

from . import config

CONTEXT_SCORE_THRESHOLD = 0.3
MIN_RELEVANT_CHUNKS = 3
WEAK_ANSWER_PATTERNS = [
    "không rõ", "không biết", "không tìm thấy", "không đề cập",
    "mơ hồ", "thiếu thông tin", "không đủ", "ngoài phạm vi",
]


def _stop_words() -> set[str]:
    return {"là", "của", "có", "không", "và", "để", "trong", "cho", "với",
            "theo", "như", "nào", "gì", "ra", "sao", "ở", "được", "hay",
            "thế", "này", "khi", "đã", "từ", "về", "hỏi", "muốn", "cách"}


def extract_keywords(text: str) -> list[str]:
    stop = _stop_words()
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    return [w for w in cleaned.split() if len(w) > 2 and w not in stop]


def check_sufficient_context(top_chunks: list[dict[str, Any]], question: str, mode: str = "qdrant") -> dict[str, Any]:
    details: dict[str, Any] = {
        "chunkCount": len(top_chunks),
        "topScore": top_chunks[0]["score"] if top_chunks else 0,
    }
    if len(top_chunks) < MIN_RELEVANT_CHUNKS:
        return {"sufficient": False, "score": 0.2, "reasons": [f"Chỉ có {len(top_chunks)} chunks, cần tối thiểu {MIN_RELEVANT_CHUNKS}"], "details": details}
    if top_chunks[0]["score"] < CONTEXT_SCORE_THRESHOLD:
        return {"sufficient": False, "score": 0.3, "reasons": [f"Top-1 score ({top_chunks[0]['score']:.3f}) thấp hơn ngưỡng ({CONTEXT_SCORE_THRESHOLD})"], "details": details}
    return {"sufficient": len(top_chunks) >= MIN_RELEVANT_CHUNKS and top_chunks[0]["score"] >= CONTEXT_SCORE_THRESHOLD, "score": top_chunks[0]["score"], "reasons": [], "details": details}


def is_research_needed(top_chunks: list[dict[str, Any]], question: str, mode: str = "qdrant") -> bool:
    ctx = check_sufficient_context(top_chunks, question, mode)
    if not ctx["sufficient"]:
        return True
    q_lower = question.lower()
    if any(p in q_lower for p in WEAK_ANSWER_PATTERNS):
        return True
    if len(question.split()) < 5:
        return True
    return False


async def _search_tavily(query: str, limit: int = 5) -> list[dict[str, Any]]:
    if not config.TAVILY_API_KEY:
        raise RuntimeError("No TAVILY_API_KEY")
    body = {"api_key": config.TAVILY_API_KEY, "query": query, "search_depth": "basic", "max_results": limit, "include_answer": True, "include_raw_content": False, "include_images": False}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post("https://api.tavily.com/search", json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Tavily HTTP {r.status_code}")
    data = r.json()
    results = [{"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("content") or item.get("snippet") or "", "relevance": 1 - i * 0.1} for i, item in enumerate((data.get("results") or [])[:limit])]
    if data.get("answer"):
        results.append({"title": "Tavily AI Answer", "url": "", "snippet": data["answer"], "relevance": 0.95, "isAnswer": True})
    return results


async def _search_duckduckgo(query: str, limit: int = 5) -> list[dict[str, Any]]:
    from urllib.parse import quote_plus
    url = f"https://ddg-api.duckduckgo-stream.com/search?q={quote_plus(query)}&format=json&limit={limit}"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(url)
    results: list[dict[str, Any]] = []
    for line in r.text.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            results.append({"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("description") or item.get("snippet") or "", "relevance": item.get("relevance", 0.5)})
        except json.JSONDecodeError:
            continue
        if len(results) >= limit:
            break
    return results


def _mock_results(query: str) -> list[dict[str, Any]]:
    from urllib.parse import quote_plus
    return [{"title": f"Tìm kiếm: {query}", "url": f"https://www.google.com/search?q={quote_plus(query)}", "snippet": "Không thể kết nối đến máy chủ tìm kiếm. Vui lòng thử lại sau.", "relevance": 0.1}]


async def web_search(query: str, limit: int = 5) -> list[dict[str, Any]]:
    if config.TAVILY_API_KEY:
        try:
            return await _search_tavily(query, limit)
        except Exception as exc:
            print(f"[webSearch] Tavily failed: {exc}")
    try:
        return await _search_duckduckgo(query, limit)
    except Exception as exc:
        print(f"[webSearch] DuckDuckGo failed: {exc}")
    return _mock_results(query)


def _generate_search_queries(question: str, top_chunks: list[dict[str, Any]]) -> list[str]:
    queries = [question]
    kws = extract_keywords(question)
    if len(kws) > 2:
        queries.append(" ".join(kws[:4]))
    if top_chunks:
        queries.append(f"{question} {top_chunks[0].get('code', '')}")
    return list(dict.fromkeys(queries))[:3]


async def web_research(question: str, top_chunks: list[dict[str, Any]], mode: str = "qdrant", force_research: bool = False) -> dict[str, Any]:
    trace: dict[str, Any] = {"question": question, "topChunks": [{"code": c.get("code"), "score": c.get("score")} for c in top_chunks]}
    should_research = force_research or is_research_needed(top_chunks, question, mode)
    if not should_research:
        return {"needed": False, "results": [], "sources": [], "mergedContext": None, "trace": trace}
    print(f"[research] Triggered for: \"{question[:50]}...\"")
    queries = _generate_search_queries(question, top_chunks)
    all_results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for q in queries:
        try:
            for item in await web_search(q, 5):
                if item["url"] not in seen_urls:
                    seen_urls.add(item["url"])
                    all_results.append(item)
        except Exception:
            pass
    sources = [{"id": f"S{i+1}", "title": r["title"], "url": r["url"], "snippet": r["snippet"][:300]} for i, r in enumerate(all_results[:5])]
    web_context = "\n\n".join(f"[Nguồn {i+1}] {s['title']}\nURL: {s['url']}\nNội dung: {s['snippet']}" for i, s in enumerate(sources))
    trace["sourcesFound"] = len(sources)
    trace["queriesUsed"] = queries
    return {"needed": True, "results": all_results, "sources": sources, "mergedContext": web_context, "trace": trace}
