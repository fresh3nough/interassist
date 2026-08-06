import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const DEFAULT_MODEL = 'x-ai/grok-4.5'
const FALLBACK_MODELS = [
  'x-ai/grok-4.5',
  'x-ai/grok-4',
  'openai/gpt-4.1',
  'openai/gpt-4o-mini',
  'anthropic/claude-sonnet-4',
  'google/gemini-2.5-flash',
]

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws`
}

export default function App() {
  const [models, setModels] = useState(FALLBACK_MODELS)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [connected, setConnected] = useState(false)
  const [listening, setListening] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [transcript, setTranscript] = useState('')
  const [liveLine, setLiveLine] = useState('')
  const [talkingPoints, setTalkingPoints] = useState([])
  const [code, setCode] = useState({ language: '', filename: '', content: '' })
  const [flash, setFlash] = useState('')
  const [flashOn, setFlashOn] = useState(false)
  const [error, setError] = useState('')
  const [manualText, setManualText] = useState('')

  const wsRef = useRef(null)
  const recognitionRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const shouldListenRef = useRef(false)
  const modelRef = useRef(model)
  const transcriptEndRef = useRef(null)

  useEffect(() => {
    modelRef.current = model
  }, [model])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, liveLine])

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.models) && data.models.length) {
          setModels(data.models)
        }
        if (data.default_model) {
          setModel(data.default_model)
        }
      })
      .catch(() => {})
  }, [])

  const sendJson = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    }
  }, [])

  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return

    const ws = new WebSocket(wsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setStatus('Connected')
      setError('')
      ws.send(JSON.stringify({ type: 'config', model: modelRef.current }))
    }

    ws.onclose = () => {
      setConnected(false)
      setStatus(shouldListenRef.current ? 'Reconnecting…' : 'Disconnected')
      wsRef.current = null
      if (shouldListenRef.current) {
        setTimeout(connectWs, 1200)
      }
    }

    ws.onerror = () => {
      setError('WebSocket error — is the backend running on :8000?')
    }

    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      if (msg.type === 'analysis') {
        const chunk = (msg.transcript || '').trim()
        if (chunk) {
          setTranscript((prev) => (prev ? `${prev}\n${chunk}` : chunk))
          setLiveLine('')
        }
        if (Array.isArray(msg.talking_points)) {
          setTalkingPoints(msg.talking_points)
        }
        if (msg.code?.update && msg.code?.content) {
          setCode({
            language: msg.code.language || '',
            filename: msg.code.filename || '',
            content: msg.code.content,
          })
        }
        if (msg.is_question && msg.answer_flash) {
          setFlash(msg.answer_flash)
          setFlashOn(true)
          window.setTimeout(() => setFlashOn(false), 6500)
        }
        if (msg.transcript_note) {
          setStatus(msg.transcript_note)
        } else {
          setStatus(msg.is_coding ? 'Coding context detected' : 'Listening')
        }
      }

      if (msg.type === 'transcript_partial' && msg.note) {
        setStatus(msg.note)
      }

      if (msg.type === 'error') {
        setError(msg.message || 'Server error')
      }

      if (msg.type === 'reset_ok') {
        setStatus('Session reset')
      }
    }
  }, [])

  useEffect(() => {
    connectWs()
    return () => {
      shouldListenRef.current = false
      wsRef.current?.close()
    }
  }, [connectWs])

  useEffect(() => {
    if (connected) {
      sendJson({ type: 'config', model })
    }
  }, [model, connected, sendJson])

  const stopMic = useCallback(() => {
    shouldListenRef.current = false
    setListening(false)

    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null
        recognitionRef.current.stop()
      } catch {
        /* ignore */
      }
      recognitionRef.current = null
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {
        /* ignore */
      }
    }
    mediaRecorderRef.current = null

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }

    setStatus(connected ? 'Connected' : 'Idle')
  }, [connected])

  const startBrowserSpeech = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return false

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      let interim = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript
        if (event.results[i].isFinal) finalText += `${piece} `
        else interim += piece
      }
      if (interim) setLiveLine(interim.trim())
      const cleaned = finalText.trim()
      if (cleaned) {
        setLiveLine('')
        sendJson({ type: 'transcript', text: cleaned })
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        setError('Microphone permission denied')
        stopMic()
      } else if (event.error !== 'no-speech') {
        setStatus(`Speech error: ${event.error}`)
      }
    }

    recognition.onend = () => {
      if (shouldListenRef.current) {
        try {
          recognition.start()
        } catch {
          /* ignore rapid restart errors */
        }
      }
    }

    recognitionRef.current = recognition
    recognition.start()
    return true
  }, [sendJson, stopMic])

  const startAudioFallback = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaStreamRef.current = stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size < 1000) return
      const buf = await event.data.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
      const audio_b64 = btoa(binary)
      sendJson({ type: 'audio_chunk', audio_b64, mime_type: mimeType })
    }

    recorder.start(4000)
    setStatus('Listening (audio chunks → model)')
  }, [sendJson])

  const startMic = useCallback(async () => {
    setError('')
    shouldListenRef.current = true
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connectWs()
    }

    try {
      const usedSpeech = startBrowserSpeech()
      if (!usedSpeech) {
        await startAudioFallback()
      } else {
        try {
          mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch {
          /* speech API can still work without holding the stream */
        }
        setStatus('Listening (live speech)')
      }
      setListening(true)
    } catch (err) {
      shouldListenRef.current = false
      setListening(false)
      setError(err?.message || 'Could not start microphone')
    }
  }, [connectWs, startAudioFallback, startBrowserSpeech])

  const resetSession = () => {
    setTranscript('')
    setLiveLine('')
    setTalkingPoints([])
    setCode({ language: '', filename: '', content: '' })
    setFlash('')
    setFlashOn(false)
    setError('')
    sendJson({ type: 'reset' })
  }

  const submitManual = () => {
    const text = manualText.trim()
    if (!text) return
    sendJson({ type: 'transcript', text })
    setManualText('')
  }

  const copyCode = async () => {
    if (!code.content) return
    try {
      await navigator.clipboard.writeText(code.content)
      setStatus('Code copied')
    } catch {
      setStatus('Copy failed')
    }
  }

  return (
    <div className="app">
      {flashOn && flash ? (
        <div className="flash-banner" role="alert">
          <div className="flash-label">Answer</div>
          <div className="flash-text">{flash}</div>
        </div>
      ) : null}

      <header className="topbar">
        <div className="brand">
          <span className="logo">IA</span>
          <div>
            <h1>InterAssist</h1>
            <p>Live interview listener · code · talking points · answers</p>
          </div>
        </div>

        <div className="controls">
          <label className="field">
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={listening}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={listening ? 'btn danger' : 'btn primary'}
            onClick={listening ? stopMic : startMic}
          >
            {listening ? 'Stop' : 'Start listening'}
          </button>
          <button type="button" className="btn ghost" onClick={resetSession}>
            Reset
          </button>
        </div>
      </header>

      <div className="status-row">
        <span className={`dot ${connected ? 'on' : 'off'}`} />
        <span>{connected ? 'Backend connected' : 'Backend offline'}</span>
        <span className="sep">·</span>
        <span>{status}</span>
        {error ? <span className="err"> · {error}</span> : null}
      </div>

      <main className="grid">
        <section className="panel transcript-panel">
          <div className="panel-head">
            <h2>Live transcript</h2>
            <span className="badge">{listening ? 'REC' : 'PAUSED'}</span>
          </div>
          <div className="panel-body transcript-body">
            {transcript || liveLine ? (
              <>
                <pre>{transcript}</pre>
                {liveLine ? <p className="interim">{liveLine}</p> : null}
                <div ref={transcriptEndRef} />
              </>
            ) : (
              <p className="empty">Press Start listening. Speech is transcribed live in the browser and sent to the AI.</p>
            )}
          </div>
          <div className="manual">
            <input
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitManual()
              }}
              placeholder="Or type / paste a line from the interview…"
            />
            <button type="button" className="btn ghost" onClick={submitManual}>
              Send
            </button>
          </div>
        </section>

        <section className="panel points-panel">
          <div className="panel-head">
            <h2>Talking points</h2>
          </div>
          <div className="panel-body">
            {talkingPoints.length ? (
              <ul>
                {talkingPoints.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="empty">Suggested points appear as the conversation moves.</p>
            )}
          </div>
        </section>

        <section className="panel code-panel">
          <div className="panel-head">
            <h2>Code draft</h2>
            <div className="code-meta">
              {code.filename ? <span>{code.filename}</span> : null}
              {code.language ? <span className="badge dim">{code.language}</span> : null}
              <button type="button" className="btn ghost small" onClick={copyCode} disabled={!code.content}>
                Copy
              </button>
            </div>
          </div>
          <div className="panel-body code-body">
            {code.content ? (
              <pre>
                <code>{code.content}</code>
              </pre>
            ) : (
              <p className="empty">When the interview turns to coding, a draft builds here automatically.</p>
            )}
          </div>
        </section>

        <section className="panel answer-panel">
          <div className="panel-head">
            <h2>Latest answer</h2>
          </div>
          <div className="panel-body">
            {flash ? (
              <p className="answer-text">{flash}</p>
            ) : (
              <p className="empty">Direct answers flash here (and across the top) when a question is detected.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
