# InterAssist

Local web app that listens to a live interview, transcribes speech, and helps in real time:

- **Live transcript** of the conversation
- **Code draft** that builds when the talk turns to coding
- **Talking points** for what to say next
- **Answer flash** when a question is detected

Single-screen layout. Nothing is stored permanently.

## Stack

- `front/` — React + Vite
- `back/` — Python FastAPI + WebSocket
- AI via [OpenRouter](https://openrouter.ai) (default model: `x-ai/grok-4.5`)

## Setup

### 1. Backend

```bash
cd back
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # if needed
# put your OpenRouter key in .env
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Frontend

```bash
cd front
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Environment

`back/.env`:

```env
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=x-ai/grok-4.5
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

`.env` is gitignored. Use `.env.example` as the template.

## How it works

1. Click **Start listening** (browser mic permission required).
2. The browser uses the Web Speech API for live transcription when available.
3. Final transcript lines go over WebSocket to FastAPI.
4. FastAPI calls OpenRouter and returns structured JSON:
   - talking points
   - optional code draft
   - short answer when a question is detected
5. The UI updates all panels live. Answers also flash across the top briefly.

You can also type or paste lines into the transcript box if speech is unavailable.

## Notes

- Chrome/Edge work best for live speech recognition.
- If speech recognition is missing, the app falls back to short audio chunks sent to the model for transcription (depends on model audio support).
- No database. Session state lives in memory for the open WebSocket only.
