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

const DBG = '[InterAssist]'

function log(...args) {
  console.log(DBG, ...args)
}

function logInfo(tag, payload) {
  if (payload === undefined) console.log(DBG, tag)
  else console.log(DBG, tag, payload)
}

function logWarn(tag, payload) {
  if (payload === undefined) console.warn(DBG, tag)
  else console.warn(DBG, tag, payload)
}

function logError(tag, payload) {
  if (payload === undefined) console.error(DBG, tag)
  else console.error(DBG, tag, payload)
}

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${window.location.host}/ws`
  logInfo('[ws] url', url)
  return url
}

async function debugFetch(path, options = {}) {
  const started = performance.now()
  logInfo('[http] request', { path, method: options.method || 'GET', options })
  try {
    const res = await fetch(path, options)
    const ms = Math.round(performance.now() - started)
    const clone = res.clone()
    let body
    try {
      body = await clone.json()
    } catch {
      try {
        body = await clone.text()
      } catch (err) {
        body = `(unreadable body: ${err})`
      }
    }
    if (!res.ok) {
      logError('[http] response error', {
        path,
        status: res.status,
        statusText: res.statusText,
        ms,
        body,
        headers: Object.fromEntries(res.headers.entries()),
      })
    } else {
      logInfo('[http] response ok', {
        path,
        status: res.status,
        ms,
        body,
      })
    }
    return res
  } catch (err) {
    logError('[http] fetch failed', {
      path,
      error: String(err),
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    })
    throw err
  }
}

function describeSpeechError(errorCode) {
  const map = {
    network:
      'Browser speech service network failure (Chrome needs Google speech servers). Falling back to mic audio chunks.',
    'not-allowed': 'Microphone permission denied.',
    'service-not-allowed': 'Speech service not allowed in this browser/context.',
    'audio-capture': 'No microphone / audio capture device available.',
    aborted: 'Speech recognition aborted.',
    'no-speech': 'No speech detected in this window.',
    'language-not-supported': 'Language not supported by speech recognition.',
    'bad-grammar': 'Speech grammar error.',
  }
  return map[errorCode] || `Speech error: ${errorCode}`
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
  const [debugLine, setDebugLine] = useState('debug: boot')

  const wsRef = useRef(null)
  const recognitionRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const shouldListenRef = useRef(false)
  const modelRef = useRef(model)
  const transcriptEndRef = useRef(null)
  const usingSpeechRef = useRef(false)
  const audioFallbackStartedRef = useRef(false)
  const msgCountRef = useRef(0)
  const heardCountRef = useRef(0)

  const setDebug = useCallback((line) => {
    setDebugLine(line)
    logInfo('[ui-status]', line)
  }, [])

  useEffect(() => {
    modelRef.current = model
    logInfo('[model] selected', model)
  }, [model])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, liveLine])

  useEffect(() => {
    logInfo('[boot]', {
      href: window.location.href,
      userAgent: navigator.userAgent,
      mediaDevices: !!navigator.mediaDevices,
      speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      mediaRecorder: typeof MediaRecorder !== 'undefined',
      secureContext: window.isSecureContext,
      protocol: window.location.protocol,
    })

    // Global error traps
    const onErr = (event) => {
      logError('[window.error]', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error ? String(event.error) : null,
        stack: event.error?.stack,
      })
      setError(`JS error: ${event.message}`)
    }
    const onRej = (event) => {
      logError('[window.unhandledrejection]', {
        reason: event.reason,
        message: event.reason?.message,
        stack: event.reason?.stack,
      })
      setError(`Promise rejection: ${event.reason?.message || String(event.reason)}`)
    }
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)

    debugFetch('/api/health')
      .then(async (r) => {
        if (!r.ok) return
        const data = await r.json()
        setDebug(`health ok model=${data.model} has_key=${data.has_key}`)
      })
      .catch((err) => {
        setError(`Health check failed: ${err.message}`)
        setDebug(`health failed: ${err.message}`)
      })

    debugFetch('/api/config')
      .then(async (r) => {
        if (!r.ok) return
        const data = await r.json()
        if (Array.isArray(data.models) && data.models.length) setModels(data.models)
        if (data.default_model) setModel(data.default_model)
      })
      .catch((err) => logError('[config] load failed', err))

    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [setDebug])

  const sendJson = useCallback((payload) => {
    const ws = wsRef.current
    const state = ws?.readyState
    const stateName = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state] || String(state)
    if (!ws || state !== WebSocket.OPEN) {
      logError('[ws] send skipped — socket not open', { state: stateName, payload })
      setError(`WebSocket not open (${stateName}) — is backend running?`)
      return false
    }
    try {
      const raw = JSON.stringify(payload)
      logInfo('[ws] send', {
        type: payload.type,
        bytes: raw.length,
        preview:
          payload.type === 'audio_chunk'
            ? { mime_type: payload.mime_type, audio_b64_len: payload.audio_b64?.length }
            : payload,
      })
      ws.send(raw)
      return true
    } catch (err) {
      logError('[ws] send failed', { err: String(err), stack: err?.stack, payload })
      setError(`WS send failed: ${err.message || err}`)
      return false
    }
  }, [])

  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) {
      logInfo('[ws] already connecting/open', { readyState: wsRef.current.readyState })
      return
    }

    const url = wsUrl()
    logInfo('[ws] connecting…', url)
    setDebug(`ws connecting ${url}`)
    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      logError('[ws] constructor failed', err)
      setError(`WS construct failed: ${err.message}`)
      return
    }
    wsRef.current = ws

    ws.onopen = (ev) => {
      logInfo('[ws] open', { type: ev.type, url })
      setConnected(true)
      setStatus('Connected')
      setError('')
      setDebug('ws open')
      sendJson({ type: 'config', model: modelRef.current })
    }

    ws.onclose = (ev) => {
      logWarn('[ws] close', {
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
        shouldListen: shouldListenRef.current,
      })
      setConnected(false)
      setStatus(shouldListenRef.current ? 'Reconnecting…' : 'Disconnected')
      setDebug(`ws closed code=${ev.code} reason=${ev.reason || '(none)'}`)
      wsRef.current = null
      if (shouldListenRef.current) {
        setTimeout(() => {
          logInfo('[ws] reconnect timer fired')
          connectWs()
        }, 1200)
      }
    }

    ws.onerror = (ev) => {
      logError('[ws] error event', {
        type: ev.type,
        readyState: ws.readyState,
        url,
      })
      setError('WebSocket error — is the backend running on :8000?')
      setDebug('ws error')
    }

    ws.onmessage = (event) => {
      msgCountRef.current += 1
      const n = msgCountRef.current
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch (err) {
        logError('[ws] invalid JSON message', {
          n,
          rawPreview: String(event.data).slice(0, 500),
          err: String(err),
        })
        return
      }

      logInfo('[ws] recv', {
        n,
        type: msg.type,
        keys: Object.keys(msg),
        msg:
          msg.type === 'analysis'
            ? {
                type: msg.type,
                transcript: msg.transcript,
                is_coding: msg.is_coding,
                is_question: msg.is_question,
                answer_flash: msg.answer_flash,
                talking_points: msg.talking_points,
                code_update: msg.code?.update,
                code_lang: msg.code?.language,
                code_len: msg.code?.content?.length || 0,
                model: msg.model,
                transcript_note: msg.transcript_note,
              }
            : msg,
      })

      if (msg.type === 'analysis') {
        const chunk = (msg.transcript || '').trim()
        if (chunk) {
          logInfo('[conversation][server]', chunk)
          setTranscript((prev) => (prev ? `${prev}\n${chunk}` : chunk))
          setLiveLine('')
        }
        if (Array.isArray(msg.talking_points)) {
          logInfo('[ai] talking_points', msg.talking_points)
          setTalkingPoints(msg.talking_points)
        }
        if (msg.code?.update && msg.code?.content) {
          logInfo('[ai] code draft update', {
            language: msg.code.language,
            filename: msg.code.filename,
            chars: msg.code.content.length,
            preview: msg.code.content.slice(0, 200),
          })
          setCode({
            language: msg.code.language || '',
            filename: msg.code.filename || '',
            content: msg.code.content,
          })
        } else {
          logInfo('[ai] no code update', {
            is_coding: msg.is_coding,
            update: msg.code?.update,
            contentLen: msg.code?.content?.length || 0,
          })
        }
        if (msg.is_question && msg.answer_flash) {
          logInfo('[ai] answer flash', msg.answer_flash)
          setFlash(msg.answer_flash)
          setFlashOn(true)
          window.setTimeout(() => setFlashOn(false), 6500)
        }
        if (msg.transcript_note) {
          logWarn('[ai] transcript_note', msg.transcript_note)
          setStatus(msg.transcript_note)
          if (String(msg.transcript_note).toLowerCase().includes('error')) {
            setError(String(msg.transcript_note))
          }
        } else {
          setStatus(msg.is_coding ? 'Coding context detected' : 'Listening')
        }
        setDebug(
          `analysis #${n} coding=${!!msg.is_coding} q=${!!msg.is_question} points=${(msg.talking_points || []).length}`,
        )
      }

      if (msg.type === 'transcript_partial') {
        logWarn('[ws] transcript_partial', msg)
        if (msg.note) setStatus(msg.note)
        setDebug(`partial: ${msg.note || msg.text || '(empty)'}`)
      }

      if (msg.type === 'config_ok') {
        logInfo('[ws] config_ok', msg)
        setDebug(`config_ok model=${msg.model}`)
      }

      if (msg.type === 'reset_ok') {
        logInfo('[ws] reset_ok', msg)
        setStatus('Session reset')
      }

      if (msg.type === 'error') {
        logError('[ws] server error message', msg)
        setError(msg.message || 'Server error')
        setDebug(`server error: ${msg.message}`)
      }
    }
  }, [sendJson, setDebug])

  useEffect(() => {
    connectWs()
    return () => {
      shouldListenRef.current = false
      logInfo('[ws] cleanup close')
      try {
        wsRef.current?.close()
      } catch (err) {
        logError('[ws] cleanup close failed', err)
      }
    }
  }, [connectWs])

  useEffect(() => {
    if (connected) {
      logInfo('[ws] pushing model config', model)
      sendJson({ type: 'config', model })
    }
  }, [model, connected, sendJson])

  const stopSpeechOnly = useCallback(() => {
    if (recognitionRef.current) {
      logInfo('[speech] stopping recognition')
      try {
        recognitionRef.current.onend = null
        recognitionRef.current.onerror = null
        recognitionRef.current.onresult = null
        recognitionRef.current.stop()
      } catch (err) {
        logWarn('[speech] stop threw', err)
      }
      recognitionRef.current = null
    }
    usingSpeechRef.current = false
  }, [])

  const stopMic = useCallback(() => {
    logInfo('[mic] stop requested')
    shouldListenRef.current = false
    setListening(false)
    audioFallbackStartedRef.current = false
    stopSpeechOnly()

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      logInfo('[audio] stopping MediaRecorder', { state: mediaRecorderRef.current.state })
      try {
        mediaRecorderRef.current.ondataavailable = null
        mediaRecorderRef.current.stop()
      } catch (err) {
        logWarn('[audio] MediaRecorder stop threw', err)
      }
    }
    mediaRecorderRef.current = null

    if (mediaStreamRef.current) {
      const tracks = mediaStreamRef.current.getTracks()
      logInfo('[mic] stopping tracks', tracks.map((t) => ({ kind: t.kind, label: t.label, readyState: t.readyState })))
      tracks.forEach((t) => t.stop())
      mediaStreamRef.current = null
    }

    setStatus(connected ? 'Connected' : 'Idle')
    setDebug('mic stopped')
  }, [connected, setDebug, stopSpeechOnly])

  const startAudioFallback = useCallback(async (reason = 'manual') => {
    if (audioFallbackStartedRef.current) {
      logInfo('[audio] fallback already running', { reason })
      return
    }
    audioFallbackStartedRef.current = true
    logWarn('[audio] starting MediaRecorder fallback', { reason })
    setDebug(`audio fallback: ${reason}`)

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('navigator.mediaDevices.getUserMedia unavailable')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      })
      mediaStreamRef.current = stream
      const tracks = stream.getAudioTracks()
      logInfo('[audio] got stream', {
        tracks: tracks.map((t) => ({
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
          settings: t.getSettings?.(),
        })),
      })

      if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder not supported in this browser')
      }

      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ]
      const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || ''
      logInfo('[audio] MediaRecorder mime', {
        mimeType: mimeType || '(browser default)',
        support: Object.fromEntries(candidates.map((t) => [t, MediaRecorder.isTypeSupported(t)])),
      })

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      let chunkIndex = 0
      recorder.onstart = () => logInfo('[audio] recorder start', { state: recorder.state, mimeType: recorder.mimeType })
      recorder.onstop = () => logInfo('[audio] recorder stop', { state: recorder.state })
      recorder.onerror = (ev) => {
        logError('[audio] recorder error', {
          error: ev.error,
          name: ev.error?.name,
          message: ev.error?.message,
        })
        setError(`MediaRecorder error: ${ev.error?.message || ev.error?.name || 'unknown'}`)
      }

      recorder.ondataavailable = async (event) => {
        chunkIndex += 1
        const size = event.data?.size || 0
        logInfo('[audio] dataavailable', {
          chunkIndex,
          bytes: size,
          type: event.data?.type,
          mimeType: recorder.mimeType,
          at: new Date().toISOString(),
        })
        if (!event.data || size < 500) {
          logWarn('[audio] chunk too small, skipping', { size, chunkIndex })
          return
        }
        try {
          const buf = await event.data.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          const step = 0x8000
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode(...bytes.subarray(i, i + step))
          }
          const audio_b64 = btoa(binary)
          logInfo('[audio] sending chunk to backend', {
            chunkIndex,
            bytes: bytes.length,
            b64len: audio_b64.length,
          })
          const ok = sendJson({
            type: 'audio_chunk',
            audio_b64,
            mime_type: recorder.mimeType || mimeType || 'audio/webm',
          })
          if (!ok) logError('[audio] failed to queue chunk on ws', { chunkIndex })
        } catch (err) {
          logError('[audio] chunk processing failed', {
            chunkIndex,
            err: String(err),
            stack: err?.stack,
          })
        }
      }

      // 3s slices — better for nearby loud speaker audio
      recorder.start(3000)
      setStatus('Listening (audio chunks → model)')
      setListening(true)
      logInfo('[audio] fallback listening active')
    } catch (err) {
      audioFallbackStartedRef.current = false
      logError('[audio] fallback failed', {
        err: String(err),
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      })
      setError(`Audio fallback failed: ${err.message || err}`)
      setDebug(`audio fallback failed: ${err.message || err}`)
      throw err
    }
  }, [sendJson, setDebug])

  const startBrowserSpeech = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    logInfo('[speech] API present?', {
      SpeechRecognition: !!window.SpeechRecognition,
      webkitSpeechRecognition: !!window.webkitSpeechRecognition,
      chosen: !!SpeechRecognition,
    })
    if (!SpeechRecognition) {
      logWarn('[speech] not available in this browser')
      return false
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.maxAlternatives = 3

    recognition.onstart = () => {
      logInfo('[speech] onstart')
      setDebug('speech onstart')
    }

    recognition.onaudiostart = () => logInfo('[speech] onaudiostart')
    recognition.onaudioend = () => logInfo('[speech] onaudioend')
    recognition.onsoundstart = () => logInfo('[speech] onsoundstart — mic hearing sound')
    recognition.onsoundend = () => logInfo('[speech] onsoundend')
    recognition.onspeechstart = () => logInfo('[speech] onspeechstart — speech detected')
    recognition.onspeechend = () => logInfo('[speech] onspeechend')

    recognition.onresult = (event) => {
      logInfo('[speech] onresult', {
        resultIndex: event.resultIndex,
        resultsLength: event.results.length,
      })
      let interim = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const alts = []
        for (let a = 0; a < result.length; a += 1) {
          alts.push({
            transcript: result[a].transcript,
            confidence: result[a].confidence,
          })
        }
        const best = result[0]
        const piece = best?.transcript || ''
        heardCountRef.current += 1
        if (result.isFinal) {
          finalText += `${piece} `
          logInfo('[heard:final]', {
            n: heardCountRef.current,
            text: piece.trim(),
            confidence: best?.confidence,
            alternatives: alts,
            at: new Date().toISOString(),
          })
        } else {
          interim += piece
          logInfo('[heard:interim]', {
            n: heardCountRef.current,
            text: piece.trim(),
            confidence: best?.confidence,
            alternatives: alts,
            at: new Date().toISOString(),
          })
        }
      }
      if (interim) setLiveLine(interim.trim())
      const cleaned = finalText.trim()
      if (cleaned) {
        setLiveLine('')
        logInfo('[conversation]', cleaned)
        sendJson({ type: 'transcript', text: cleaned })
      }
    }

    recognition.onerror = (event) => {
      const code = event.error
      const detail = describeSpeechError(code)
      logError('[speech] onerror', {
        error: code,
        message: event.message,
        detail,
        event,
      })
      setDebug(`speech error: ${code}`)

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError(detail)
        stopMic()
        return
      }

      if (code === 'network' || code === 'audio-capture') {
        setError(detail)
        setStatus(detail)
        // Chrome speech often dies with network — switch to audio path
        stopSpeechOnly()
        startAudioFallback(`speech-error:${code}`).catch((err) => {
          logError('[speech->audio] fallback failed after speech error', err)
        })
        return
      }

      if (code !== 'no-speech' && code !== 'aborted') {
        setStatus(`Speech error: ${code}`)
        setError(detail)
      }
    }

    recognition.onend = () => {
      logWarn('[speech] onend', {
        shouldListen: shouldListenRef.current,
        usingSpeech: usingSpeechRef.current,
        audioFallback: audioFallbackStartedRef.current,
      })
      if (shouldListenRef.current && usingSpeechRef.current && !audioFallbackStartedRef.current) {
        try {
          logInfo('[speech] restarting after onend')
          recognition.start()
        } catch (err) {
          logWarn('[speech] restart failed', { err: String(err), message: err?.message })
          startAudioFallback('speech-restart-failed').catch((e) => logError(e))
        }
      }
    }

    recognitionRef.current = recognition
    usingSpeechRef.current = true
    try {
      recognition.start()
      logInfo('[speech] start() called')
      return true
    } catch (err) {
      logError('[speech] start() threw', err)
      usingSpeechRef.current = false
      recognitionRef.current = null
      return false
    }
  }, [sendJson, setDebug, startAudioFallback, stopMic, stopSpeechOnly])

  const startMic = useCallback(async () => {
    logInfo('[mic] start requested')
    setError('')
    shouldListenRef.current = true
    audioFallbackStartedRef.current = false
    heardCountRef.current = 0

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      logWarn('[mic] ws not open, connecting first', { readyState: wsRef.current?.readyState })
      connectWs()
    }

    try {
      // Probe mic first so we fail early with a clear error
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia unavailable (needs secure context / permissions)')
      }
      const probe = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      })
      logInfo('[mic] permission/probe ok', {
        tracks: probe.getTracks().map((t) => ({ label: t.label, readyState: t.readyState, settings: t.getSettings?.() })),
      })
      // Keep stream for level / fallback; speech API uses its own capture too
      mediaStreamRef.current = probe

      const usedSpeech = startBrowserSpeech()
      if (!usedSpeech) {
        logWarn('[mic] speech unavailable — using audio fallback immediately')
        await startAudioFallback('no-speech-api')
      } else {
        // Also start audio fallback in parallel after a short delay if speech is quiet,
        // but only auto-switch on speech network errors (handled in onerror).
        setStatus('Listening (live speech)')
        setListening(true)
        setDebug('listening via Web Speech API')
        logInfo('[mic] listening via Web Speech API (nearby speaker audio should appear as interim/final logs)')
      }
    } catch (err) {
      shouldListenRef.current = false
      setListening(false)
      logError('[mic] start failed', {
        err: String(err),
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      })
      setError(err?.message || 'Could not start microphone')
      setDebug(`mic start failed: ${err?.message || err}`)
    }
  }, [connectWs, setDebug, startAudioFallback, startBrowserSpeech])

  const resetSession = () => {
    logInfo('[session] reset')
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
    logInfo('[conversation][manual]', text)
    const ok = sendJson({ type: 'transcript', text })
    if (!ok) logError('[manual] send failed')
    setManualText('')
  }

  const copyCode = async () => {
    if (!code.content) return
    try {
      await navigator.clipboard.writeText(code.content)
      setStatus('Code copied')
      logInfo('[ui] code copied', { chars: code.content.length })
    } catch (err) {
      logError('[ui] copy failed', err)
      setStatus('Copy failed')
    }
  }

  const forceAudioMode = async () => {
    logWarn('[ui] force audio mode clicked')
    shouldListenRef.current = true
    stopSpeechOnly()
    try {
      await startAudioFallback('user-forced')
      setListening(true)
    } catch (err) {
      setError(err.message || String(err))
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
          <button type="button" className="btn ghost" onClick={forceAudioMode}>
            Force audio mode
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
      <div className="status-row debug-row">
        <span className="sep">debug:</span>
        <span>{debugLine}</span>
        <span className="sep">·</span>
        <span>open DevTools Console for full logs</span>
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
              <p className="empty">
                Press Start listening. If you see Speech error: network, the app auto-falls back to mic
                audio chunks (or click Force audio mode). Watch the browser console for every word/chunk.
              </p>
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
