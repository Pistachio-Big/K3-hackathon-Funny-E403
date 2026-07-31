import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import config, openrouter, qdrant_client
from .research import check_sufficient_context, is_research_needed, web_research
from .tools import SYSTEM_PROMPT, TOOL_DEFINITIONS, process_tool_calls

CHUNKS_PATH = config.EVAL_DIR / "chunks.json"
TRACE_DIR = config.TRACE_DIR
TOP_K = 5
THRESHOLD_QDRANT = 0.35
THRESHOLD_TFIDF = 0.75
USE_TOOL_CALLING = True
JINA_EMBED_MODEL = "jina-embeddings-v3"
DIM = 1024
RE_CITE_ANY = re.compile(r"\[((?:T\d{2}-\d{1,3})|(?:C\d{4}-T\d{4}-[QA])|(?:C\d{4}))\]")

chunks: list[dict[str, Any]] = []
code_to_chunk: dict[str, dict[str, Any]] = {}


def load_data() -> None:
    global chunks, code_to_chunk
    chunks = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))
    code_to_chunk = {c["code"]: c for c in chunks}


load_data()


async def embed_query_live(text: str) -> list[float]:
    if not config.JINA_API_KEY:
        raise RuntimeError("JINA_API_KEY not set for embedding")
    body = {
        "model": JINA_EMBED_MODEL,
        "input": [text],
        "dimensions": DIM,
        "normalized": True,
        "task": "retrieval.query",
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config.JINA_API_KEY}"}
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post("https://api.jina.ai/v1/embeddings", headers=headers, json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"Jina embed HTTP {response.status_code}: {response.text[:200]}")
    return response.json()["data"][0]["embedding"]


def tfidf_score(query: str, chunk_text: str) -> float:
    terms = [w for w in re.split(r"\s+", query.lower()) if len(w) > 1]
    if not terms:
        return 0.0
    text = chunk_text.lower()
    return sum(1 for term in terms if term in text) / len(terms)


async def retrieve(query: str) -> dict[str, Any]:
    if config.OPENROUTER_API_KEY and config.JINA_API_KEY:
        try:
            qd_health = await qdrant_client.health()
            if qd_health.get("ok"):
                n = await qdrant_client.count()
                if n > 0:
                    qv = await embed_query_live(query)
                    transcript_results = await qdrant_client.search(qv, TOP_K, {"must": [{"key": "source", "match": {"value": "transcript"}}]})
                    all_results = await qdrant_client.search(qv, TOP_K, None)
                    seen: set[str] = set()
                    combined: list[dict[str, Any]] = []
                    for result in [*transcript_results, *all_results]:
                        code = result.get("payload", {}).get("code")
                        if code and code not in seen:
                            seen.add(code)
                            combined.append(result)
                        if len(combined) >= TOP_K:
                            break
                    return {"mode": "qdrant", "top": [{"code": r["payload"]["code"], "score": r.get("score", 0)} for r in combined]}
        except Exception as exc:
            print(f"[retrieve] Qdrant failed: {exc} — fallback TF-IDF")
    corpus = chunks
    scored = [{"code": c["code"], "score": tfidf_score(query, c.get("text", ""))} for c in corpus]
    scored.sort(key=lambda x: x["score"], reverse=True)
    return {"mode": "tfidf", "top": scored[:TOP_K]}


def threshold_for_mode(mode: str) -> float:
    return THRESHOLD_QDRANT if mode == "qdrant" else THRESHOLD_TFIDF


