/**
 * AURA SDK v1.0 — Lesson Activity Tracker
 * Source: SRS-CH07 §7.5 AURA Pipeline — SYNC goal
 *
 * This script is injected into every AURA HTML lesson iframe (sandbox: allow-scripts allow-same-origin).
 * It tracks learner interactions and sends structured events to the parent window,
 * which then forwards them to the LMS API → Redis Stream → Event Processor → Learner Model.
 *
 * Usage: loaded automatically via embed_config.inject_aura_sdk = true in pipeline.py
 *
 * Events emitted via postMessage:
 *   { type: 'aura_event', event: AURAEvent }
 *
 * Parent window (lesson page) listens and POSTs to /api/v1/events/ingest
 */

;(function (global) {
  'use strict'

  // ── Config ────────────────────────────────────────────────────────────────
  const SDK_VERSION = '1.0.0'
  const FLUSH_INTERVAL_MS = 5000      // batch-send every 5s
  const MAX_QUEUE_SIZE = 50           // flush early if queue exceeds this
  const IDLE_THRESHOLD_MS = 30000    // 30s inactivity = idle

  // ── State ─────────────────────────────────────────────────────────────────
  let _lessonId = null
  let _userId = null
  let _sessionId = generateUUID()
  let _startedAt = Date.now()
  let _lastActivityAt = Date.now()
  let _currentStage = null
  let _hintsUsed = 0
  let _queue = []
  let _flushTimer = null
  let _idleTimer = null
  let _pageVisible = true

  // ── Public API ────────────────────────────────────────────────────────────
  const AURA = {
    version: SDK_VERSION,

    /**
     * Initialize SDK. Called automatically on DOMContentLoaded if data-aura-* attrs present.
     */
    init(lessonId, userId) {
      _lessonId = lessonId || document.documentElement.dataset.lessonId || 'unknown'
      _userId = userId || document.documentElement.dataset.userId || null
      _sessionId = generateUUID()
      _startedAt = Date.now()

      _startFlushTimer()
      _attachDOMListeners()
      _trackPageView()

      console.debug('[AURA SDK] Initialized', { lessonId: _lessonId, sessionId: _sessionId })
    },

    /** Manually track a custom event */
    track(eventType, data = {}) {
      _enqueue(eventType, data)
    },

    /** Track hint revealed */
    hintRevealed(qid, hintIndex) {
      _hintsUsed++
      _enqueue('hint_requested', { qid, hint_index: hintIndex, total_hints_used: _hintsUsed })
    },

    /** Track answer submission for a specific question */
    answerSubmitted(qid, answer, isCorrect, timeMs) {
      _enqueue('answer_submitted', { qid, answer: String(answer).substring(0, 200), is_correct: isCorrect, time_ms: timeMs })
    },

    /** Track stage navigation */
    stageEntered(stageNum, stageName) {
      _currentStage = stageNum
      _enqueue('stage_entered', { stage: stageNum, stage_name: stageName })
    },

    /** Track video progress */
    videoProgress(percent, currentTimeSec) {
      if (percent % 25 === 0) {  // track at 25%, 50%, 75%, 100%
        _enqueue('video_progress', { percent, current_time_sec: currentTimeSec })
      }
    },

    /** Track code execution (Pyodide) */
    codeExecuted(qid, success, errorType) {
      _enqueue('code_executed', { qid, success, error_type: errorType || null })
    },

    /** Track GeoGebra interaction */
    geogebraInteracted(appletId, action) {
      _enqueue('geogebra_interacted', { applet_id: appletId, action })
    },

    /** Flush remaining events on demand (e.g., before unload) */
    flush() {
      _flush()
    },
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  function _trackPageView() {
    _enqueue('page_viewed', {
      url: location.href,
      title: document.title,
      lesson_id: _lessonId,
      bloom_target: document.documentElement.dataset.bloom || null,
      solo_target: document.documentElement.dataset.soloTarget || null,
      al_format: document.documentElement.dataset.alFormat || null,
    })
  }

  function _enqueue(eventType, data) {
    _lastActivityAt = Date.now()
    _resetIdleTimer()

    const event = {
      event_type: eventType,
      lesson_id: _lessonId,
      session_id: _sessionId,
      stage: _currentStage,
      elapsed_ms: Date.now() - _startedAt,
      ts: new Date().toISOString(),
      data,
    }

    _queue.push(event)

    if (_queue.length >= MAX_QUEUE_SIZE) {
      _flush()
    }
  }

  function _flush() {
    if (_queue.length === 0) return

    const batch = _queue.splice(0, _queue.length)

    // Send to parent window (lesson page handles the actual API call)
    if (global.parent && global.parent !== global) {
      global.parent.postMessage(
        { type: 'aura_event_batch', events: batch, lessonId: _lessonId, sessionId: _sessionId },
        '*'
      )
    }
  }

  function _startFlushTimer() {
    if (_flushTimer) clearInterval(_flushTimer)
    _flushTimer = setInterval(_flush, FLUSH_INTERVAL_MS)
  }

  function _resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer)
    _idleTimer = setTimeout(() => {
      _enqueue('learner_idle', { idle_ms: IDLE_THRESHOLD_MS })
    }, IDLE_THRESHOLD_MS)
  }

  function _attachDOMListeners() {
    // Track question interactions via data-qid elements
    document.addEventListener('click', (e) => {
      const qEl = e.target.closest('[data-qid]')
      if (qEl) {
        _enqueue('question_interacted', {
          qid: qEl.dataset.qid,
          type: qEl.dataset.type,
          element: e.target.tagName.toLowerCase(),
        })
      }

      // Track hint buttons
      const hintBtn = e.target.closest('[data-hint-index]')
      if (hintBtn) {
        AURA.hintRevealed(
          hintBtn.closest('[data-qid]')?.dataset.qid,
          parseInt(hintBtn.dataset.hintIndex || '0')
        )
      }
    }, { passive: true })

    // Track scroll depth
    let maxScrollDepth = 0
    document.addEventListener('scroll', () => {
      const depth = Math.round(
        ((window.scrollY + window.innerHeight) / document.body.scrollHeight) * 100
      )
      if (depth > maxScrollDepth + 10) {
        maxScrollDepth = depth
        _enqueue('scroll_depth', { depth_percent: depth })
      }
    }, { passive: true })

    // Track visibility
    document.addEventListener('visibilitychange', () => {
      _pageVisible = !document.hidden
      _enqueue(_pageVisible ? 'page_visible' : 'page_hidden', {
        elapsed_ms: Date.now() - _startedAt,
      })
    })

    // Flush on unload
    window.addEventListener('beforeunload', () => {
      _enqueue('lesson_exited', {
        time_on_page_sec: Math.round((Date.now() - _startedAt) / 1000),
        hints_used: _hintsUsed,
        max_scroll_depth: maxScrollDepth,
      })
      _flush()
    })

    // Auto-wire AURA HTML schema elements
    _wireAURASchema()
  }

  function _wireAURASchema() {
    // Auto-wire stages
    const stages = document.querySelectorAll('.aura-stage[data-stage]')
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target
          AURA.stageEntered(
            parseInt(el.dataset.stage || '0'),
            el.dataset.kolb || el.querySelector('h2,h3')?.textContent?.trim() || ''
          )
        }
      })
    }, { threshold: 0.3 })

    stages.forEach(s => observer.observe(s))

    // Auto-wire MCQ options
    document.querySelectorAll('.aura-q[data-type="mcq"] .option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const qEl = btn.closest('.aura-q')
        const isCorrect = btn.dataset.correct === 'true'
        AURA.answerSubmitted(qEl?.dataset.qid, btn.dataset.value, isCorrect, Date.now() - _startedAt)
      })
    })

    // Auto-wire video elements
    document.querySelectorAll('video').forEach(video => {
      video.addEventListener('timeupdate', () => {
        const pct = Math.round((video.currentTime / video.duration) * 100)
        AURA.videoProgress(pct, Math.round(video.currentTime))
      }, { passive: true })
    })
  }

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }

  // ── Auto-init ─────────────────────────────────────────────────────────────
  function autoInit() {
    const root = document.documentElement
    if (root.classList.contains('aura-lesson') || root.dataset.lessonId) {
      AURA.init(root.dataset.lessonId, root.dataset.userId)
    } else {
      // Check article element
      const article = document.querySelector('article.aura-lesson[data-lesson-id]')
      if (article) {
        AURA.init(article.dataset.lessonId, null)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit)
  } else {
    autoInit()
  }

  // Export
  global.AURA = AURA
})(window)
