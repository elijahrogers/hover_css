;(() => {
  const ATTR = "data-hover-css-id"
  const DWELL_MS = 180
  const GRACE_MS = 320

  let enabled = false
  let rafId = 0
  let lastElement = null
  let lastAnalysis = null
  let pendingX = 0
  let pendingY = 0
  let analyzeSeq = 0

  let candidateElement = null
  let dwellTimer = null
  let graceTimer = null

  function elementFromPoint(x, y) {
    const stack = document.elementsFromPoint(x, y)
    for (const el of stack) {
      if (window.HoverCssOverlay?.isHost(el)) continue
      if (el === document.documentElement || el === document.body) continue
      if (el.nodeType !== 1) continue
      return el
    }
    return null
  }

  function clearDwell() {
    if (dwellTimer) {
      clearTimeout(dwellTimer)
      dwellTimer = null
    }
    candidateElement = null
  }

  function clearGrace() {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  function clearHoverTimers() {
    clearDwell()
    clearGrace()
  }

  function paint(el, analysis) {
    lastElement = el
    lastAnalysis = analysis
    clearGrace()
    window.HoverCssOverlay.show(el, analysis)
  }

  async function commitElement(el) {
    if (!enabled || !el) return
    clearDwell()
    if (el === lastElement && lastAnalysis) {
      window.HoverCssOverlay.syncPosition(el)
      return
    }
    const seq = ++analyzeSeq
    try {
      const analysis = await window.HoverCssAnalyzer.analyzeElement(el)
      if (!enabled || seq !== analyzeSeq) return
      paint(el, analysis)
    } catch {
      if (!enabled || seq !== analyzeSeq) return
    }
  }

  function startDwell(el) {
    if (el === candidateElement && dwellTimer) return
    clearDwell()
    candidateElement = el
    dwellTimer = setTimeout(() => {
      dwellTimer = null
      const committed = candidateElement
      candidateElement = null
      if (!enabled || !committed) return
      // Re-check under cursor so we don't commit a skimmed-past node
      if (window.HoverCssOverlay.isPointOverPanel(pendingX, pendingY)) return
      const current = elementFromPoint(pendingX, pendingY)
      if (current !== committed) return
      commitElement(committed)
    }, DWELL_MS)
  }

  function startGrace() {
    if (graceTimer || !lastElement) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (!enabled) return
      if (window.HoverCssOverlay.isPointOverPanel(pendingX, pendingY)) return
      const current = elementFromPoint(pendingX, pendingY)
      if (current) {
        // Something is under the cursor — dwell will handle the switch
        return
      }
      lastElement = null
      lastAnalysis = null
      clearDwell()
      window.HoverCssOverlay.hide()
    }, GRACE_MS)
  }

  function scheduleHover(x, y) {
    pendingX = x
    pendingY = y
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (!enabled) return

      // Interacting with the panel: freeze target, cancel pending switches
      if (window.HoverCssOverlay.isPointOverPanel(pendingX, pendingY)) {
        clearHoverTimers()
        return
      }

      const el = elementFromPoint(pendingX, pendingY)

      if (!el) {
        clearDwell()
        if (lastElement && lastAnalysis) {
          window.HoverCssOverlay.syncPosition(lastElement)
          startGrace()
        } else {
          window.HoverCssOverlay.hide()
        }
        return
      }

      // Still on committed target — stay live, no dwell needed
      if (el === lastElement && lastAnalysis) {
        clearHoverTimers()
        window.HoverCssOverlay.syncPosition(el)
        return
      }

      // Moving across other nodes: keep sticky target visible, dwell on candidate
      if (lastElement && lastAnalysis) {
        window.HoverCssOverlay.syncPosition(lastElement)
        startGrace()
      }
      startDwell(el)
    })
  }

  function onMouseMove(e) {
    scheduleHover(e.clientX, e.clientY)
  }

  function onScroll(e) {
    if (!enabled || !lastElement || !lastAnalysis) return
    if (e.target && window.HoverCssOverlay.isHost(e.target)) return
    if (window.HoverCssOverlay.isPointOverPanel?.(pendingX, pendingY)) return
    window.HoverCssOverlay.syncPosition(lastElement)
  }

  async function onClick(e) {
    if (!enabled) return
    if (window.HoverCssOverlay.isPointOverPanel(e.clientX, e.clientY)) return

    const el = elementFromPoint(e.clientX, e.clientY)
    if (!el) return

    e.preventDefault()
    e.stopPropagation()

    // Click commits immediately (no dwell wait)
    commitElement(el)

    const id = `hcss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    el.setAttribute(ATTR, id)

    try {
      const response = await chrome.runtime.sendMessage({
        type: "hover-css:inspect",
        id
      })
      if (!response?.ok) {
        window.HoverCssOverlay.showToast("Open DevTools to inspect")
      }
    } catch {
      window.HoverCssOverlay.showToast("Open DevTools to inspect")
    } finally {
      setTimeout(() => {
        try {
          el.removeAttribute(ATTR)
        } catch {
          // element may be gone
        }
      }, 500)
    }
  }

  function onKeyDown(e) {
    if (!enabled) return
    if (e.key === "Escape") {
      chrome.runtime.sendMessage({ type: "hover-css:disable" }).catch(() => {})
      disable()
    }
  }

  async function enable() {
    if (enabled) return
    enabled = true
    await window.HoverCssOverlay.ensure()
    window.HoverCssAnalyzer.prefetchSheets?.().catch(() => {})
    document.addEventListener("mousemove", onMouseMove, true)
    document.addEventListener("click", onClick, true)
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("scroll", onScroll, true)
    document.documentElement.style.cursor = "crosshair"
  }

  function disable() {
    if (!enabled && !window.HoverCssOverlay?.host) return
    enabled = false
    lastElement = null
    lastAnalysis = null
    analyzeSeq += 1
    clearHoverTimers()
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    document.removeEventListener("mousemove", onMouseMove, true)
    document.removeEventListener("click", onClick, true)
    document.removeEventListener("keydown", onKeyDown, true)
    window.removeEventListener("scroll", onScroll, true)
    document.documentElement.style.cursor = ""
    window.HoverCssOverlay.hide()
    window.HoverCssOverlay.destroy()
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "hover-css:set-enabled") {
      if (message.enabled) enable()
      else disable()
    }
  })

  chrome.runtime.sendMessage({ type: "hover-css:get-enabled" })
    .then((res) => {
      if (res?.enabled) enable()
    })
    .catch(() => {})
})()
