function skipWs(css, i) {
  while (i < css.length && /\s/.test(css[i])) i++
  return i
}

function findBalanced(css, openIndex) {
  let depth = 0
  let quote = ""
  for (let i = openIndex; i < css.length; i++) {
    const ch = css[i]
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function nextImport(css, from) {
  let quote = ""
  let comment = false
  for (let i = from; i < css.length; i++) {
    const ch = css[i]
    if (comment) {
      if (ch === "*" && css[i + 1] === "/") {
        comment = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === "/" && css[i + 1] === "*") {
      comment = true
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (css.startsWith("@import", i) && !/[A-Za-z0-9_-]/.test(css[i + 7] || "")) return i
  }
  return -1
}

function readImport(css, at) {
  let i = skipWs(css, at + "@import".length)
  let url = ""
  if (css.startsWith("url(", i)) {
    i = skipWs(css, i + 4)
    if (css[i] === '"' || css[i] === "'") {
      const quote = css[i]
      const end = css.indexOf(quote, i + 1)
      if (end === -1) return null
      url = css.slice(i + 1, end)
      i = skipWs(css, end + 1)
      if (css[i] === ")") i++
    } else {
      const end = css.indexOf(")", i)
      if (end === -1) return null
      url = css.slice(i, end).trim()
      i = end + 1
    }
  } else if (css[i] === '"' || css[i] === "'") {
    const quote = css[i]
    const end = css.indexOf(quote, i + 1)
    if (end === -1) return null
    url = css.slice(i + 1, end)
    i = end + 1
  } else {
    return null
  }

  i = skipWs(css, i)
  let layer
  if (css.startsWith("layer", i) && !/[A-Za-z0-9_-]/.test(css[i + 5] || "")) {
    i += 5
    i = skipWs(css, i)
    if (css[i] === "(") {
      const close = css.indexOf(")", i)
      if (close === -1) return null
      layer = css.slice(i + 1, close).trim()
      i = close + 1
    } else {
      layer = ""
    }
    i = skipWs(css, i)
  }

  let supports = ""
  if (css.startsWith("supports(", i)) {
    const open = i + "supports".length
    const close = findBalanced(css, open)
    if (close === -1) return null
    supports = css.slice(open, close + 1)
    i = skipWs(css, close + 1)
  }

  const semi = css.indexOf(";", i)
  if (semi === -1) return null
  return {
    url,
    layer,
    supports,
    media: css.slice(i, semi).trim(),
    end: semi + 1
  }
}

export function parseImports(cssText) {
  const rules = []
  let from = 0
  while (from < cssText.length) {
    const at = nextImport(cssText, from)
    if (at === -1) break
    const rule = readImport(cssText, at)
    if (!rule) {
      from = at + 7
      continue
    }
    rules.push({ ...rule, start: at })
    from = rule.end
  }
  return rules
}

export function wrapImported(nestedText, rule) {
  let body = nestedText
  if (rule.media) body = `@media ${rule.media} {\n${body}\n}\n`
  if (rule.supports) body = `@supports ${rule.supports} {\n${body}\n}\n`
  if (rule.layer !== undefined) {
    const head = rule.layer ? `@layer ${rule.layer}` : "@layer"
    body = `${head} {\n${body}\n}\n`
  }
  return body
}

export async function expandImportText(cssText, baseUrl, load) {
  const rules = parseImports(cssText)
  if (!rules.length) return cssText
  let out = ""
  let cursor = 0
  for (const rule of rules) {
    out += cssText.slice(cursor, rule.start)
    let absolute = rule.url
    try {
      absolute = new URL(rule.url, baseUrl).href
    } catch {
      absolute = rule.url
    }
    const nested = await load(absolute)
    if (!nested?.ok) {
      out += `/* failed @import ${absolute}: ${nested?.error || "failed"} */\n`
    } else {
      out += wrapImported(nested.text, rule)
    }
    cursor = rule.end
  }
  out += cssText.slice(cursor)
  return out
}
