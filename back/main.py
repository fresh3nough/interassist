"""InterAssist backend — live interview audio assistant via OpenRouter."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
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

SYSTEM_PROMPT = """You are InterAssist, a live coding-interview co-pilot agent.
You receive the rolling conversation transcript from Whisper speech-to-text.

Every time you are called, refresh ALL panels for the candidate RIGHT NOW based on the latest transcript.

Respond with ONLY valid JSON (no markdown fences) using this exact shape:
{
  "transcript_note": "one short status line about what just happened, or empty",
  "summary": "2-4 concise bullets of the conversation so far, rewritten fresh each time",
  "is_coding": true or false,
  "is_question": true or false,
  "answer_flash": "if interviewer asked anything answerable, put a crisp interview-ready answer here; else empty string",
  "talking_points": ["max 5 short next things the candidate should say NOW"],
  "code": {
    "language": "python|javascript|typescript|go|etc or empty",
    "filename": "suggested filename or empty",
    "content": "best current full code draft for the coding task, or empty",
    "update": true or false
  }
}

Rules:
- Always refresh talking_points from the latest conversation (even small chit-chat).
- is_question true for any interviewer question, prompt, or request. Fill answer_flash whenever helpful.
- is_coding true when coding/algorithms/system design/debugging is in play.
- When coding is discussed, keep evolving code.content and set update true whenever the draft changes.
- Prefer practical, correct, concise output. No fluff. No markdown fences outside JSON.
- If transcript is only a greeting, still give friendly talking_points.
"""

NOISE_RE = re.compile(
    r"^(thanks for watching[.!]?|thank you for watching[.!]?|subscribe[.!]?|"
    r"please subscribe[.!]?|music|\[music\]|\(music\)|\.|\.\.\.|…)$",
    re.I,
)

QUESTION_RE = re.compile(
    r"(?i)(?:"
    r"\?|"
    r"\b(?:what|why|how|when|where|who|which|can you|could you|would you|do you|did you|"
    r"are you|is there|are there|tell me|explain|describe|walk me through|walk us through|"
    r"give me|show me|define|difference between|compare|trade\-?offs?|complexit(?:y|ies)|"
    r"big ?o|time complexity|space complexity|how would you|what would you|why did you|"
    r"have you|what's|whats|how does|how do|please explain)\b"
    r")"
)

FAST_ANSWER_PROMPT = """You answer coding-interview questions instantly for a candidate.
Return ONLY valid JSON (no markdown fences):
{
  "question": "the interviewer question rewritten clearly and short",
  "answer": "bold interview-ready answer, 1-4 short sentences or tight bullets separated by newlines",
  "key_points": ["up to 4 ultra-short bullets"]
}
Rules:
- Prioritize speed and correctness.
- If multiple questions appear, answer the latest/most important one.
- Be direct. No preamble. No fluff.
"""


def _looks_like_question(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if "?" in t:
        return True
    return bool(QUESTION_RE.search(t))


class AnalyzeRequest(BaseModel):
    transcript: str = Field(..., min_length=1)
    prior_code: str = ""
    model: str | None = None


class AnalyzeResponse(BaseModel):
    transcript_note: str = ""
    summary: str = ""
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
        "summary": "",
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
    base["summary"] = str(data.get("summary") or "")
    base["is_coding"] = bool(data.get("is_coding"))
    base["is_question"] = bool(data.get("is_question"))
    base["answer_flash"] = str(data.get("answer_flash") or "")
    points = data.get("talking_points") or []
    if isinstance(points, list):
        base["talking_points"] = [str(p).strip() for p in points if str(p).strip()][:5]
    code = data.get("code") or {}
    if isinstance(code, dict):
        content = str(code.get("content") or "")
        base["code"] = {
            "language": str(code.get("language") or ""),
            "filename": str(code.get("filename") or ""),
            "content": content,
            # if model forgot update flag but sent content, treat as update
            "update": bool(code.get("update")) or bool(content.strip()),
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
    if len(t) < 1:
        return ""
    return t


async def call_openrouter(
    client: httpx.AsyncClient,
    transcript: str,
    prior_code: str = "",
    model: str | None = None,
    latest_chunk: str = "",
) -> dict[str, Any]:
    selected = (model or OPENROUTER_MODEL).strip() or OPENROUTER_MODEL
    if not OPENROUTER_API_KEY:
        result = _empty_result(selected)
        result["transcript_note"] = "OPENROUTER_API_KEY is missing."
        return result

    user_payload = {
        "latest_chunk": latest_chunk[-2000:],
        "full_transcript": transcript[-12000:],
        "prior_code": prior_code[-8000:] if prior_code else "",
        "instruction": (
            "Update talking_points, answer_flash, summary, and code draft now "
            "from this live interview transcript."
        ),
    }
    body = {
        "model": selected,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ],
    }

    try:
        logger.info(
            "openrouter analyze model=%s transcript_chars=%s chunk_chars=%s prior_code_chars=%s",
            selected,
            len(transcript or ""),
            len(latest_chunk or ""),
            len(prior_code or ""),
        )
        resp = await client.post(
            f"{OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
            headers=_headers(),
            json=body,
            timeout=90.0,
        )
        logger.info(
            "openrouter analyze status=%s body_preview=%s",
            resp.status_code,
            (resp.text or "")[:500],
        )
        resp.raise_for_status()
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
        # some providers put reasoning separately; content can be delayed/empty string with whitespace
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
                else:
                    parts.append(str(item))
            content = "\n".join(parts)
        logger.info("openrouter analyze content_preview=%s", str(content)[:500])
        return _parse_model_json(str(content or ""), selected)
    except Exception as exc:  # noqa: BLE001
        logger.exception("openrouter analyze failed: %s", exc)
        result = _empty_result(selected)
        result["transcript_note"] = f"OpenRouter error: {exc}"
        return result



async def call_fast_answer(
    client: httpx.AsyncClient,
    question_text: str,
    context: str = "",
    model: str | None = None,
) -> dict[str, Any]:
    """Priority path: answer one question as fast as possible."""
    selected = (model or OPENROUTER_MODEL).strip() or OPENROUTER_MODEL
    empty = {"question": question_text.strip(), "answer": "", "key_points": [], "model": selected}
    if not OPENROUTER_API_KEY:
        empty["answer"] = "OPENROUTER_API_KEY is missing."
        return empty
    body = {
        "model": selected,
        "temperature": 0.1,
        "max_tokens": 450,
        "messages": [
            {"role": "system", "content": FAST_ANSWER_PROMPT},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "priority": "ANSWER_NOW",
                        "latest_question_or_chunk": question_text[-2500:],
                        "recent_context": context[-4000:],
                    }
                ),
            },
        ],
    }
    try:
        logger.info(
            "openrouter FAST answer model=%s q_chars=%s ctx_chars=%s",
            selected,
            len(question_text or ""),
            len(context or ""),
        )
        resp = await client.post(
            f"{OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
            headers=_headers(),
            json=body,
            timeout=35.0,
        )
        logger.info(
            "openrouter FAST answer status=%s body_preview=%s",
            resp.status_code,
            (resp.text or "")[:400],
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
            content = "\n".join(parts)
        text = str(content or "").strip()
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
            data = json.loads(text[start : end + 1]) if start != -1 and end > start else {}
        q = str(data.get("question") or question_text).strip()
        ans = str(data.get("answer") or "").strip()
        pts = data.get("key_points") or []
        if not isinstance(pts, list):
            pts = []
        pts = [str(p).strip() for p in pts if str(p).strip()][:4]
        if not ans and text:
            ans = text[:800]
        logger.info("openrouter FAST answer q=%s a_preview=%s", q[:120], ans[:200])
        return {"question": q, "answer": ans, "key_points": pts, "model": selected}
    except Exception as exc:  # noqa: BLE001
        logger.exception("openrouter FAST answer failed: %s", exc)
        empty["answer"] = f"Fast answer error: {exc}"
        return empty


async def transcribe_audio_chunk(
    client: httpx.AsyncClient,
    audio_b64: str,
    mime_type: str = "audio/webm",
    stt_model: str | None = None,
) -> tuple[str, str | None]:
    """Transcribe via OpenRouter STT. Returns (text, error_note)."""
    selected = (stt_model or OPENROUTER_STT_MODEL).strip() or OPENROUTER_STT_MODEL
    if not OPENROUTER_API_KEY:
        return "", "OPENROUTER_API_KEY is missing."
    if not audio_b64:
        return "", "Empty audio chunk."

    fmt = _audio_format(mime_type)
    url = f"{OPENROUTER_BASE_URL.rstrip('/')}/audio/transcriptions"
    headers = _headers()

    # Prefer JSON base64 path first
    body = {
        "model": selected,
        "language": "en",
        "temperature": 0,
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
        resp = await client.post(url, headers=headers, json=body, timeout=60.0)
        preview = (resp.text or "")[:500]
        logger.info("openrouter stt status=%s body_preview=%s", resp.status_code, preview)

        # Fallback: multipart file upload if JSON path fails with 400
        if resp.status_code >= 400:
            try:
                import base64

                raw = base64.b64decode(audio_b64)
                ext = fmt if fmt != "webm" else "webm"
                files = {
                    "file": (f"clip.{ext}", raw, mime_type or f"audio/{ext}"),
                }
                data = {
                    "model": selected,
                    "language": "en",
                    "temperature": "0",
                }
                mp_headers = {
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "HTTP-Referer": "http://localhost:5173",
                    "X-Title": "InterAssist",
                }
                logger.info("openrouter stt retry multipart bytes=%s", len(raw))
                resp = await client.post(
                    url,
                    headers=mp_headers,
                    data=data,
                    files=files,
                    timeout=60.0,
                )
                preview = (resp.text or "")[:500]
                logger.info(
                    "openrouter stt multipart status=%s body_preview=%s",
                    resp.status_code,
                    preview,
                )
            except Exception as mp_exc:  # noqa: BLE001
                logger.exception("multipart stt failed: %s", mp_exc)

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
    app.state.http = httpx.AsyncClient(timeout=120.0)
    yield
    await app.state.http.aclose()


app = FastAPI(title="InterAssist", version="0.1.2", lifespan=lifespan)
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
        latest_chunk=req.transcript,
    )
    return AnalyzeResponse(**data)


@app.websocket("/ws")
async def interview_ws(ws: WebSocket) -> None:
    await ws.accept()
    full_transcript: list[str] = []
    prior_code = ""
    model = OPENROUTER_MODEL
    stt_model = OPENROUTER_STT_MODEL
    stt_lock = asyncio.Lock()
    analyze_lock = asyncio.Lock()
    last_text = ""
    last_analyze_at = 0.0
    question_queue: asyncio.Queue[str] = asyncio.Queue()
    seen_questions: set[str] = set()

    async def priority_answer_worker() -> None:
        """Drain interview questions FIFO, one-by-one, as fast as possible."""
        while True:
            qtext = await question_queue.get()
            try:
                ctx = " ".join(full_transcript)[-5000:]
                logger.info(
                    "priority queue size_after_get≈%s answering=%s",
                    question_queue.qsize(),
                    qtext[:160],
                )
                await ws.send_json(
                    {
                        "type": "question_queued",
                        "question": qtext,
                        "queue_size": question_queue.qsize() + 1,
                    }
                )
                ans = await call_fast_answer(
                    app.state.http,
                    question_text=qtext,
                    context=ctx,
                    model=model,
                )
                await ws.send_json(
                    {
                        "type": "priority_answer",
                        "question": ans.get("question") or qtext,
                        "answer": ans.get("answer") or "",
                        "key_points": ans.get("key_points") or [],
                        "model": ans.get("model") or model,
                        "queue_remaining": question_queue.qsize(),
                        "ts": time.time(),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("priority answer worker failed: %s", exc)
                try:
                    await ws.send_json(
                        {
                            "type": "priority_answer",
                            "question": qtext,
                            "answer": f"Priority answer failed: {exc}",
                            "key_points": [],
                            "model": model,
                            "queue_remaining": question_queue.qsize(),
                            "ts": time.time(),
                        }
                    )
                except Exception:  # noqa: BLE001
                    pass
            finally:
                question_queue.task_done()

    worker_task = asyncio.create_task(priority_answer_worker())

    def enqueue_question(text: str) -> None:
        cleaned = _clean_transcript(text)
        if not cleaned or not _looks_like_question(cleaned):
            return
        key = cleaned.lower()
        # allow same question again after a while by keeping only recent keys
        if key in seen_questions:
            logger.info("priority skip duplicate question: %s", cleaned[:120])
            return
        seen_questions.add(key)
        if len(seen_questions) > 80:
            # drop arbitrary old entries
            for _ in range(20):
                try:
                    seen_questions.pop()
                except KeyError:
                    break
        question_queue.put_nowait(cleaned)
        logger.info(
            "priority enqueued q_chars=%s queue_size=%s text=%s",
            len(cleaned),
            question_queue.qsize(),
            cleaned[:160],
        )

    async def analyze_and_send(text: str, force: bool = False) -> None:
        nonlocal prior_code, last_text, last_analyze_at
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

        if cleaned.lower() == last_text.lower() and not force:
            logger.info("skipping exact duplicate transcript: %s", cleaned[:120])
            return

        last_text = cleaned
        full_transcript.append(cleaned)
        joined = " ".join(full_transcript)[-12000:]

        # PRIORITY: questions jump the queue and get a dedicated fast answer path
        if _looks_like_question(cleaned):
            enqueue_question(cleaned)
            await ws.send_json(
                {
                    "type": "question_detected",
                    "question": cleaned,
                    "queue_size": question_queue.qsize(),
                }
            )

        now = time.time()
        if not force and (now - last_analyze_at) < 0.4:
            await asyncio.sleep(0.4)

        async with analyze_lock:
            last_analyze_at = time.time()
            result = await call_openrouter(
                app.state.http,
                transcript=joined,
                prior_code=prior_code,
                model=model,
                latest_chunk=cleaned,
            )
            if result.get("code", {}).get("content"):
                if result["code"].get("update") or not prior_code:
                    prior_code = result["code"]["content"]
                    result["code"]["update"] = True

            # If detector missed it but full analysis flags a question, enqueue for priority box.
            if result.get("is_question") or result.get("answer_flash"):
                if cleaned.lower() not in seen_questions:
                    q = cleaned if _looks_like_question(cleaned) else (cleaned.rstrip(".!") + "?")
                    enqueue_question(q)

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
                await analyze_and_send(text, force=True)
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
                    logger.warning("stt error note=%s", err)
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
                # Every Whisper transcript goes to Grok for live panel updates
                await analyze_and_send(text, force=True)
                continue

            await ws.send_json({"type": "error", "message": f"Unknown type: {mtype}"})
    except WebSocketDisconnect:
        logger.info("ws disconnected")
        worker_task.cancel()
        return
    finally:
        if not worker_task.done():
            worker_task.cancel()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
