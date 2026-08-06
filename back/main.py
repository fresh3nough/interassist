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
from fastapi import Body, FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
try:
    from langdetect import DetectorFactory, detect_langs

    DetectorFactory.seed = 0
except ImportError:  # pragma: no cover - optional until dependencies are installed
    detect_langs = None

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    SENTIMENT_ANALYZER = SentimentIntensityAnalyzer()
except ImportError:  # pragma: no cover - optional until dependencies are installed
    SENTIMENT_ANALYZER = None

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
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-live-transcribe")
OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls"

REALTIME_SESSION_CONFIG = {
    "type": "transcription",
    "audio": {
        "input": {
            "transcription": {
                "model": OPENAI_REALTIME_MODEL,
                "languages": ["en"],
                "delay": "low",
                "keywords": [
                    "OpenRouter",
                    "OpenAI",
                    "Grok",
                    "FastAPI",
                    "WebSocket",
                    "WebRTC",
                    "React",
                    "TypeScript",
                    "JavaScript",
                    "Python",
                    "GitHub",
                    "Apollo Art",
                ],
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 350,
            },
        }
    },
}

SYSTEM_PROMPT = """You are InterAssist, a live coding-interview co-pilot agent.
You receive the rolling conversation transcript from live speech-to-text.

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

PERSONALIZATION_CONTEXT = """Candidate profile — use this context to tailor every response.

Identity and links:
- Name: Cody Wirth
- Role: Software Engineer
- Location: Newport Beach, California
- LinkedIn: https://www.linkedin.com/in/codyrwirth
- GitHub: https://github.com/fresh3nough
- Email: codywirth903@gmail.com

Resume and cover-letter experience:
- Started in web development, progressed through a software engineering internship, and then full-time software engineering roles.
- Shipped iPhone and Android applications, television applications for Samsung TV, Apple TV, and Fire TV/Firestick, plus frontend and backend e-commerce systems and APIs.
- At Apollo Art, built an iPhone app, Android app, TV app, full e-commerce store, and C# backend APIs using Angular and Ionic. The work included deliberate gaming-influenced architecture choices and substantial hands-on integration and edge-case problem solving.
- Strongest positioning: full-stack product engineering, cross-platform application delivery, backend/frontend integration, and practical ownership of difficult systems.

Open-source work from the public GitHub profile:
- Contributed to Zstandard (ZSTD), including fixing a SIGFPE crash in a compression path.
- Shipped fixes and features across Docusaurus, React DevTools, Goose, Cashu, Meshtastic, Session, and other open-source projects.
- Verified public activity includes work on React, block/buzz, Brave/adblock-rust, Goose, and the falcon project.
- Themes to emphasize when relevant: protocol hacking, agent tooling, debugging, shared infrastructure, careful fixes, and making systems better for other developers.