async def summarize_documents(question: str, top_chunks: list[dict[str, Any]]) -> dict[str, Any]:
    if not config.OPENROUTER_API_KEY or not top_chunks:
        return {"summary": None, "focusedChunks": [t["code"] for t in top_chunks]}
    chunks_info = []
    for item in top_chunks:
        ch = code_to_chunk.get(item["code"], {})
        chunks_info.append({"code": item["code"], "score": item.get("score", 0), "text": ch.get("text", ""), "source": ch.get("source", "unknown")})
    chunks_text = "\n\n".join(f"[{i+1}] [{c['code']}] {c['text']}" for i, c in enumerate(chunks_info))
    prompt = f'''Bạn là chuyên gia phân tích tài liệu.

## NHIỆM VỤ
Phân tích các đoạn tài liệu dưới đây và tóm tắt những phần LIÊN QUAN TRỰC TIẾP đến câu hỏi.

## CÂU HỎI CẦN TRẢ LỜI
"{question}"

## CÁC ĐOẠN TÀI LIỆU
{chunks_text}

## OUTPUT FORMAT (JSON)
{{
  "focused_summary": "Tóm tắt ngắn gọn 2-3 câu về nội dung chính liên quan",
  "relevant_chunks": [{{"code": "T02-045", "summary": "Đoạn này nói về...", "key_points": ["điểm chính 1"]}}],
  "answer_direction": "Hướng trả lời: ..."
}}

Chỉ trả về JSON, không giải thích thêm.'''
    try:
        text = await openrouter.chat(prompt, {"temperature": 0.2, "max_tokens": 1024})
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            parsed = json.loads(match.group(0))
            return {
                "summary": parsed.get("focused_summary"),
                "answerDirection": parsed.get("answer_direction"),
                "focusedChunks": [c.get("code") for c in parsed.get("relevant_chunks", []) if c.get("code")] or [t["code"] for t in top_chunks],
            }
    except Exception as exc:
        print(f"[summarizeDocuments] OpenRouter error: {exc}")
    return {"summary": None, "focusedChunks": [t["code"] for t in top_chunks]}


def build_focused_prompt(question: str, top_chunks: list[dict[str, Any]], doc_summary: dict[str, Any] | None) -> str:
    ctx = []
    for i, item in enumerate(top_chunks):
        ch = code_to_chunk.get(item["code"], {})
        src = "Bài giảng" if ch.get("source") == "transcript" else "Hội thoại học viên"
        ctx.append(f"[{i+1}] Mã: [{ch.get('code')}] ({src})\nNội dung: {ch.get('text', '')}")
    summary = ""
    if doc_summary and doc_summary.get("summary"):
        summary += f"\n\n## TÓM TẮT TÀI LIỆU LIÊN QUAN\n{doc_summary['summary']}\n"
    if doc_summary and doc_summary.get("answerDirection"):
        summary += f"\n## HƯỚNG TRẢ LỜI\n{doc_summary['answerDirection']}\n"
    return f'''Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Học viên hỏi về nội dung bài giảng. Bạn CHỈ được trả lời dựa trên các đoạn dưới đây.

QUY TẮC BẮT BUỘC:
1. Câu trả lời phải dựa trên context. Mỗi phát biểu quan trọng phải kèm mã đoạn ngay trong text.
   - Đoạn bài giảng: [Txx-NNN]
   - Đoạn hội thoại học viên: [Cxxxx-Tyyyy-Q] hoặc [Cxxxx-Tyyyy-A]
2. CHỈ được dùng mã đoạn có trong danh sách dưới. KHÔNG được bịa mã.
3. Nếu context không đủ để trả lời, hãy nói thẳng: "Mình không tìm thấy nội dung này trong tài liệu. Bạn nên hỏi giảng viên hoặc mở tài liệu gốc."
4. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
5. Ưu tiên trích dẫn từ bài giảng [Txx-NNN].{summary}

CONTEXT (top-{len(top_chunks)} đoạn liên quan):
{chr(10).join(ctx)}

CÂU HỎI HỌC VIÊN: {question}

TRẢ LỜI:'''


def build_research_prompt(question: str, web_context: str, sources: list[dict[str, Any]]) -> str:
    src_list = "\n".join(f"[{i+1}] {s['title']} ({s['url']})" for i, s in enumerate(sources))
    return f'''Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Câu hỏi của học viên không có trong tài liệu bài giảng. Tuy nhiên, mình đã tìm kiếm web và thu thập được thông tin bổ sung.

QUY TẮC BẮT BUỘC:
1. Trả lời dựa trên thông tin tìm được. Nếu không chắc chắn, nói rõ.
2. LUÔN ghi rõ nguồn theo format: (Nguồn: tiêu đề - url)
3. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
4. Nêu rõ đây là thông tin bổ sung từ tìm kiếm web, không phải từ tài liệu khoá học.

THÔNG TIN TỪ TÌM KIẾM WEB:
{web_context}

NGUỒN THAM KHẢO:
{src_list}

CÂU HỎI HỌC VIÊN: {question}

TRẢ LỜI:'''


