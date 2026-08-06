"""InterAssist backend — live interview audio assistant via OpenRouter."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
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
OPENROUTER_STT_MODEL = os.getenv("OPENROUTER_STT_MODEL", "openai/whisper-1")
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

NOISE_RE = re.compile(
    r"^(thanks for watching[.!]?|thank you for watching[.!]?|subscribe[.!]?|"
    r"please subscribe[.!]?|music|\[music\]|\(music\)|\.|\.\.\.|…)$",
    re.I,
)


class AnalyzeRequest(BaseModel):
    transcript: str = Field(..., min_length=1)
    prior_code: str = ""
    model: str | None = None


class AnalyzeResponse(BaseModel):
    transcript_note: str = ""
    is_coding: bool = False
    is_question: bool = False
    answer_flash: str = ""
    talking_points: list[str] = Field(default_factory=list)
    code: dict[str, Any] = Field(default_factory=dict)
    model: str = ""


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "InterAssist",
    }


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
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            result = _empty_result(model)
            result["transcript_note"] = "Model returned non-JSON output."
            return result

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


def _audio_format(mime_type: str) -> str:
    mt = (mime_type or "").lower()
    if "wav" in mt:
        return "wav"
    if "mpeg" in mt or "mp3" in mt:
        return "mp3"
    if "mp4" in mt or "m4a" in mt:
        return "m4a"
    if "ogg" in mt:
        return "ogg"
    if "flac" in mt:
        return "flac"
    if "aac" in mt:
        return "aac"
    return "webm"


def _clean_transcript(text: str) -> str:
    t = " ".join((text or "").split()).strip()
    if not t:
        return ""
    if NOISE_RE.match(t):
        return ""
    # drop ultra-short garbage
    if len(t) < 2:
        return ""
    return t


async def call_openrouter(
    client: httpx.AsyncClient,
    transcript: str,
    prior_code: str = "",
    model: str | None = None,
) -> dict[str, Any]:
    selected = (model or OPENROUTER_MODEL).strip() or OPENROUTER_MODEL
    if not OPENROUTER_API_KEY:
        result = _empty_result(selected)
        result["transcript_note"] = "OPENROUTER_API_KEY is missing."
        return result

    user_payload = {
        "latest_transcript": transcript[-8000:],
        "prior_code": prior_code[-6000:] if prior_code else "",
    }
    body = {
        "model": selected,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
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
            headers=_headers(),
            json=body,
            timeout=60.0,
        )
        logger.info(
            "openrouter analyze status=%s body_preview=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
        logger.info("openrouter analyze content_preview=%s", str(content)[:400])
        return _parse_model_json(content, selected)
    except Exception as exc:  # noqa: BLE001
        logger.exception("openrouter analyze failed: %s", exc)
        result = _empty_result(selected)
        result["transcript_note"] = f"OpenRouter error: {exc}"
        return result


async def transcribe_audio_chunk(
    client: httpx.AsyncClient,
    audio_b64: str,
    mime_type: str = "audio/webm",
    stt_model: str | None = None,
) -> tuple[str, str | None]:
    """Transcribe via OpenRouter STT endpoint. Returns (text, error_note)."""
    selected = (stt_model or OPENROUTER_STT_MODEL).strip() or OPENROUTER_STT_MODEL
    if not OPENROUTER_API_KEY:
        return "", "OPENROUTER_API_KEY is missing."
    if not audio_b64:
        return "", "Empty audio chunk."

    fmt = _audio_format(mime_type)
    body = {
        "model": selected,
        "language": "en",
        "input_audio": {
            "data": audio_b64,
            "format": fmt,
        },
    }

    try:
        logger.info(
            "openrouter stt model=%s audio_b64_len=%s mime=%s format=%s",
            selected,
            len(audio_b64 or ""),
            mime_type,
            fmt,
        )
        resp = await client.post(
            f"{OPENROUTER_BASE_URL.rstrip('/')}/audio/transcriptions",
            headers=_headers(),
            json=body,
            timeout=60.0,
        )
        preview = (resp.text or "")[:400]
        logger.info("openrouter stt status=%s body_preview=%s", resp.status_code, preview)
        if resp.status_code >= 400:
            try:
                err = resp.json()
                msg = (
                    err.get("error", {}).get("message")
                    if isinstance(err.get("error"), dict)
                    else err.get("error") or err.get("message") or preview
                )
            except Exception:  # noqa: BLE001
                msg = preview
            return "", f"STT error {resp.status_code}: {msg}"

        payload = resp.json()
        text = _clean_transcript(str(payload.get("text") or ""))
        logger.info("openrouter stt text=%s", text[:300] if text else "(empty)")
        return text, None
    except Exception as exc:  # noqa: BLE001
        logger.exception("openrouter stt failed: %s", exc)
        return "", f"STT exception: {exc}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=90.0)
    yield
    await app.state.http.aclose()


app = FastAPI(title="InterAssist", version="0.1.1", lifespan=lifespan)
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
        "stt_model": OPENROUTER_STT_MODEL,
        "has_key": bool(OPENROUTER_API_KEY),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "default_model": OPENROUTER_MODEL,
        "stt_model": OPENROUTER_STT_MODEL,
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
    stt_model = OPENROUTER_STT_MODEL
    # serialize STT so chunks don't stampede OpenRouter
    stt_lock = asyncio.Lock()
    last_text = ""

    async def analyze_and_send(text: str) -> None:
        nonlocal prior_code, last_text
        cleaned = _clean_transcript(text)
        if not cleaned:
            await ws.send_json(
                {
                    "type": "transcript_partial",
                    "text": "",
                    "note": "No speech detected in chunk",
                }
            )
            return

        # skip exact duplicates back-to-back
        if cleaned.lower() == last_text.lower():
            logger.info("skipping duplicate transcript: %s", cleaned[:120])
            return
        last_text = cleaned

        full_transcript.append(cleaned)
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
                "transcript": cleaned,
                "full_transcript": joined,
                **result,
            }
        )

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            mtype = msg.get("type")
            logger.info("ws recv type=%s keys=%s", mtype, list(msg.keys()))

            if mtype == "config":
                model = (msg.get("model") or model).strip() or model
                stt_model = (msg.get("stt_model") or stt_model).strip() or stt_model
                await ws.send_json(
                    {
                        "type": "config_ok",
                        "model": model,
                        "stt_model": stt_model,
                    }
                )
                continue

            if mtype == "reset":
                full_transcript = []
                prior_code = ""
                last_text = ""
                await ws.send_json({"type": "reset_ok"})
                continue

            if mtype == "transcript":
                text = str(msg.get("text") or "").strip()
                logger.info("ws transcript text=%s", text[:300])
                if not text:
                    continue
                await analyze_and_send(text)
                continue

            if mtype == "audio_chunk":
                audio_b64 = str(msg.get("audio_b64") or "")
                mime_type = str(msg.get("mime_type") or "audio/webm")
                logger.info(
                    "ws audio_chunk mime=%s b64_len=%s",
                    mime_type,
                    len(audio_b64),
                )
                async with stt_lock:
                    text, err = await transcribe_audio_chunk(
                        app.state.http,
                        audio_b64=audio_b64,
                        mime_type=mime_type,
                        stt_model=stt_model,
                    )
                if err:
                    await ws.send_json(
                        {
                            "type": "transcript_partial",
                            "text": "",
                            "note": err,
                        }
                    )
                    continue
                if not text:
                    await ws.send_json(
                        {
                            "type": "transcript_partial",
                            "text": "",
                            "note": "No speech detected in audio chunk",
                        }
                    )
                    continue
                await analyze_and_send(text)
                continue

            await ws.send_json({"type": "error", "message": f"Unknown type: {mtype}"})
    except WebSocketDisconnect:
        logger.info("ws disconnected")
        return


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
