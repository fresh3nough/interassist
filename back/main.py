"""InterAssist backend — live interview audio assistant via OpenRouter."""

from __future__ import annotations

import logging
import json
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [InterAssist] %(levelname)s %(message)s",
)
logger = logging.getLogger("interassist")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "x-ai/grok-4.5")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

SYSTEM_PROMPT = """You are InterAssist, a live coding interview co-pilot.
You receive rolling transcript chunks from an interview conversation.

Respond with ONLY valid JSON (no markdown fences) using this exact shape:
{
  "transcript_note": "optional short clarification or empty string",
  "is_coding": true or false,
  "is_question": true or false,
  "answer_flash": "short direct answer if a question was asked, else empty string",
  "talking_points": ["bullet", "bullet"],
  "code": {
    "language": "python|javascript|typescript|go|etc or empty",
    "filename": "suggested filename or empty",
    "content": "full code draft or empty string",
    "update": true or false
  }
}

Rules:
- is_coding true when the conversation is about writing/debugging/designing code.
- Only put code in code.content when is_coding is true and there is enough signal to draft something useful.
- code.update true only when the code draft should replace the previous one.
- answer_flash must be concise and interview-ready when is_question is true.
- talking_points are things the candidate can say next (max 5 short bullets).
- Prefer practical, correct, concise output. No fluff.
"""


class AnalyzeRequest(BaseModel):
    """HTTP fallback payload for transcript analysis."""

    transcript: str = Field(..., min_length=1)
    prior_code: str = ""
    model: str | None = None


class AnalyzeResponse(BaseModel):
    """Structured assistant output."""

    transcript_note: str = ""
    is_coding: bool = False
    is_question: bool = False
    answer_flash: str = ""
    talking_points: list[str] = Field(default_factory=list)
    code: dict[str, Any] = Field(default_factory=dict)
    model: str = ""


def _empty_result(model: str) -> dict[str, Any]:
    return {
        "transcript_note": "",
        "is_coding": False,
        "is_question": False,
        "answer_flash": "",
        "talking_points": [],
        "code": {
            "language": "",
            "filename": "",
            "content": "",
            "update": False,
        },
        "model": model,
    }