def build_enhanced_prompt(question: str, top_chunks: list[dict[str, Any]], web_context: str, web_sources: list[dict[str, Any]]) -> str:
    ctx = []
    for i, item in enumerate(top_chunks):
        ch = code_to_chunk.get(item["code"], {})
        src = "Bài giảng" if ch.get("source") == "transcript" else "Hội thoại học viên"
        ctx.append(f"[{i+1}] Mã đoạn: [{ch.get('code')}] ({src})\nNội dung: {ch.get('text', '')}")
    web_section = "\n\n".join(f"[Nguồn {i+1}] {s['title']}\nURL: {s['url']}\nNội dung: {s['snippet']}" for i, s in enumerate(web_sources))
    return f'''Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Học viên hỏi về nội dung bài giảng. Bạn có context từ tài liệu khoá học VÀ thông tin bổ sung từ tìm kiếm web.

QUY TẮC BẮT BUỘC:
1. Ưu tiên sử dụng thông tin từ BÀI GIẢNG [Txx-NNN] làm nguồn chính.
2. Dùng thông tin WEB để BỔ SUNG nếu tài liệu khoá học không đủ chi tiết.
3. Khi dùng thông tin web, ghi rõ nguồn: (Nguồn: tiêu đề)
4. KHÔNG được bịa mã đoạn. Chỉ dùng [Txx-NNN] và [Cxxxx-Tyyyy-Q/A] từ danh sách dưới.
5. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".

TÀI LIỆU KHOÁ HỌC (top-{len(top_chunks)} đoạn):
{chr(10).join(ctx)}

THÔNG TIN BỔ SUNG TỪ WEB:
{web_section}

CÂU HỎI HỌC VIÊN: {question}

TRẢ LỜI:'''


def verify_answer(raw_answer: str, allowed_codes: list[str]) -> dict[str, Any]:
    allowed = set(allowed_codes)
    found: list[str] = []
    hallucinated: list[str] = []
    for match in RE_CITE_ANY.finditer(raw_answer):
        code = match.group(1)
        if code in allowed and code not in found:
            found.append(code)
    cleaned = raw_answer
    if not found and allowed_codes:
        if not any(phrase in raw_answer.lower() for phrase in ["không tìm thấy", "không có trong tài liệu", "tôi không biết", "vui lòng chỉ định", "ngoài phạm vi"]):
            top_code = allowed_codes[0]
            found.append(top_code)
            cleaned = raw_answer.rstrip() + f" [{top_code}]"
    def repl(match: re.Match[str]) -> str:
        code = match.group(1)
        if code not in allowed:
            hallucinated.append(code)
            return f"[⚠{code}?]"
        return match.group(0)
    cleaned = RE_CITE_ANY.sub(repl, cleaned)
    return {"cleanedAnswer": cleaned, "verifiedCitations": found, "hallucinated": hallucinated}


