import json
from typing import Any

import httpx

from . import config

BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL_GEN = config.EVAL_MODEL


def _headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "HTTP-Referer": "https://vlearn.example.com",
        "X-Title": "VLearn Tutor",
    }


async def chat(messages: str | list[dict[str, Any]], options: dict[str, Any] | None = None) -> str:
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    body: dict[str, Any] = {"model": MODEL_GEN, "messages": messages}
    if options:
        body.update(options)
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(BASE_URL, headers=_headers(), json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"OpenRouter HTTP {response.status_code}: {response.text[:500]}")
    data = response.json()
    return data.get("choices", [{}])[0].get("message", {}).get("content") or ""


async def chat_with_tools(system_prompt: str, user_prompt: str, tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    body: dict[str, Any] = {
        "model": MODEL_GEN,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4096,
    }
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["parameters"],
                },
            }
            for tool in tools
        ]
        body["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(BASE_URL, headers=_headers(), json=body)
    if response.status_code >= 400:
        raise RuntimeError(f"OpenRouter HTTP {response.status_code}: {response.text[:500]}")
    message = response.json().get("choices", [{}])[0].get("message", {})
    tool_calls = []
    for call in message.get("tool_calls") or []:
        raw_args = call.get("function", {}).get("arguments") or "{}"
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError:
            args = {}
        tool_calls.append({
            "id": call.get("id"),
            "name": call.get("function", {}).get("name"),
            "args": args,
        })
    return {"text": message.get("content") or "", "toolCalls": tool_calls or None}