Personal interview framing:
- Cody is motivated by curiosity, hacking, learning, problem solving, and building useful products.
- Prefer concrete stories from Apollo Art for end-to-end ownership and from open source for debugging, collaboration, and production-quality maintenance.
- Draft spoken interview answers in first person so Cody can say them directly.
- Never invent an employer, title, metric, date, responsibility, technology, or LinkedIn detail that is not in this profile or the live conversation.
- If a question asks for an unknown detail, say it is not in the available profile and suggest a truthful way for Cody to fill it in.
"""

SYSTEM_PROMPT += "\n\n" + PERSONALIZATION_CONTEXT

NOISE_RE = re.compile(
    r"^(thanks for watching[.!]?|thank you for watching[.!]?|subscribe[.!]?|"
    r"please subscribe[.!]?|music|\[music\]|\(music\)|\.|\.\.\.|…)$",
    re.I,
)
HALLUCINATED_CLOSING_RE = re.compile(
    r"(?i)(?:"
    r"\bthank you(?: so much)? for watching\b|"
    r"\b(?:i hope you have a wonderful day|i'll see you in the next video)\b|"
    r"\b(?:and )?prince,? happy birthday\b"
    r")"
)
ACKNOWLEDGEMENT_RE = re.compile(
    r"^(?:thanks?|thank you|thank you so much|okay|ok|great|awesome|perfect|"
    r"sounds good|no problem|right|got it|hello|hi|hey)[.!?,\\s]*$",
    re.I,
)
INCOMPLETE_END_RE = re.compile(
    r"(?i)(?:\b(?:a|an|the|and|or|but|because|so|to|for|of|in|on|with|"
    r"from|about|that|which|me|you|my|your|is|are|can|could|would))$"
)
FRAGMENT_PREFIX_RE = re.compile(
    r"^(?:and|or|but|because|so|then|also|as|that|which)\b",
    re.I,
)
QUESTION_START_RE = re.compile(
    r"(?i)(?:^|[.!?]\s+)"
    r"(?:what|why|how|when|where|who|which|can|could|would|do|did|are|is|"
    r"have|has|tell|explain|describe|walk|give|show|please)\b"
)
REQUEST_START_RE = re.compile(
    r"(?i)(?:^|[.!?]\s+)(?:build|write|implement|create|make)\b"
)

QUESTION_RE = re.compile(
    r"(?i)(?:"
    r"\?|"
    r"\b(?:what|why|how|when|where|who|which|can you|could you|would you|do you|did you|"
    r"are you|is there|are there|tell me|explain|describe|walk me through|walk us through|"
    r"give me|show me|build me|define|difference between|compare|trade\-?offs?|complexit(?:y|ies)|"
    r"big ?o|time complexity|space complexity|how would you|what would you|why did you|"
    r"have you|what's|whats|how does|how do|please explain)\b"
    r")"
)
QUESTION_ACK_RE = re.compile(
    r"^(?:"
    r"ok(?:ay)?|alright|all right|sure|yes|no|right|got it|understood|"
    r"thanks?|thank you|bye(?:[ -]?bye)?|goodbye|great|awesome|perfect|"
    r"sounds good|no problem|that is all|that's all|"
    r"hello|hi|hey|yep|yeah|uh huh"
    r")[.!?,\s]*$",
    re.I,
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

FAST_ANSWER_PROMPT += (
    "\n\n"
    + PERSONALIZATION_CONTEXT
    + "\nFor interview answers, prefer a concise first-person response grounded in Cody's actual experience."
)


def _question_evidence(text: str) -> tuple[bool, dict[str, Any]]:
    t = (text or "").strip()
    evidence: dict[str, Any] = {
        "language": "unknown",
        "language_probability": 0.0,
        "sentiment_compound": 0.0,
        "reason": "empty",
    }


    if not t:
        return False, evidence
    normalized = re.sub(r"[.!?,\s]+$", "", t).strip()
    if not normalized:
        evidence["reason"] = "empty_after_punctuation"
        return False, evidence
    if QUESTION_ACK_RE.fullmatch(t):
        evidence["reason"] = "acknowledgement"
        return False, evidence
    if FRAGMENT_PREFIX_RE.match(normalized):
        evidence["reason"] = "conjunction_fragment"
        return False, evidence
    if _is_incomplete_fragment(normalized) and "?" not in t:
        evidence["reason"] = "incomplete_fragment"
        return False, evidence
    if len(re.sub(r"[^a-z0-9]+", "", normalized.lower())) < 3:
        evidence["reason"] = "too_short"
        return False, evidence

    if detect_langs is not None and len(re.findall(r"[A-Za-z]", t)) >= 20:
        try:
            detected = detect_langs(t)[0]
            evidence["language"] = detected.lang
            evidence["language_probability"] = round(float(detected.prob), 3)
        except Exception:  # noqa: BLE001
            pass
    if SENTIMENT_ANALYZER is not None:
        try:
            evidence["sentiment_compound"] = round(
                float(SENTIMENT_ANALYZER.polarity_scores(t)["compound"]), 3
            )
        except Exception:  # noqa: BLE001
            pass

    if evidence["language"] not in {"unknown", "en"} and evidence["language_probability"] >= 0.8:
        evidence["reason"] = "non_english"
        return False, evidence
    if "?" in t:
        evidence["reason"] = "question_mark"
        return True, evidence
    if QUESTION_START_RE.search(t):
        evidence["reason"] = "question_start"
        return True, evidence
    if REQUEST_START_RE.search(t):
        evidence["reason"] = "request_start"
        return True, evidence
    evidence["reason"] = "no_question_structure"
    return False, evidence


def _looks_like_question(text: str) -> bool:
    accepted, _ = _question_evidence(text)
    return accepted


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
    if NOISE_RE.match(t) or HALLUCINATED_CLOSING_RE.search(t):
        return ""
    if ACKNOWLEDGEMENT_RE.fullmatch(t):
        return ""
    return t


def _is_incomplete_fragment(text: str) -> bool:
    """Avoid treating a clipped recorder segment as a complete question."""
    normalized = re.sub(r"[.!?,\s]+$", "", text or "").strip()
    if not normalized:
        return True
    return bool(INCOMPLETE_END_RE.search(normalized))


def _should_analyze(text: str) -> bool:
    """Skip filler and sentence fragments while retaining them in the transcript."""
    normalized = " ".join((text or "").split()).strip()
    if not normalized or ACKNOWLEDGEMENT_RE.fullmatch(normalized):
        return False
    if HALLUCINATED_CLOSING_RE.search(normalized):
        return False
    words = re.findall(r"[A-Za-z0-9']+", normalized)
    if len(words) <= 5 and _is_incomplete_fragment(normalized):
        return False
    return True


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
        "realtime_model": OPENAI_REALTIME_MODEL,
        "realtime_available": bool(OPENAI_API_KEY),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "default_model": OPENROUTER_MODEL,
        "stt_model": OPENROUTER_STT_MODEL,
        "realtime_model": OPENAI_REALTIME_MODEL,
        "realtime_available": bool(OPENAI_API_KEY),
        "models": [
            "x-ai/grok-4.5",
            "x-ai/grok-4",
            "openai/gpt-4.1",
            "openai/gpt-4o-mini",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.5-flash",
        ],
    }


@app.post("/api/realtime/session")
async def create_realtime_session(
    sdp: str = Body(..., media_type="application/sdp"),
) -> Response:
    """Proxy a browser SDP offer to OpenAI without exposing the server API key."""
    if not OPENAI_API_KEY:
        logger.warning("realtime session requested but OPENAI_API_KEY is missing")
        return Response(
            content="OPENAI_API_KEY is missing.",
            status_code=503,
            media_type="text/plain",
        )
    if not sdp.strip():
        return Response(
            content="SDP offer is empty.",
            status_code=400,
            media_type="text/plain",
        )

    files = [
        ("sdp", (None, sdp, "application/sdp")),
        (
            "session",
            (None, json.dumps(REALTIME_SESSION_CONFIG), "application/json"),
        ),
    ]
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Accept": "application/sdp",
    }
    try:
        logger.info(
            "realtime session request model=%s sdp_chars=%s",
            OPENAI_REALTIME_MODEL,
            len(sdp),
        )
        response = await app.state.http.post(
            OPENAI_REALTIME_URL,
            headers=headers,
            files=files,
            timeout=30.0,
        )
        logger.info(
            "realtime session response status=%s body_chars=%s",
            response.status_code,
            len(response.content),
        )
        content_type = response.headers.get("content-type", "application/sdp")
        response_headers = {}
        if response.headers.get("location"):
            response_headers["Location"] = response.headers["location"]
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=content_type.split(";", 1)[0],
            headers=response_headers,
        )
    except httpx.HTTPError as exc:
        logger.exception("realtime session request failed: %s", exc)
        return Response(
            content=f"Realtime session request failed: {exc}",
            status_code=502,
            media_type="text/plain",
        )


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
    last_text = ""
    latest_sequence = 0
    latest_analysis_sequence = 0
    connection_open = True
    send_lock = asyncio.Lock()
    audio_queue: asyncio.Queue[tuple[int, str, str]] = asyncio.Queue(maxsize=3)
    transcript_queue: asyncio.Queue[tuple[int, str]] = asyncio.Queue(maxsize=2)
    question_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=32)
    seen_questions: set[str] = set()
    answered_questions: set[str] = set()
    sequence = 0

    async def publish_priority_answer(
        question: str,
        answer: str,
        key_points: list[str] | None = None,
        answer_model: str | None = None,
    ) -> bool:
        """Send one answer per question, even when full and fast analysis race."""
        key = question.strip().lower()
        if not answer.strip() or key in answered_questions:
            return False
        answered_questions.add(key)
        if len(answered_questions) > 80:
            answered_questions.pop()
        await safe_send(
            {
                "type": "priority_answer",
                "question": question,
                "answer": answer.strip(),
                "key_points": key_points or [],
                "model": answer_model or model,
                "queue_remaining": question_queue.qsize(),
                "ts": time.time(),
            }
        )
        return True

    async def safe_send(payload: dict[str, Any]) -> bool:
        """Serialize sends and ignore writes after the browser disconnects."""
        nonlocal connection_open
        if not connection_open:
            return False
        try:
            async with send_lock:
                if not connection_open:
                    return False
                await ws.send_json(payload)
            return True
        except (WebSocketDisconnect, RuntimeError, ConnectionError) as exc:
            connection_open = False
            logger.info("ws send skipped after disconnect: %s", exc)
            return False

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
                if qtext.strip().lower() in answered_questions:
                    continue
                await safe_send(
                    {
                        "type": "question_queued",
                        "question": qtext,
                        "queue_size": question_queue.qsize() + 1,
                    }
                )
                try:
                    ans = await asyncio.wait_for(
                        call_fast_answer(
                            app.state.http,
                            question_text=qtext,
                            context=ctx,
                            model=model,
                        ),
                        timeout=20.0,
                    )
                except asyncio.TimeoutError:
                    logger.warning("priority answer timed out q=%s", qtext[:160])
                    ans = {
                        "question": qtext,
                        "answer": (
                            "I heard the question, but the answer service timed out. "
                            "Could you repeat it once?"
                        ),
                        "key_points": [],
                        "model": model,
                    }
                await publish_priority_answer(
                    qtext,
                    ans.get("answer") or "",
                    ans.get("key_points") or [],
                    ans.get("model") or model,
                )
            except Exception as exc:  # noqa: BLE001
                if connection_open:
                    logger.exception("priority answer worker failed: %s", exc)
                    await publish_priority_answer(
                        qtext,
                        f"Priority answer failed: {exc}",
                    )
            finally:
                question_queue.task_done()

    worker_task = asyncio.create_task(priority_answer_worker())

    def enqueue_question(text: str) -> bool:
        cleaned = _clean_transcript(text)
        accepted, evidence = _question_evidence(cleaned)
        logger.info(
            "priority evidence accepted=%s language=%s language_probability=%s "
            "sentiment=%s reason=%s text=%s",
            accepted,
            evidence["language"],
            evidence["language_probability"],
            evidence["sentiment_compound"],
            evidence["reason"],
            cleaned[:160],
        )
        if not cleaned or not accepted:
            return False
        key = cleaned.lower()
        # allow same question again after a while by keeping only recent keys
        if key in seen_questions:
            logger.info("priority skip duplicate question: %s", cleaned[:120])
            return False
        seen_questions.add(key)
        if len(seen_questions) > 80:
            # drop arbitrary old entries
            for _ in range(20):
                try:
                    seen_questions.pop()
                except KeyError:
                    break
        try:
            question_queue.put_nowait(cleaned)
        except asyncio.QueueFull:
            logger.warning("priority queue full; dropping question: %s", cleaned[:160])
            return False
        logger.info(
            "priority enqueued q_chars=%s queue_size=%s text=%s",
            len(cleaned),
            question_queue.qsize(),
            cleaned[:160],
        )
        return True

    def queue_latest_analysis(seq: int, text: str) -> None:
        """Keep at most one panel update waiting behind the current model call."""
        nonlocal latest_analysis_sequence
        latest_analysis_sequence = seq
        while True:
            try:
                transcript_queue.get_nowait()
                transcript_queue.task_done()
            except asyncio.QueueEmpty:
                break
        try:
            transcript_queue.put_nowait((seq, text))
        except asyncio.QueueFull:
            logger.warning("analysis queue full; dropping stale seq=%s", seq)

    async def publish_transcript(seq: int, text: str) -> str:
        """Commit a recognized line to the rolling transcript before AI analysis."""
        nonlocal last_text, latest_sequence
        cleaned = _clean_transcript(text)
        if not cleaned:
            return ""

        if cleaned.lower() == last_text.lower():
            logger.info("skipping exact duplicate transcript: %s", cleaned[:120])
            return ""

        last_text = cleaned
        latest_sequence = seq
        full_transcript.append(cleaned)
        joined = " ".join(full_transcript)[-12000:]
        await safe_send(
            {
                "type": "transcript",
                "transcript": cleaned,
                "full_transcript": joined,
                "sequence": seq,
            }
        )

        # PRIORITY: questions jump the queue and get a dedicated fast answer path
        if enqueue_question(cleaned):
            await safe_send(
                {
                    "type": "question_detected",
                    "question": cleaned,
                    "queue_size": question_queue.qsize(),
                    "sequence": seq,
                }
            )

        if _should_analyze(cleaned):
            queue_latest_analysis(seq, cleaned)
        else:
            logger.info("skipping panel analysis for filler/fragment seq=%s text=%s", seq, cleaned[:120])
        return cleaned

    async def analyze_and_send(seq: int, text: str) -> None:
        nonlocal prior_code
        cleaned = _clean_transcript(text)
        if not cleaned or not _should_analyze(cleaned):
            return
        joined = " ".join(full_transcript)[-12000:]
        result = await call_openrouter(
            app.state.http,
            transcript=joined,
            prior_code=prior_code,
            model=model,
            latest_chunk=cleaned,
        )
        # A newer meaningful line arrived while this request was in flight.
        # Do not let an old model response overwrite the current panels.
        if seq != latest_analysis_sequence:
            logger.info(
                "discarding stale panel analysis seq=%s latest_analysis_seq=%s",
                seq,
                latest_analysis_sequence,
            )
            return
        if result.get("code", {}).get("content"):
            if result["code"].get("update") or not prior_code:
                prior_code = result["code"]["content"]
                result["code"]["update"] = True

        await safe_send(
            {
                "type": "analysis",
                "transcript": cleaned,
                "full_transcript": joined,
                "sequence": seq,
                **result,
            }
        )

    async def stt_worker() -> None:
        """Transcribe accepted audio without blocking WebSocket ingestion."""
        while True:
            seq, audio_b64, mime_type = await audio_queue.get()
            try:
                text, err = await transcribe_audio_chunk(
                    app.state.http,
                    audio_b64=audio_b64,
                    mime_type=mime_type,
                    stt_model=stt_model,
                )
                if err:
                    logger.warning("stt error seq=%s note=%s", seq, err)
                    await safe_send(
                        {
                            "type": "transcript_partial",
                            "text": "",
                            "note": err,
                            "sequence": seq,
                        }
                    )
                elif text:
                    await publish_transcript(seq, text)
                else:
                    await safe_send(
                        {
                            "type": "transcript_partial",
                            "text": "",
                            "note": "No speech detected in audio chunk",
                            "sequence": seq,
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                logger.exception("stt worker failed seq=%s: %s", seq, exc)
                await safe_send(
                    {
                        "type": "transcript_partial",
                        "text": "",
                        "note": f"STT worker error: {exc}",
                        "sequence": seq,
                    }
                )
            finally:
                audio_queue.task_done()

    async def analysis_worker() -> None:
        """Run slower full-panel analysis independently of incoming audio."""
        while True:
            seq, text = await transcript_queue.get()
            try:
                logger.info("analysis queue processing seq=%s text=%s", seq, text[:160])
                await analyze_and_send(seq, text)
            except Exception as exc:  # noqa: BLE001
                if connection_open:
                    logger.exception("analysis worker failed seq=%s: %s", seq, exc)
                    await safe_send(
                        {
                            "type": "error",
                            "message": f"Analysis worker error: {exc}",
                            "sequence": seq,
                        }
                    )
            finally:
                transcript_queue.task_done()

    stt_task = asyncio.create_task(stt_worker())
    analysis_task = asyncio.create_task(analysis_worker())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await safe_send({"type": "error", "message": "Invalid JSON"})
                continue

            mtype = msg.get("type")
            logger.info("ws recv type=%s keys=%s", mtype, list(msg.keys()))

            if mtype == "config":
                model = (msg.get("model") or model).strip() or model
                stt_model = (msg.get("stt_model") or stt_model).strip() or stt_model
                await safe_send(
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
                latest_sequence = 0
                latest_analysis_sequence = 0
                seen_questions.clear()
                answered_questions.clear()
                await safe_send({"type": "reset_ok"})
                continue

            if mtype == "transcript":
                text = str(msg.get("text") or "").strip()
                logger.info("ws transcript text=%s", text[:300])
                if not text:
                    continue
                sequence += 1
                await publish_transcript(sequence, text)
                continue

            if mtype == "audio_chunk":
                audio_b64 = str(msg.get("audio_b64") or "")
                mime_type = str(msg.get("mime_type") or "audio/webm")
                logger.info(
                    "ws audio_chunk mime=%s b64_len=%s",
                    mime_type,
                    len(audio_b64),
                )
                if not audio_b64:
                    await safe_send(
                        {"type": "transcript_partial", "text": "", "note": "Empty audio chunk."}
                    )
                    continue
                sequence += 1
                if audio_queue.full():
                    try:
                        dropped_seq, _, _ = audio_queue.get_nowait()
                        audio_queue.task_done()
                        logger.warning("dropping stale audio seq=%s to avoid backlog", dropped_seq)
                    except asyncio.QueueEmpty:
                        pass
                audio_queue.put_nowait((sequence, audio_b64, mime_type))
                await safe_send(
                    {
                        "type": "audio_queued",
                        "sequence": sequence,
                        "queue_size": audio_queue.qsize(),
                    }
                )
                continue

            await safe_send({"type": "error", "message": f"Unknown type: {mtype}"})
    except WebSocketDisconnect:
        logger.info("ws disconnected")
    finally:
        connection_open = False
        for task in (worker_task, stt_task, analysis_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(worker_task, stt_task, analysis_task, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