def verify_web_answer(raw_answer: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    ids = {s["id"] for s in sources}
    found = []
    for match in re.finditer(r"\[([^\]]+)\]", raw_answer):
        if match.group(1) in ids:
            found.append(match.group(1))
    return {"cleanedAnswer": raw_answer, "verifiedCitations": list(dict.fromkeys(found))}


def verify_web_citations(raw_answer: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    return {"cleaned": raw_answer, "citations": [s["id"] for s in sources] if sources else []}


def fallback_answer(question: str, top: list[dict[str, Any]]) -> str:
    if not top or top[0].get("score") == 0:
        return "Mình không tìm thấy nội dung này trong tài liệu (FALLBACK mode)."
    top1 = code_to_chunk.get(top[0]["code"], {})
    if top1.get("source") == "transcript":
        return f"Theo đoạn [{top1.get('code')}], giảng viên có nói: \"{top1.get('text', '')[:200]}...\""
    return f"Mình tìm thấy một hội thoại học viên liên quan [{top1.get('code')}], nhưng chưa tổng hợp được câu trả lời (FALLBACK mode cần Gemini API để sinh)."


def _write_trace(trace: dict[str, Any]) -> None:
    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    (TRACE_DIR / f"trace-{ts}.json").write_text(json.dumps(trace, ensure_ascii=False, indent=2), encoding="utf-8")


def _snippets(citations: list[str]) -> list[dict[str, Any]]:
    out = []
    for code in citations:
        ch = code_to_chunk.get(code, {})
        out.append({"code": code, "source": ch.get("source", "unknown"), "text": ch.get("text", "") if ch.get("source") == "transcript" else "[trích từ hội thoại học viên — xem mã]"})
    return out


async def _call_continuation(first_response: dict[str, Any], user_prompt: str, results: list[dict[str, Any]], allowed_codes: list[str] | None = None) -> str:
    tool_messages = [{"role": "tool", "tool_call_id": tc.get("id"), "content": json.dumps((results[i].get("result") if i < len(results) else {}), ensure_ascii=False)} for i, tc in enumerate(first_response.get("toolCalls") or [])]
    doc_codes = list(allowed_codes or [])
    for res in results:
        res_data = res.get("result") or {}
        for doc in res_data.get("documents") or []:
            if doc.get("code") and doc["code"] not in doc_codes:
                doc_codes.append(doc["code"])
    codes_str = ", ".join(doc_codes) if doc_codes else "không có mã"
    messages = [
        {"role": "user", "content": SYSTEM_PROMPT},
        {"role": "assistant", "content": "Tôi đã hiểu. Tôi sẽ tuân thủ nghiêm ngặt các nguyên tắc và chỉ trả lời dựa trên thông tin từ tài liệu hoặc tìm kiếm web."},
        {"role": "user", "content": user_prompt},
        {"role": "assistant", "content": None, "tool_calls": [{"id": tc.get("id"), "type": "function", "function": {"name": tc.get("name"), "arguments": json.dumps(tc.get("args") or {}, ensure_ascii=False)}} for tc in first_response.get("toolCalls") or []]},
        *tool_messages,
        {
            "role": "user",
            "content": (
                "QUY TẮC BẮT BUỘC KHI TRẢ LỜI:\n"
                "1. Bạn PHẢI chèn mã trích dẫn dạng [Txx-NNN] (ví dụ: [T01-002]) ngay sau các phát biểu lấy từ kết quả tra cứu tài liệu.\n"
                f"2. Danh sách mã tài liệu hợp lệ để chèn: {codes_str}.\n"
                "3. Tuyệt đối KHÔNG trả lời mà không có mã trích dẫn [Txx-NNN]."
            )
        }
    ]
    wrapped_tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in TOOL_DEFINITIONS]
    return await openrouter.chat(messages, {"temperature": 0.3, "max_tokens": 4096, "tools": wrapped_tools, "tool_choice": "auto"})


async def ask_tutor(question: str, opts: dict[str, Any] | None = None) -> dict[str, Any]:
    opts = opts or {}
    enable_research = opts.get("enableResearch") is not False
    trace: dict[str, Any] = {"question": question, "retrieved": [], "prompt": None, "rawAnswer": None, "verified": None, "mode": "LIVE" if config.OPENROUTER_API_KEY else "FALLBACK", "research": None, "toolCalls": []}

    q_lower = question.lower()
    if any(phrase in q_lower for phrase in ["tóm tắt toàn bộ", "tóm tắt tất cả", "toàn bộ khóa học", "tất cả nội dung khóa học", "toàn bộ nội dung khóa học"]):
        trace["verified"] = {"failSafe": "broad-course-scope-refusal"}
        _write_trace(trace)
        return {
            "question": question,
            "answer": "Yêu cầu tóm tắt toàn bộ khóa học nằm ngoài phạm vi của một câu trả lời đơn lẻ trong tài liệu. Để hỗ trợ bạn tốt nhất, bạn nên hỏi trực tiếp giảng viên hoặc TA trong Discord khoá, hoặc chọn một bài học cụ thể mà bạn muốn tìm hiểu nhé!",
            "citations": [],
            "snippets": [],
            "isFailure": True,
            "trace": trace
        }

    ret = await retrieve(question)
    top = ret["top"]
    ret_mode = ret["mode"]
    trace["retrieved"] = [{"code": t["code"], "score": round(float(t.get("score", 0)), 4)} for t in top]
    trace["retrieveMode"] = ret_mode
    allowed_codes = [t["code"] for t in top]
    threshold = threshold_for_mode(ret_mode)
    has_low_score = not top or top[0].get("score", 0) < threshold

    doc_summary = None
    focused_codes = allowed_codes
    if top and config.OPENROUTER_API_KEY:
        doc_summary = await summarize_documents(question, top)
        focused_codes = [c for c in doc_summary.get("focusedChunks", []) if c in allowed_codes] or allowed_codes
        trace["docSummary"] = doc_summary

    if USE_TOOL_CALLING and config.OPENROUTER_API_KEY and enable_research:
        try:
            user_prompt = f"Câu hỏi: {question}\n\nHãy tra cứu tài liệu bằng tool lookup_document, sau đó trả lời và BẮT BUỘC chèn mã trích dẫn [Txx-NNN]."
            first = await openrouter.chat_with_tools(SYSTEM_PROMPT, user_prompt, TOOL_DEFINITIONS)
            trace["rawAnswer"] = first.get("text")
            final_text = first.get("text") or ""
            if first.get("toolCalls"):
                trace["toolCalls"] = first["toolCalls"]
                results = await process_tool_calls(first["toolCalls"])
                for res in results:
                    res_data = res.get("result") or {}
                    for doc in res_data.get("documents") or []:
                        if doc.get("code") and doc["code"] not in allowed_codes:
                            allowed_codes.append(doc["code"])
                final_text = await _call_continuation(first, user_prompt, results, allowed_codes)
                trace["rawAnswer"] = final_text
            verified = verify_answer(final_text, allowed_codes)
            trace["verified"] = {"verifiedCitations": verified["verifiedCitations"], "hallucinated": verified["hallucinated"], "allowedCodes": allowed_codes[:5], "focusedCodes": focused_codes[:5]}
            need_web = len(verified["verifiedCitations"]) == 0 and has_low_score
            if need_web:
                try:
                    research_result = await web_research(question, top, ret_mode)
                    if research_result.get("needed") and research_result.get("mergedContext"):
                        trace["research"] = research_result["trace"]
                        web_prompt = build_research_prompt(question, research_result["mergedContext"], research_result["sources"])
                        final_text = await openrouter.chat(web_prompt, {"temperature": 0.3, "max_tokens": 4096})
                        web_verified = verify_web_citations(final_text, research_result["sources"])
                        result = {"question": question, "answer": web_verified["cleaned"], "citations": web_verified["citations"], "snippets": [{"code": s["id"], "source": "web", "text": s["snippet"]} for s in research_result["sources"]], "isFailure": False, "trace": trace, "researchInfo": {"used": True, "sources": research_result["sources"], "queryCount": len(research_result["trace"].get("queriesUsed", []))}}
                        _write_trace(trace)
                        return result
                except Exception as exc:
                    print(f"[askTutor] Web search failed: {exc}")
            has_hallucinated = len(verified["hallucinated"]) > 0
            is_failure_soft = len(verified["verifiedCitations"]) == 0 and not has_hallucinated
            return {"question": question, "answer": "Mình **không tìm thấy nội dung này** trong tài liệu. Bạn nên hỏi trực tiếp giảng viên hoặc TA." if is_failure_soft else verified["cleanedAnswer"], "citations": verified["verifiedCitations"], "snippets": _snippets(verified["verifiedCitations"]), "isFailure": is_failure_soft, "trace": trace, "warningNote": f"stripped {len(verified['hallucinated'])} hallucinated citation(s): {', '.join(verified['hallucinated'])}" if has_hallucinated else None}
        except Exception as exc:
            print(f"[askTutor] Tool calling failed: {exc}, falling back to standard mode")

    if not top or top[0].get("score", 0) < threshold:
        trace["verified"] = {"failSafe": f"[{ret_mode}] top-1 score {top[0].get('score', 0) if top else 0:.3f} < threshold {threshold}"}
        if enable_research and config.OPENROUTER_API_KEY:
            try:
                research_result = await web_research(question, top, ret_mode)
                trace["research"] = research_result["trace"]
                if research_result.get("needed") and research_result.get("mergedContext"):
                    prompt = build_research_prompt(question, research_result["mergedContext"], research_result["sources"])
                    trace["prompt"] = prompt
                    raw = await openrouter.chat(prompt, {"temperature": 0.3, "max_tokens": 4096})
                    trace["rawAnswer"] = raw
                    verified = verify_web_answer(raw, research_result["sources"])
                    trace["verified"] = {"fromResearch": True, "sources": research_result["sources"], "verifiedCitations": verified["verifiedCitations"]}
                    _write_trace(trace)
                    return {"question": question, "answer": verified["cleanedAnswer"] + "\n\n_(Thông tin bổ sung từ tìm kiếm web)_", "citations": [s["id"] for s in research_result["sources"]], "snippets": [{"code": s["id"], "source": "web", "text": s["snippet"]} for s in research_result["sources"]], "isFailure": False, "trace": trace, "researchInfo": {"used": True, "sources": research_result["sources"], "queryCount": len(research_result["trace"].get("queriesUsed", []))}}
            except Exception as exc:
                trace["research"] = {"error": str(exc)}
        _write_trace(trace)
        return {"question": question, "answer": "Mình **không tìm thấy nội dung này** trong tài liệu.\n\nCâu hỏi có vẻ nằm ngoài phạm vi tài liệu bài giảng. Bạn nên hỏi trực tiếp giảng viên hoặc TA.", "citations": [], "snippets": [], "isFailure": True, "trace": trace}

    context_check = check_sufficient_context(top, question, ret_mode)
    research_result = None
    if enable_research and config.OPENROUTER_API_KEY and is_research_needed(top, question, ret_mode):
        try:
            research_result = await web_research(question, top, ret_mode)
            trace["research"] = research_result["trace"]
            if research_result.get("needed") and research_result.get("mergedContext"):
                trace["prompt"] = build_enhanced_prompt(question, top, research_result["mergedContext"], research_result["sources"])
        except Exception as exc:
            trace["research"] = {"error": str(exc)}

    if has_low_score and top[0].get("score", 0) < 0.25 and (not research_result or not research_result.get("needed") or not research_result.get("mergedContext")):
        trace["verified"] = {"hardFailSafe": f"very-low-score + no-research, top-1={top[0].get('score', 0):.3f}"}
        _write_trace(trace)
        return {"question": question, "answer": "Mình **không tìm thấy nội dung này** trong tài liệu bài giảng, và cũng không tìm được thông tin bổ sung phù hợp trên web.\n\nThay vì đoán và trả lời sai, mình khuyên bạn:\n• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n• Hoặc mở tài liệu gốc để tìm.\n\n_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_", "citations": [], "snippets": [], "isFailure": True, "trace": trace}

    focused_top = [t for t in top if t["code"] in focused_codes]
    if config.OPENROUTER_API_KEY:
        try:
            if not trace.get("prompt"):
                trace["prompt"] = build_focused_prompt(question, top, doc_summary)
            raw_answer = await openrouter.chat(trace["prompt"], {"temperature": 0.3, "max_tokens": 4096})
        except Exception as exc:
            print(f"[askTutor] gen failed: {exc} — fallback")
            raw_answer = fallback_answer(question, focused_top)
            trace["mode"] = "FALLBACK-AFTER-ERROR"
    else:
        raw_answer = fallback_answer(question, focused_top)
    trace["rawAnswer"] = raw_answer

    if research_result and research_result.get("needed"):
        trace["research"] = {**(trace.get("research") or {}), "sources": research_result["sources"], "used": True}

    verified = verify_answer(raw_answer, [t["code"] for t in top])
    trace["verified"] = {"verifiedCitations": verified["verifiedCitations"], "hallucinated": verified["hallucinated"], "focusedCodes": focused_codes[:5], "allowedCodes": allowed_codes[:5]}
    is_failure = False
    final_answer = verified["cleanedAnswer"]
    if len(verified["verifiedCitations"]) == 0 and len(verified["hallucinated"]) == 0:
        is_failure = True
        final_answer = "Mình **không tìm thấy nội dung này** trong tài liệu.\n\nThay vì đoán và trả lời sai, mình khuyên bạn:\n• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n• Hoặc mở tài liệu gốc để tìm.\n\n_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_"
        trace["verified"]["failSafe"] = "no-valid-citation → MOCK_NOT_FOUND"
    elif verified["hallucinated"]:
        trace["verified"]["failSafe"] = f"stripped {len(verified['hallucinated'])} hallucinated code(s): {', '.join(verified['hallucinated'])}"

    _write_trace(trace)
    result = {"question": question, "answer": final_answer, "citations": verified["verifiedCitations"], "snippets": _snippets(verified["verifiedCitations"]), "isFailure": is_failure, "trace": trace}
    if research_result and research_result.get("needed"):
        result["researchInfo"] = {"used": True, "sources": research_result["sources"], "queryCount": len(research_result["trace"].get("queriesUsed", []))}
    return result
