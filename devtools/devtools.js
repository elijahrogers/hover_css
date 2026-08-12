function connect() {
  const port = chrome.runtime.connect({ name: "hover-css-devtools" })

  port.postMessage({
    type: "hover-css:devtools-ready",
    tabId: chrome.devtools.inspectedWindow.tabId
  })

  port.onMessage.addListener((message) => {
    if (message?.type !== "hover-css:inspect" || !message.id) return

    const id = String(message.id).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    const expression = `inspect(document.querySelector('[data-hover-css-id="${id}"]'))`

    chrome.devtools.inspectedWindow.eval(expression, (_result, exceptionInfo) => {
      if (exceptionInfo) {
        console.warn("Hover CSS inspect failed", exceptionInfo)
      }
    })
  })

  port.onDisconnect.addListener(() => {
    setTimeout(connect, 250)
  })
}

connect()