def _parse_model_json(raw: str, model: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            result = _empty_result(model)
            result["transcript_note"] = "Model returned non-JSON output."
            return result
        data = json.loads(text[start : end + 1])

    base = _empty_result(model)
    base["transcript_note"] = str(data.get("transcript_note") or "")
    base["is_coding"] = bool(data.get("is_coding"))
    base["is_question"] = bool(data.get("is_question"))
    base["answer_flash"] = str(data.get("answer_flash") or "")
    points = data.get("talking_points") or []
    if isinstance(points, list):
        base["talking_points"] = [str(p).strip() for p in points if str(p).strip()][:5]
    code = data.get("code") or {}
    if isinstance(code, dict):
        base["code"] = {
            "language": str(code.get("language") or ""),
            "filename": str(code.get("filename") or ""),
            "content": str(code.get("content") or ""),
            "update": bool(code.get("update")),
        }
    return base


async def call_openrouter(
    client: httpx.AsyncClient,
    transcript: str,
    prior_code: str = "",
    model: str | None = None,
) -> dict[str, Any]:
    """Send transcript context to OpenRouter and return structured JSON."""
    selected = (model or OPENROUTER_MODEL).strip() or OPENROUTER_MODEL
    if not OPENROUTER_API_KEY:
        result = _empty_result(selected)
        result["transcript_note"] = "OPENROUTER_API_KEY is missing."
        return result

    user_payload = {
        "latest_transcript": transcript[-8000:],
        "prior_code": prior_code[-6000:] if prior_code else "",
    }

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "InterAssist",
    }
    body = {
        "model": selected,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(user_payload),
            },
        ],
    }

    try:
        logger.info(
            "openrouter analyze model=%s transcript_chars=%s prior_code_chars=%s",
            selected,
            len(transcript or ""),
            len(prior_code or ""),
        )
        resp = await client.post(
            f"{OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
            headers=headers,
            json=body,
            timeout=60.0,
        )
        logger.info(
            "openrouter analyze status=%s body_preview=%s",
            resp.status_code,
            (resp.text or "")[:500],
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
        logger.info(
            "openrouter analyze content_preview=%s",
            str(content)[:400],
        )
        return _parse_model_json(content, selected)
    except Exception as exc:  # noqa: BLE001 - surface soft failure to UI
        logger.exception("openrouter analyze failed: %s", exc)
        result = _empty_result(selected)
        result["transcript_note"] = f"OpenRouter error: {exc}"
        return result


async def transcribe_audio_chunk(
    client: httpx.AsyncClient,
    audio_b64: str,
    mime_type: str = "audio/webm",
    model: str | None = None,
) -> str:
    """Best-effort audio transcription via OpenRouter multimodal chat."""
    selected = (model or OPENROUTER_MODEL).strip() or OPENROUTER_MODEL
    if not OPENROUTER_API_KEY or not audio_b64:
        return ""

    # Many OpenRouter models accept audio as an input_audio part.
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "InterAssist",
    }
    body = {
        "model": selected,
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Transcribe the interview audio. Return plain text only. "
                    "No timestamps, no speaker labels unless clearly useful, no commentary."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Transcribe this audio chunk from a live interview.",
                    },
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": audio_b64,
                            "format": "wav" if "wav" in mime_type else "webm",
                        },
                    },
                ],
            },
        ],
    }

    try:
        logger.info(
            "openrouter transcribe model=%s audio_b64_len=%s mime=%s",
            selected,
            len(audio_b64 or ""),
            mime_type,
        )
        resp = await client.post(
            f"{OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
            headers=headers,
            json=body,
            timeout=90.0,
        )
        logger.info(
            "openrouter transcribe status=%s body_preview=%s",
            resp.status_code,
            (resp.text or "")[:500],
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
                else:
                    parts.append(str(item))
            text = " ".join(p.strip() for p in parts if p and str(p).strip()).strip()
        else:
            text = str(content or "").strip()
        logger.info("openrouter transcribe text_preview=%s", text[:300])
        return text
    except Exception as exc:
        logger.exception("openrouter transcribe failed: %s", exc)
        return ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient()
    yield
    await app.state.http.aclose()


app = FastAPI(title="InterAssist", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": OPENROUTER_MODEL,
        "has_key": bool(OPENROUTER_API_KEY),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "default_model": OPENROUTER_MODEL,
        "models": [
            "x-ai/grok-4.5",
            "x-ai/grok-4",
            "openai/gpt-4.1",
            "openai/gpt-4o-mini",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.5-flash",
        ],
    }


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    data = await call_openrouter(
        app.state.http,
        transcript=req.transcript,
        prior_code=req.prior_code,
        model=req.model,
    )
    return AnalyzeResponse(**data)


@app.websocket("/ws")
async def interview_ws(ws: WebSocket) -> None:
    await ws.accept()
    full_transcript: list[str] = []
    prior_code = ""
    model = OPENROUTER_MODEL

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            mtype = msg.get("type")
            logger.info(
                "ws recv type=%s keys=%s",
                mtype,
                list(msg.keys()),
            )

            if mtype == "config":
                model = (msg.get("model") or model).strip() or model
                await ws.send_json({"type": "config_ok", "model": model})
                continue

            if mtype == "reset":
                full_transcript = []
                prior_code = ""
                await ws.send_json({"type": "reset_ok"})
                continue

            if mtype == "transcript":
                text = str(msg.get("text") or "").strip()
                logger.info("ws transcript text=%s", text[:300])
                if not text:
                    continue
                full_transcript.append(text)
                joined = " ".join(full_transcript)[-12000:]
                result = await call_openrouter(
                    app.state.http,
                    transcript=joined,
                    prior_code=prior_code,
                    model=model,
                )
                if result.get("code", {}).get("update") and result["code"].get("content"):
                    prior_code = result["code"]["content"]
                await ws.send_json(
                    {
                        "type": "analysis",
                        "transcript": text,
                        "full_transcript": joined,
                        **result,
                    }
                )
                continue

            if mtype == "audio_chunk":
                audio_b64 = str(msg.get("audio_b64") or "")
                mime_type = str(msg.get("mime_type") or "audio/webm")
                logger.info(
                    "ws audio_chunk mime=%s b64_len=%s",
                    mime_type,
                    len(audio_b64),
                )
                text = await transcribe_audio_chunk(
                    app.state.http,
                    audio_b64=audio_b64,
                    mime_type=mime_type,
                    model=model,
                )
                if not text:
                    await ws.send_json(
                        {
                            "type": "transcript_partial",
                            "text": "",
                            "note": "No transcript from audio chunk (model may not support audio).",
                        }
                    )
                    continue

                full_transcript.append(text)
                joined = " ".join(full_transcript)[-12000:]
                result = await call_openrouter(
                    app.state.http,
                    transcript=joined,
                    prior_code=prior_code,
                    model=model,
                )
                if result.get("code", {}).get("update") and result["code"].get("content"):
                    prior_code = result["code"]["content"]
                await ws.send_json(
                    {
                        "type": "analysis",
                        "transcript": text,
                        "full_transcript": joined,
                        **result,
                    }
                )
                continue

            await ws.send_json({"type": "error", "message": f"Unknown type: {mtype}"})
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
