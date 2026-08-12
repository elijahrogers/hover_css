const enabledByTab = new Map()
const devtoolsPorts = new Map()

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

  return false
})
