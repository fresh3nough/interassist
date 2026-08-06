import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const DEFAULT_MODEL = 'x-ai/grok-4.5'
const AUDIO_FALLBACK_CLIP_MS = 2500
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
function isActionablePriorityText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (/^(?:ok(?:ay)?|alright|sure|yes|no|right|got it|understood|thanks?|thank you|bye(?:[ -]?bye)?|goodbye|great|awesome|perfect|sounds good|no problem|hello|hi|hey)[.!?,\s]*$/i.test(text)) {
    return false
  }
  if (/^(?:and|or|but|because|so|then|also|as|that|which)\b/i.test(text)) return false
  if (text.length < 3) return false
  return (
    text.includes('?') ||
    /(?:^|[.!?]\s+)(?:what|why|how|when|where|who|which|can|could|would|do|did|are|is|have|has|tell|explain|describe|walk|give|show|please)\b/i.test(
      text,
    ) ||
    /(?:^|[.!?]\s+)(?:build|write|implement|create|make)\b/i.test(text)
  )
}

function samePriorityQuestion(left, right) {
  const a = String(left || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const b = String(right || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return a === b || (a.length > 20 && b.length > 20 && (a.includes(b) || b.includes(a)))
}
function tsClock() {
  const d = new Date()
  return d.toLocaleTimeString('en-US', { hour12: false })
}

/** Anime/dub style subtitle lines in the console — words only. */
function logSubtitle(kind, text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (!line) return
  const stamp = tsClock()
  const styles = {
    interim: 'color:#ffd6ef; background:#2a1030; font-size:14px; font-weight:700; padding:4px 10px; border-radius:8px; border-left:4px solid #ff7ad9',
    final: 'color:#e8fff4; background:#0f2a22; font-size:15px; font-weight:800; padding:5px 12px; border-radius:8px; border-left:4px solid #35e0a1',
    server: 'color:#eaf2ff; background:#101a33; font-size:15px; font-weight:800; padding:5px 12px; border-radius:8px; border-left:4px solid #6ea0ff',
    manual: 'color:#fff7e6; background:#2a220f; font-size:15px; font-weight:800; padding:5px 12px; border-radius:8px; border-left:4px solid #ffc857',
  }
  const labels = {
    interim: '⋯ LIVE',
    final: '▶ LINE',
    server: '字幕 SUB',
    manual: '✎ TYPE',
  }
  const style = styles[kind] || styles.final
  const label = labels[kind] || '▶ LINE'
  // one styled line for the spoken words themselves
  console.log(`%c${label}  ${stamp}  ${line}`, style)
  // also dump plain words for easy copy/filter
  console.log(line)
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
  const [summary, setSummary] = useState('')
  const [code, setCode] = useState({ language: '', filename: '', content: '' })
  const [flash, setFlash] = useState('')
  const [flashOn, setFlashOn] = useState(false)
  const [priorityAnswers, setPriorityAnswers] = useState([])
  const [pendingQuestions, setPendingQuestions] = useState([])
  const [queueSize, setQueueSize] = useState(0)
  const [error, setError] = useState('')
  const [manualText, setManualText] = useState('')
  const [debugLine, setDebugLine] = useState('debug: boot')

  const wsRef = useRef(null)
  const recognitionRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const realtimePeerRef = useRef(null)
  const realtimeChannelRef = useRef(null)
  const realtimeStreamRef = useRef(null)
  const realtimeDeltasRef = useRef(new Map())
  const realtimeCompletedRef = useRef(new Set())
  const pendingCompletedTranscriptsRef = useRef([])
  const optimisticTranscriptCountsRef = useRef(new Map())
  const serverTranscriptCountsRef = useRef(new Map())
  const realtimeAvailableRef = useRef(null)
  const shouldListenRef = useRef(false)
  const modelRef = useRef(model)
  const transcriptBodyRef = useRef(null)
  const usingSpeechRef = useRef(false)
  const audioFallbackStartedRef = useRef(false)
  const msgCountRef = useRef(0)
  const heardCountRef = useRef(0)
  const audioCycleTimerRef = useRef(null)
  const audioChunkIndexRef = useRef(0)

  const setDebug = useCallback((line) => {
    setDebugLine(line)
    logInfo('[ui-status]', line)
  }, [])

  useEffect(() => {
    modelRef.current = model
    logInfo('[model] selected', model)
  }, [model])

  useEffect(() => {
    const body = transcriptBodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [transcript, liveLine])

  const appendLiveTranscript = useCallback((previous, chunk) => {
    const lines = `${previous ? `${previous}\n` : ''}${chunk}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.slice(-60).join('\n')
  }, [])

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
        realtimeAvailableRef.current = Boolean(data.realtime_available)
        setDebug(
          `health ok model=${data.model} openrouter=${data.has_key} realtime=${data.realtime_available}`,
        )
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
        realtimeAvailableRef.current = Boolean(data.realtime_available)
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

  // Realtime deltas stay local; only finalized turns enter the slower analysis queue.
  const sendCompletedTranscript = useCallback(
    (text) => {
      const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
      if (!cleaned) return

      const key = cleaned.toLowerCase()
      optimisticTranscriptCountsRef.current.set(
        key,
        (optimisticTranscriptCountsRef.current.get(key) || 0) + 1,
      )
      setTranscript((prev) => appendLiveTranscript(prev, cleaned))
      setLiveLine('')

      if (!sendJson({ type: 'transcript', text: cleaned })) {
        pendingCompletedTranscriptsRef.current.push(cleaned)
        logWarn('[realtime] completed turn queued until ws opens', cleaned)
      }
    },
    [appendLiveTranscript, sendJson],
  )
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
      const pending = pendingCompletedTranscriptsRef.current.splice(0)
      if (pending.length) {
        logInfo('[ws] flushing completed Realtime turns', { count: pending.length })
        pending.forEach((text) => sendJson({ type: 'transcript', text }))
      }
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

      if (msg.type === 'transcript') {
        const chunk = String(msg.transcript || '').trim()
        if (chunk) {
          logSubtitle('server', chunk)
          const key = chunk.toLowerCase()
          serverTranscriptCountsRef.current.set(
            key,
            (serverTranscriptCountsRef.current.get(key) || 0) + 1,
          )
          setTranscript((prev) => appendLiveTranscript(prev, chunk))
          setLiveLine('')
          setStatus('Listening')
          setDebug(`transcript seq=${msg.sequence ?? '?'}`)
        }
        return
      }

      if (msg.type === 'analysis') {
        const chunk = (msg.transcript || '').trim()
        if (chunk) {
          logSubtitle('server', chunk)
          const key = chunk.toLowerCase()
          const serverCount = serverTranscriptCountsRef.current.get(key) || 0
          if (serverCount > 0) {
            if (serverCount === 1) serverTranscriptCountsRef.current.delete(key)
            else serverTranscriptCountsRef.current.set(key, serverCount - 1)
            logInfo('[transcript] server echo reconciled', chunk)
          } else {
            const optimisticCount = optimisticTranscriptCountsRef.current.get(key) || 0
            if (optimisticCount > 0) {
              if (optimisticCount === 1) optimisticTranscriptCountsRef.current.delete(key)
              else optimisticTranscriptCountsRef.current.set(key, optimisticCount - 1)
              logInfo('[transcript] Realtime echo reconciled', chunk)
            } else {
              setTranscript((prev) => appendLiveTranscript(prev, chunk))
            }
          }
          setLiveLine('')
        }
        if (msg.summary) {
          logInfo('[ai] summary', msg.summary)
          setSummary(String(msg.summary))
        }
        if (Array.isArray(msg.talking_points)) {
          logInfo('[ai] talking_points', msg.talking_points)
          setTalkingPoints(msg.talking_points)
        }
        if (msg.code?.content && (msg.code?.update || msg.is_coding)) {
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
        if (msg.answer_flash) {
          logInfo('[ai] answer flash', msg.answer_flash)
          setFlash(msg.answer_flash)
          setFlashOn(true)
          window.setTimeout(() => setFlashOn(false), 8000)
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

      if (msg.type === 'question_detected' || msg.type === 'question_queued') {
        const q = String(msg.question || '').trim()
        logInfo('[priority] question event', msg)
        if (q && isActionablePriorityText(q)) {
          setPendingQuestions((prev) => {
            if (prev.some((x) => x.toLowerCase() === q.toLowerCase())) return prev
            return [q, ...prev].slice(0, 8)
          })
        } else if (q) {
          logWarn('[priority] ignored non-question event', q)
          return
        }
        if (typeof msg.queue_size === 'number') setQueueSize(msg.queue_size)
        setDebug(`Q priority queued (${msg.queue_size ?? '?'}): ${q.slice(0, 80)}`)
        setStatus('Priority question queued')
      }

      if (msg.type === 'priority_answer') {
        const q = String(msg.question || '').trim()
        const a = String(msg.answer || '').trim()
        const pts = Array.isArray(msg.key_points) ? msg.key_points : []
        logInfo('[priority] answer', { q, a, pts, remaining: msg.queue_remaining })
        console.log(
          `%c⚡ PRIORITY Q  ${q}`,
          'color:#fff; background:#7a1f2b; font-size:14px; font-weight:900; padding:6px 12px; border-radius:8px; border-left:5px solid #ff4d6d'
        )
        console.log(
          `%c⚡ ANSWER  ${a}`,
          'color:#081018; background:#ffe566; font-size:15px; font-weight:900; padding:6px 12px; border-radius:8px; border-left:5px solid #ffb703'
        )
        if (a) {
          setPriorityAnswers((prev) => {
            const next = [
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                question: q,
                answer: a,
                key_points: pts,
                ts: msg.ts || Date.now() / 1000,
              },
              ...prev,
            ]
            return next.slice(0, 12)
          })
          setPendingQuestions((prev) => prev.filter((x) => !samePriorityQuestion(x, q)))
          setFlash(a)
          setFlashOn(true)
          window.setTimeout(() => setFlashOn(false), 9000)
        }
        if (typeof msg.queue_remaining === 'number') setQueueSize(msg.queue_remaining)
        setStatus('Priority answer ready')
        setDebug(`priority answer ready · queue left ${msg.queue_remaining ?? 0}`)
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
  }, [appendLiveTranscript, sendJson, setDebug])

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
  const stopRealtime = useCallback(() => {
    realtimeCompletedRef.current.clear()
    realtimeDeltasRef.current.clear()
    if (realtimeChannelRef.current) {
      try {
        realtimeChannelRef.current.close()
      } catch (err) {
        logWarn('[realtime] data channel close threw', err)
      }
      realtimeChannelRef.current = null
    }
    if (realtimePeerRef.current) {
      try {
        realtimePeerRef.current.close()
      } catch (err) {
        logWarn('[realtime] peer connection close threw', err)
      }
      realtimePeerRef.current = null
    }
    if (realtimeStreamRef.current) {
      const tracks = realtimeStreamRef.current.getTracks()
      logInfo('[realtime] stopping tracks', tracks.map((t) => ({ label: t.label, readyState: t.readyState })))
      tracks.forEach((track) => track.stop())
      realtimeStreamRef.current = null
    }
  }, [])

  const stopMic = useCallback(() => {
    logInfo('[mic] stop requested')
    shouldListenRef.current = false
    setListening(false)
    audioFallbackStartedRef.current = false
    if (audioCycleTimerRef.current) {
      clearTimeout(audioCycleTimerRef.current)
      audioCycleTimerRef.current = null
    }
    stopSpeechOnly()
    stopRealtime()

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
  }, [connected, setDebug, stopRealtime, stopSpeechOnly])

  const startAudioFallback = useCallback(async (reason = 'manual') => {
    if (audioFallbackStartedRef.current) {
      logInfo('[audio] fallback already running', { reason })
      return
    }
    audioFallbackStartedRef.current = true
    logWarn('[audio] starting complete-file MediaRecorder cycle', { reason })
    setDebug(`audio fallback: ${reason}`)

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('navigator.mediaDevices.getUserMedia unavailable')
      }

      // Prefer a fresh stream for recording so speech probe stream is not reused oddly
      if (mediaStreamRef.current) {
        try {
          mediaStreamRef.current.getTracks().forEach((tr) => tr.stop())
        } catch {
          /* ignore */
        }
        mediaStreamRef.current = null
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      mediaStreamRef.current = stream
      const tracks = stream.getAudioTracks()
      logInfo('[audio] got stream', {
        tracks: tracks.map((tr) => ({
          label: tr.label,
          enabled: tr.enabled,
          muted: tr.muted,
          readyState: tr.readyState,
          settings: tr.getSettings?.(),
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
      const mimeType = candidates.find((x) => MediaRecorder.isTypeSupported(x)) || ''
      logInfo('[audio] MediaRecorder mime', {
        mimeType: mimeType || '(browser default)',
        support: Object.fromEntries(candidates.map((x) => [x, MediaRecorder.isTypeSupported(x)])),
      })

      const sendBlob = async (blob, idx) => {
        const size = blob?.size || 0
        logInfo('[audio] complete clip ready', {
          chunkIndex: idx,
          bytes: size,
          type: blob?.type,
          at: new Date().toISOString(),
        })
        if (!blob || size < 2000) {
          logWarn('[audio] clip too small, skipping', { size, chunkIndex: idx })
          return
        }
        try {
          const buf = await blob.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          const step = 0x8000
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode(...bytes.subarray(i, i + step))
          }
          const audio_b64 = btoa(binary)
          logInfo('[audio] sending complete clip', {
            chunkIndex: idx,
            bytes: bytes.length,
            b64len: audio_b64.length,
            header: Array.from(bytes.slice(0, 4)),
          })
          const ok = sendJson({
            type: 'audio_chunk',
            audio_b64,
            mime_type: blob.type || mimeType || 'audio/webm',
          })
          if (!ok) logError('[audio] failed to queue clip on ws', { chunkIndex: idx })
        } catch (err) {
          logError('[audio] clip processing failed', {
            chunkIndex: idx,
            err: String(err),
            stack: err?.stack,
          })
        }
      }

      const startCycle = () => {
        if (!shouldListenRef.current || !mediaStreamRef.current) return
        const parts = []
        let recorder
        try {
          recorder = mimeType
            ? new MediaRecorder(mediaStreamRef.current, { mimeType })
            : new MediaRecorder(mediaStreamRef.current)
        } catch (err) {
          logError('[audio] MediaRecorder construct failed', err)
          return
        }
        mediaRecorderRef.current = recorder

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) parts.push(event.data)
        }

        recorder.onerror = (ev) => {
          logError('[audio] recorder error', {
            error: ev.error,
            name: ev.error?.name,
            message: ev.error?.message,
          })
          setError(`MediaRecorder error: ${ev.error?.message || ev.error?.name || 'unknown'}`)
        }

        recorder.onstop = async () => {
          const idx = ++audioChunkIndexRef.current
          const type = recorder.mimeType || mimeType || 'audio/webm'
          const blob = new Blob(parts, { type })
          await sendBlob(blob, idx)
          // schedule next complete clip
          if (shouldListenRef.current && audioFallbackStartedRef.current) {
            audioCycleTimerRef.current = window.setTimeout(startCycle, 50)
          }
        }

        try {
          // NO timeslice — one complete file per cycle (fixes Whisper 400s on partial webm)
          recorder.start()
          logInfo('[audio] cycle started', { state: recorder.state, mimeType: recorder.mimeType })
        } catch (err) {
          logError('[audio] recorder.start failed', err)
          return
        }

        audioCycleTimerRef.current = window.setTimeout(() => {
          if (recorder.state === 'recording') {
            try {
              recorder.requestData?.()
              recorder.stop()
            } catch (err) {
              logWarn('[audio] stop cycle threw', err)
            }
          }
        }, AUDIO_FALLBACK_CLIP_MS)
      }

      startCycle()
      setStatus(
        reason.includes('openrouter-only') || reason.includes('OPENAI_API_KEY')
          ? 'Listening (OpenRouter Whisper fallback)'
          : `Listening (Whisper clips every ${AUDIO_FALLBACK_CLIP_MS / 1000}s)`,
      )
      setListening(true)
      logInfo('[audio] fallback listening active — complete clips every %sms', AUDIO_FALLBACK_CLIP_MS)
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

  // Capture browser audio over WebRTC so OpenAI can emit transcript deltas without file chunks.
  const startRealtime = useCallback(async () => {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC is not supported in this browser')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia unavailable (use localhost or HTTPS)')
    }

    stopRealtime()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    realtimeStreamRef.current = stream
    logInfo('[realtime] microphone stream ready', {
      tracks: stream.getAudioTracks().map((track) => ({
        label: track.label,
        settings: track.getSettings?.(),
      })),
    })

    const peer = new RTCPeerConnection()
    const channel = peer.createDataChannel('oai-events')
    realtimePeerRef.current = peer
    realtimeChannelRef.current = channel
    stream.getTracks().forEach((track) => peer.addTrack(track, stream))

    const startFallback = (reason) => {
      if (!shouldListenRef.current || audioFallbackStartedRef.current) return
      logWarn('[realtime] falling back to complete-file transcription', reason)
      stopRealtime()
      startAudioFallback(reason).catch((fallbackError) => {
        logError('[realtime] fallback failed', fallbackError)
        setError(`Realtime and audio fallback failed: ${fallbackError.message || fallbackError}`)
        setListening(false)
      })
    }

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState
      logInfo('[realtime] connection state', state)
      if (state === 'failed') startFallback('realtime-connection-failed')
      if (state === 'disconnected') {
        window.setTimeout(() => {
          if (peer.connectionState === 'disconnected') startFallback('realtime-connection-disconnected')
        }, 1500)
      }
    }

    channel.onopen = () => {
      logInfo('[realtime] data channel open')
      setStatus('Listening (OpenAI Realtime)')
      setListening(true)
      setDebug('OpenAI Realtime connected')
    }

    channel.onclose = () => {
      logWarn('[realtime] data channel closed', {
        shouldListen: shouldListenRef.current,
        connectionState: peer.connectionState,
      })
      if (shouldListenRef.current && peer.connectionState !== 'closed') {
        startFallback('realtime-data-channel-closed')
      }
    }

    channel.onerror = (event) => {
      logError('[realtime] data channel error', event)
      setError('OpenAI Realtime data channel error')
    }
    channel.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (err) {
        logError('[realtime] invalid event JSON', { raw: String(event.data).slice(0, 500), err })
        return
      }
      logInfo('[realtime] event', {
        type: message.type,
        item_id: message.item_id,
        delta_chars: message.delta?.length,
        transcript_chars: message.transcript?.length,
      })

      if (message.type === 'conversation.item.input_audio_transcription.delta') {
        const itemId = message.item_id || 'current'
        const current = `${realtimeDeltasRef.current.get(itemId) || ''}${message.delta || ''}`.trim()
        realtimeDeltasRef.current.set(itemId, current)
        if (current) {
          setLiveLine(current)
          logSubtitle('interim', current)
        }
        return
      }

      if (message.type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = message.item_id || `completed-${Date.now()}`
        if (realtimeCompletedRef.current.has(itemId)) return
        realtimeCompletedRef.current.add(itemId)
        const finalText = String(
          message.transcript || realtimeDeltasRef.current.get(itemId) || '',
        ).trim()
        realtimeDeltasRef.current.delete(itemId)
        if (!finalText) return
        logSubtitle('final', finalText)
        sendCompletedTranscript(finalText)
        setStatus('Realtime turn complete · analyzing')
        return
      }

      if (message.type === 'error') {
        const detail = message.error?.message || message.message || 'OpenAI Realtime error'
        logError('[realtime] server error', message)
        setError(detail)
        startFallback(`realtime-server-error:${detail}`)
      }
    }

    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      if (!peer.localDescription?.sdp) throw new Error('WebRTC SDP offer was empty')

      const response = await debugFetch('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription.sdp,
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Realtime session ${response.status}: ${detail.slice(0, 300)}`)
      }
      const answerSdp = await response.text()
      if (!answerSdp.trim()) throw new Error('Realtime SDP answer was empty')
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      logInfo('[realtime] remote description applied')
      setStatus('Connecting OpenAI Realtime…')
      setListening(true)
    } catch (err) {
      logError('[realtime] setup failed', {
        error: String(err),
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      })
      stopRealtime()
      if (!shouldListenRef.current) throw err
      try {
        await startAudioFallback(`realtime-setup-failed:${err.message || err}`)
        if (/OPENAI_API_KEY is missing/i.test(err.message || '')) {
          setError('')
          setDebug('OpenAI Realtime key unavailable; using OpenRouter Whisper')
        } else {
          setError(`Realtime unavailable; using file fallback: ${err.message || err}`)
        }
        return false
      } catch (fallbackError) {
        throw new Error(
          `Realtime setup failed (${err.message || err}); fallback failed (${fallbackError.message || fallbackError})`,
        )
      }
    }
    return true
  }, [sendCompletedTranscript, setDebug, startAudioFallback, stopRealtime])

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
          logSubtitle('final', piece)
          logInfo('[heard:meta]', { n: heardCountRef.current, confidence: best?.confidence, alternatives: alts })
        } else {
          interim += piece
          logSubtitle('interim', piece)
        }
      }
      if (interim) setLiveLine(interim.trim())
      const cleaned = finalText.trim()
      if (cleaned) {
        setLiveLine('')
        logSubtitle('final', cleaned)
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
      if (realtimeAvailableRef.current === false) {
        logInfo('[mic] OpenAI Realtime unavailable; using OpenRouter key for audio fallback')
        await startAudioFallback('openrouter-only-mode')
        setError('')
        return
      }
      const realtimeStarted = await startRealtime()
      if (realtimeStarted !== false) {
        setStatus('Listening (OpenAI Realtime)')
        setListening(true)
      }
    } catch (err) {
      logError('[mic] start failed', {
        err: String(err),
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      })
      stopRealtime()
      if (err?.name !== 'NotAllowedError' && err?.name !== 'PermissionDeniedError') {
        try {
          await startAudioFallback(`realtime-start-failed:${err.message || err}`)
          setError(`Realtime unavailable; using file fallback: ${err.message || err}`)
          return
        } catch (fallbackError) {
          logError('[mic] fallback after Realtime start failure failed', fallbackError)
        }
      }
      shouldListenRef.current = false
      setListening(false)
      setError(err?.message || 'Could not start microphone')
      setDebug(`mic start failed: ${err?.message || err}`)
    }
  }, [connectWs, setDebug, startAudioFallback, startRealtime, stopRealtime])

  const resetSession = () => {
    logInfo('[session] reset')
    setTranscript('')
    setLiveLine('')
    setTalkingPoints([])
    setSummary('')
    setCode({ language: '', filename: '', content: '' })
    setFlash('')
    setFlashOn(false)
    setPriorityAnswers([])
    setPendingQuestions([])
    setQueueSize(0)
    setError('')
    realtimeDeltasRef.current.clear()
    realtimeCompletedRef.current.clear()
    optimisticTranscriptCountsRef.current.clear()
    serverTranscriptCountsRef.current.clear()
    pendingCompletedTranscriptsRef.current = []
    sendJson({ type: 'reset' })
  }

  const submitManual = () => {
    const text = manualText.trim()
    if (!text) return
    logSubtitle('manual', text)
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
    stopRealtime()
    try {
      await startAudioFallback('user-forced')
      setListening(true)
    } catch (err) {
      setError(err.message || String(err))
    }
  }
  useEffect(() => () => stopRealtime(), [stopRealtime])

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

      <section className={`priority-cube ${priorityAnswers.length || pendingQuestions.length ? 'hot' : ''}`}>
        <div className="priority-cube-head">
          <div className="priority-title">
            <span className="priority-orb">Q</span>
            <div>
              <h2>Priority answers</h2>
              <p>Questions jump the queue and answer one-by-one ASAP</p>
            </div>
          </div>
          <div className="priority-meta">
            <span className={`qbadge ${queueSize > 0 ? 'busy' : ''}`}>
              queue {queueSize}
            </span>
            {pendingQuestions.length ? (
              <span className="qbadge pending">{pendingQuestions.length} pending</span>
            ) : null}
          </div>
        </div>

        {pendingQuestions.length ? (
          <div className="pending-row">
            {pendingQuestions.slice(0, 4).map((q) => (
              <div key={q} className="pending-chip">
                <span className="pending-dot" />
                <strong>Answering…</strong> {q}
              </div>
            ))}
          </div>
        ) : null}

        <div className="priority-list">
          {priorityAnswers.length ? (
            priorityAnswers.slice(0, 4).map((item) => (
              <article key={item.id} className="priority-card">
                <div className="pq-label">Question</div>
                <div className="pq-question">{item.question}</div>
                <div className="pq-label answer-label">Answer</div>
                <div className="pq-answer">{item.answer}</div>
                {item.key_points?.length ? (
                  <ul className="pq-points">
                    {item.key_points.map((pt) => (
                      <li key={pt}>{pt}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))
          ) : (
            <p className="priority-empty">
              When a question is heard, it lands here in bold and gets answered first — before slower panel updates.
            </p>
          )}
        </div>
      </section>

      <main className="grid">

        <section className="panel transcript-panel">
          <div className="panel-head">
            <h2>Live transcript</h2>
            <span className="badge">{listening ? 'REC' : 'PAUSED'}</span>
          </div>
          <div className="panel-body transcript-body" ref={transcriptBodyRef}>
            {transcript || liveLine ? (
              <>
                <pre>{transcript}</pre>
                {liveLine ? <p className="interim">{liveLine}</p> : null}
              </>
            ) : (
              <p className="empty">
                Press Start listening for low-latency OpenAI Realtime captions. If Realtime setup fails,
                the app automatically falls back to complete audio files; Force audio mode starts that
                fallback directly.
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
            {summary ? (
              <div className="summary-box">
                <div className="summary-label">Live summary</div>
                <pre className="summary-text">{summary}</pre>
              </div>
            ) : null}
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
