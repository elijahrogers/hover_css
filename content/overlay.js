;(() => {
  const HOST_ID = "hover-css-root"
  const STATUS_LABELS = {
    applied: "applied",
    partial: "partial",
    missing: "missing",
    broken: "broken",
    unknown: "unknown"
  }

  const STATUS_SORT = {
    missing: 0,
    broken: 1,
    unknown: 2,
    partial: 3,
    applied: 4
  }

  let host = null
  let shadow = null
  let highlightEl = null
  let panelEl = null
  let toastEl = null
  let toastTimer = null
  let cssText = null

  async function loadCss() {
    if (cssText != null) return cssText
    const url = chrome.runtime.getURL("content/overlay.css")
    const res = await fetch(url)
    cssText = await res.text()
    return cssText
  }

  async function ensure() {
    if (host && shadow && document.documentElement.contains(host)) return

    const existing = document.getElementById(HOST_ID)
    if (existing) existing.remove()

    host = document.createElement("div")
    host.id = HOST_ID
    host.setAttribute("data-hover-css", "host")
    document.documentElement.appendChild(host)

    shadow = host.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = await loadCss()
    shadow.appendChild(style)

    highlightEl = document.createElement("div")
    highlightEl.className = "highlight"
    shadow.appendChild(highlightEl)

    panelEl = document.createElement("div")
    panelEl.className = "panel"
    shadow.appendChild(panelEl)

    toastEl = document.createElement("div")
    toastEl.className = "toast"
    shadow.appendChild(toastEl)
  }

  function destroy() {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (host) {
      host.remove()
      host = null
      shadow = null
      highlightEl = null
      panelEl = null
      toastEl = null
    }
  }

  function isHost(node) {
    return Boolean(node && (node === host || node.id === HOST_ID || node.closest?.(`#${HOST_ID}`)))
  }

  function isPointOverPanel(x, y) {
    if (!panelEl || !panelEl.classList.contains("visible")) return false
    const rect = panelEl.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  function positionPanel(rect) {
    const margin = 12
    const panelRect = panelEl.getBoundingClientRect()
    const pw = panelRect.width || 280
    const ph = panelRect.height || 160

    let left = rect.left
    let top = rect.bottom + 10

    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - pw - margin
    }
    if (left < margin) left = margin

    if (top + ph > window.innerHeight - margin) {
      top = rect.top - ph - 10
    }
    if (top < margin) top = margin

    panelEl.style.left = `${Math.round(left)}px`
    panelEl.style.top = `${Math.round(top)}px`
  }

  function syncPosition(element) {
    if (!highlightEl || !panelEl || !element) return
    const rect = element.getBoundingClientRect()
    highlightEl.style.top = `${Math.round(rect.top)}px`
    highlightEl.style.left = `${Math.round(rect.left)}px`
    highlightEl.style.width = `${Math.round(rect.width)}px`
    highlightEl.style.height = `${Math.round(rect.height)}px`
    positionPanel(rect)
  }

  function renderDecls(declarations) {
    if (!declarations.length) return ""
    // Show up to 12 decls to keep panel readable
    const list = declarations.slice(0, 12)
    const more = declarations.length - list.length
    return `
      <div class="decls">
        ${list.map((d) => {
          const kind = d.invalid ? "invalid" : d.overridden ? "overridden" : "applied"
          const badge = d.invalid ? "invalid" : d.overridden ? "overridden" : ""
          return `
            <div class="decl ${kind}">
              <div class="decl-line">
                <span class="prop">${escapeHtml(d.property)}</span>
                <span class="val">${escapeHtml(d.value)}${d.important ? " !important" : ""}</span>
                ${badge ? `<span class="decl-badge">${badge}</span>` : ""}
              </div>
            </div>
          `
        }).join("")}
        ${more > 0 ? `<div class="empty">+${more} more</div>` : ""}
      </div>
    `
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  function show(element, analysis) {
    if (!highlightEl || !panelEl) return

    const rect = element.getBoundingClientRect()
    highlightEl.style.top = `${Math.round(rect.top)}px`
    highlightEl.style.left = `${Math.round(rect.left)}px`
    highlightEl.style.width = `${Math.round(rect.width)}px`
    highlightEl.style.height = `${Math.round(rect.height)}px`
    highlightEl.classList.add("visible")

    const inlineDecls = analysis.inline || []
    const inlineStatus = inlineDecls.some((d) => d.invalid && !d.applied)
      ? "broken"
      : inlineDecls.some((d) => d.overridden || d.invalid)
        ? "partial"
        : "applied"
    const inlineBlock = inlineDecls.length
      ? `
          <div class="chip status-${inlineStatus}">
            <span class="status-dot"></span>
            <div>
              <div class="inline-label">style</div>
              ${renderDecls(inlineDecls)}
            </div>
            <span class="status-label">inline</span>
          </div>
        `
      : ""
    const idPart = analysis.id ? `<span class="id">#${escapeHtml(analysis.id)}</span>` : ""
    const sortedClasses = [...analysis.classes].sort((a, b) => {
      const byStatus = (STATUS_SORT[a.status] ?? 99) - (STATUS_SORT[b.status] ?? 99)
      if (byStatus !== 0) return byStatus
      return a.className.localeCompare(b.className)
    })
    const classChips = sortedClasses.length
      ? sortedClasses.map((c, i) => `
          <div class="chip status-${c.status}" style="animation-delay:${i * 20}ms">
            <span class="status-dot"></span>
            <div>
              <div class="class-name">${escapeHtml(c.className)}</div>
              ${c.status !== "missing" && c.status !== "unknown" ? renderDecls(c.declarations) : ""}
              ${c.status === "missing" ? `<div class="empty">No matching stylesheet rules</div>` : ""}
              ${c.status === "unknown" ? `<div class="empty">May live in cross-origin CSS</div>` : ""}
            </div>
            <span class="status-label">${STATUS_LABELS[c.status] || c.status}</span>
          </div>
        `).join("")
      : `<div class="empty">No classes on this element</div>`

    panelEl.innerHTML = `
      <div class="brand">
        <div class="brand-name">Hover CSS</div>
        <div class="hint">click page → Elements</div>
      </div>
      <div class="selector-line">
        <span class="tag">${escapeHtml(analysis.tagName)}</span>${idPart}
      </div>
      ${analysis.opaqueSheets > 0 ? `<div class="meta">${analysis.opaqueSheets} sheet${analysis.opaqueSheets === 1 ? "" : "s"} still unreadable</div>` : ""}
      <div class="classes">${inlineBlock}${classChips}</div>
    `

    panelEl.scrollTop = 0
    panelEl.classList.add("visible")
    // Measure after paint for flip positioning
    requestAnimationFrame(() => positionPanel(rect))
  }

  function hide() {
    highlightEl?.classList.remove("visible")
    panelEl?.classList.remove("visible")
  }

  function showToast(message) {
    if (!toastEl) return
    toastEl.textContent = message
    toastEl.classList.add("visible")
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("visible")
      toastTimer = null
    }, 2200)
  }

  window.HoverCssOverlay = {
    ensure,
    destroy,
    show,
    syncPosition,
    hide,
    showToast,
    isHost,
    isPointOverPanel,
    get host() {
      return host
    }
  }
})()
