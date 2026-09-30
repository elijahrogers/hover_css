import { chromium } from "playwright"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const analyzerPath = path.join(root, "content", "analyzer.js")

let server
let browser
let page
let origin

function contentType(file) {
  if (file.endsWith(".css")) return "text/css"
  if (file.endsWith(".js")) return "text/javascript"
  return "text/html"
}

export async function startBrowser() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/case") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(currentHtml)
      return
    }
    const file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end("missing")
      return
    }
    res.writeHead(200, { "content-type": contentType(file) })
    res.end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await context.newPage()
}

export async function stopBrowser() {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}

let currentHtml = "<!doctype html><title>case</title>"

export async function inspect({ css = "", body, selector, className, property }) {
  currentHtml = `<!doctype html><meta charset="utf-8"><style>${css.replaceAll("__ORIGIN__", origin)}</style>${body}`
  await page.goto(`${origin}/case`, { waitUntil: "networkidle" })
  await page.addScriptTag({ path: analyzerPath })
  return page.evaluate(async ({ selector, className, property }) => {
    const el = document.querySelector(selector)
    const analysis = await window.HoverCssAnalyzer.analyzeElement(el)
    const cls = analysis.classes.find((item) => item.className === className)
    const decls = (cls?.declarations || []).filter((item) => item.property === property)
    const inline = (analysis.inline || []).filter((item) => item.property === property)
    return {
      status: cls?.status ?? null,
      ruleCount: cls?.ruleCount ?? 0,
      applied: decls.filter((item) => item.applied).map((item) => item.value),
      overridden: decls.filter((item) => item.overridden).map((item) => item.value),
      inlineApplied: inline.filter((item) => item.applied).map((item) => item.value),
      inlineOverridden: inline.filter((item) => item.overridden).map((item) => item.value),
      computed: getComputedStyle(el).getPropertyValue(property)
    }
  }, { selector, className, property })
}
