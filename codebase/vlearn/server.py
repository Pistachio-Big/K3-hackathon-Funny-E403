import json
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.templating import Jinja2Templates

from . import config, mock_data, qdrant_client
from .rag import retrieve, ask_tutor

BASE_DIR = Path(__file__).resolve().parents[1]
TEMPLATES = Jinja2Templates(directory=str(BASE_DIR / "templates"))
CITE_RE = re.compile(r"\[((?:T\d{2}-\d{1,3})|(?:C\d{4}-T\d{4}-[QA])|(?:C\d{4})|(?:S\d+))\]")

app = FastAPI(title="VLearn Tutor", version="2.0.0")


def _citation_href(code: str) -> str:
    if code.startswith("T"):
        return f"/mock-transcripts.html#{code.lower()}"
    if code.startswith("S"):
        return f"#source-{code}"
    return f"#chatlog-{code}"


def _segments(text: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    pos = 0
    for match in CITE_RE.finditer(text or ""):
        if match.start() > pos:
            parts.append({"type": "text", "text": text[pos:match.start()]})
        code = match.group(1)
        parts.append({"type": "cite", "code": code, "href": _citation_href(code)})
        pos = match.end()
    if pos < len(text or ""):
        parts.append({"type": "text", "text": text[pos:]})
    return parts


def _mock_result(entry: dict[str, Any], question: str) -> dict[str, Any]:
    citations = entry.get("citations", [])
    snippets = []
    for code in citations:
        key = f"snippet_{code.lower().replace('-', '_')}"
        if entry.get(key):
            snippets.append({"code": code, "source": "transcript", "text": entry[key]})
    return {
        "question": question,
        "answer": entry.get("answer", ""),
        "citations": citations,
        "snippets": snippets,
        "isFailure": bool(entry.get("isFailure")),
        "trace": None,
    }


def _hydrate_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    hydrated = []
    for msg in messages:
        item = dict(msg)
        if item.get("role") == "assistant":
            result = item.get("result") or {}
            item["segments"] = _segments(result.get("answer", item.get("content", "")))
            item["snippets"] = result.get("snippets") or []
            item["webSources"] = result.get("webSources") or result.get("researchInfo", {}).get("sources") or []
            item["isFailure"] = result.get("isFailure", False)
            item["trace"] = result.get("trace")
            item["trace_json"] = json.dumps({
                "retrieved": (result.get("trace") or {}).get("retrieved"),
                "verified": (result.get("trace") or {}).get("verified"),
                "research": result.get("researchInfo") or (result.get("trace") or {}).get("research"),
            }, ensure_ascii=False, indent=2)
        hydrated.append(item)
    return hydrated


def _parse_history(history: str | None) -> list[dict[str, Any]]:
    if not history:
        return []
    try:
        data = json.loads(history)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _render_home(request: Request, messages: list[dict[str, Any]] | None = None, mode: str = "mock", error: str | None = None) -> HTMLResponse:
    messages = messages or []
    return TEMPLATES.TemplateResponse(
        "index.html",
        {
            "request": request,
            "messages": _hydrate_messages(messages),
            "history_json": json.dumps(messages, ensure_ascii=False),
            "mode": mode if mode in {"mock", "ai"} else "mock",
            "error": error,
            "suggested_questions": mock_data.SUGGESTED_QUESTIONS,
        },
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request, mode: str = "mock") -> HTMLResponse:
    return _render_home(request, mode=mode)


@app.post("/ask", response_class=HTMLResponse)
async def ask_form(request: Request, question: str = Form(...), mode: str = Form("mock"), history: str = Form("[]")) -> HTMLResponse:
    messages = _parse_history(history)
    question = question.strip()
    if not question:
        return _render_home(request, messages, mode, "Thiếu câu hỏi")
    messages.append({"role": "user", "content": question})
    try:
        if mode == "ai":
            result = await ask_tutor(question)
        else:
            result = _mock_result(mock_data.find_mock_answer(question), question)
        messages.append({"role": "assistant", "content": result["answer"], "result": result})
        return _render_home(request, messages, mode)
    except Exception as exc:
        result = {"question": question, "answer": f"⚠ Lỗi: {exc}", "citations": [], "snippets": [], "isFailure": True, "trace": None}
        messages.append({"role": "assistant", "content": result["answer"], "result": result})
        return _render_home(request, messages, mode)


@app.post("/api/retrieve")
async def api_retrieve(payload: dict[str, Any]) -> JSONResponse:
    question = payload.get("question")
    top_k = int(payload.get("topK", 5))
    if not question:
        raise HTTPException(status_code=400, detail="Thiếu 'question'")
    ret = await retrieve(question)
    top_array = ret.get("top", []) if isinstance(ret, dict) else ret
    return JSONResponse({"retrieved": top_array[:top_k], "mode": ret.get("mode", "unknown") if isinstance(ret, dict) else "unknown"})


@app.post("/api/ask")
async def api_ask(payload: dict[str, Any]) -> JSONResponse:
    question = payload.get("question")
    top = payload.get("top")
    if not question or not isinstance(top, list):
        raise HTTPException(status_code=400, detail="Thiếu 'question' hoặc 'top' (array of codes)")
    if not config.OPENROUTER_API_KEY:
        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY chưa set — điền vào codebase/eval/.env")
    return JSONResponse(await ask_tutor(question))


@app.post("/api/research")
async def api_research(payload: dict[str, Any]) -> JSONResponse:
    from .research import check_sufficient_context, is_research_needed, web_research

    question = payload.get("question")
    if not question:
        raise HTTPException(status_code=400, detail="Thiếu 'question'")
    top_chunks = payload.get("topChunks") or []
    force_research = bool(payload.get("forceResearch", False))
    analysis = {
        "contextCheck": check_sufficient_context(top_chunks, question, "qdrant") if top_chunks else None,
        "shouldResearch": is_research_needed(top_chunks, question, "qdrant") if top_chunks else True,
    }
    if force_research or analysis["shouldResearch"]:
        result = await web_research(question, top_chunks, "qdrant", force_research)
        return JSONResponse({**analysis, "research": {"needed": result["needed"], "sources": result["sources"], "mergedContext": result["mergedContext"]}})
    return JSONResponse({**analysis, "research": {"needed": False, "sources": [], "mergedContext": None}})


@app.get("/api/health")
async def api_health() -> JSONResponse:
    qd_health = await qdrant_client.health()
    qd_count = 0
    if qd_health.get("ok"):
        try:
            qd_count = await qdrant_client.count()
        except Exception:
            qd_count = 0
    return JSONResponse({"ok": True, "hasOpenRouterKey": bool(config.OPENROUTER_API_KEY), "hasJinaKey": bool(config.JINA_API_KEY), "qdrant": {**qd_health, "vectors": qd_count, "collection": qdrant_client.COLLECTION}})


@app.get("/{path:path}")
async def static_file(path: str):
    if ".env" in path or path.startswith("data/") or "/data/" in path:
        return PlainTextResponse("Forbidden", status_code=403)
    file_path = (BASE_DIR / path).resolve()
    if not str(file_path).startswith(str(BASE_DIR.resolve())) or not file_path.exists() or file_path.is_dir():
        return PlainTextResponse("Not found", status_code=404)
    return FileResponse(file_path)
