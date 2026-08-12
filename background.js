const enabledByTab = new Map()
const devtoolsPorts = new Map()
const cssTextCache = new Map()
const cssInflight = new Map()
const MAX_IMPORT_DEPTH = 8

function importPattern() {
  return /@import\s+(?:url\s*\(\s*)?(["']?)([^"')\s]+)\1\s*\)?([^;]*);/gi
}

function isFetchableCssUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

async function fetchRawCss(url) {
  const response = await fetch(url, { credentials: "omit", cache: "force-cache" })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text()
}

async function fetchCssResolved(url, depth = 0, stack = []) {
  if (!isFetchableCssUrl(url)) {
    return { ok: false, error: "unsupported-url" }
  }
  if (stack.includes(url)) {
    return { ok: true, text: "/* circular @import omitted */", url }
  }
  if (cssTextCache.has(url)) {
    return cssTextCache.get(url)
  }
  if (cssInflight.has(url)) {
    return cssInflight.get(url)
  }

  const task = (async () => {
    try {
      let text = await fetchRawCss(url)
      if (depth < MAX_IMPORT_DEPTH) {
        const parts = []
        let lastIndex = 0
        const importRe = importPattern()
        let match
        while ((match = importRe.exec(text))) {
          parts.push(text.slice(lastIndex, match.index))
          const importUrl = new URL(match[2], url).href
          const media = (match[3] || "").trim()
          const nested = await fetchCssResolved(importUrl, depth + 1, [...stack, url])
          if (nested.ok) {
            if (media) parts.push(`@media ${media} {\n${nested.text}\n}\n`)
            else parts.push(`\n${nested.text}\n`)
          } else {
            parts.push(`/* failed @import ${importUrl}: ${nested.error} */\n`)
          }
          lastIndex = match.index + match[0].length
        }
        parts.push(text.slice(lastIndex))
        text = parts.join("")
      }
      const result = { ok: true, text, url }
      cssTextCache.set(url, result)
      return result
    } catch (err) {
      const result = { ok: false, error: String(err?.message || err), url }
      cssTextCache.set(url, result)
      return result
    } finally {
      cssInflight.delete(url)
    }
  })()

  cssInflight.set(url, task)
  return task
}

function setBadge(tabId, enabled) {
  chrome.action.setBadgeText({
    tabId,
    text: enabled ? "ON" : ""
  })
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: "#B6F54A"
  })
  chrome.action.setBadgeTextColor?.({
    tabId,
    color: "#14161A"
  })
}

async function getEnabled(tabId) {
  if (enabledByTab.has(tabId)) return enabledByTab.get(tabId)
  const key = `enabled_${tabId}`
  const result = await chrome.storage.session.get(key)
  const enabled = Boolean(result[key])
  enabledByTab.set(tabId, enabled)
  return enabled
}

async function setEnabled(tabId, enabled) {
  enabledByTab.set(tabId, enabled)
  await chrome.storage.session.set({ [`enabled_${tabId}`]: enabled })
  setBadge(tabId, enabled)
  try {
    await chrome.tabs.sendMessage(tabId, { type: "hover-css:set-enabled", enabled })
  } catch {
    // Content script may not be injected yet
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  const next = !(await getEnabled(tab.id))
  await setEnabled(tab.id, next)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  enabledByTab.delete(tabId)
  chrome.storage.session.remove(`enabled_${tabId}`)
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hover-css-devtools") return

  // DevTools page sends inspected tabId in a handshake message
  let boundTabId = null

  port.onMessage.addListener((msg) => {
    if (msg?.type === "hover-css:devtools-ready" && typeof msg.tabId === "number") {
      boundTabId = msg.tabId
      devtoolsPorts.set(boundTabId, port)
    }
  })

  port.onDisconnect.addListener(() => {
    if (boundTabId != null) {
      const current = devtoolsPorts.get(boundTabId)
      if (current === port) devtoolsPorts.delete(boundTabId)
    }
  })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "hover-css:get-enabled") {
    const tabId = sender.tab?.id
    if (tabId == null) {
      sendResponse({ enabled: false })
      return false
    }
    getEnabled(tabId).then((enabled) => {
      setBadge(tabId, enabled)
      sendResponse({ enabled })
    })
    return true
  }

  if (message?.type === "hover-css:disable") {
    const tabId = sender.tab?.id
    if (tabId == null) {
      sendResponse({ ok: false })
      return false
    }
    setEnabled(tabId, false).then(() => sendResponse({ ok: true }))
    return true
  }

  if (message?.type === "hover-css:inspect") {
    const tabId = sender.tab?.id
    if (tabId == null) {
      sendResponse({ ok: false, reason: "no-tab" })
      return false
    }
    const port = devtoolsPorts.get(tabId)
    if (!port) {
      sendResponse({ ok: false, reason: "devtools-closed" })
      return false
    }
    try {
      port.postMessage({ type: "hover-css:inspect", id: message.id })
      sendResponse({ ok: true })
    } catch {
      sendResponse({ ok: false, reason: "devtools-closed" })
    }
    return false
  }

  if (message?.type === "hover-css:fetch-css") {
    const url = message.url
    if (typeof url !== "string" || !url) {
      sendResponse({ ok: false, error: "missing-url" })
      return false
    }
    fetchCssResolved(url).then((result) => sendResponse(result))
    return true
  }

  return false
})
