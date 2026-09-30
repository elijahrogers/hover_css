import { parse, walk } from "../node_modules/css-tree/dist/csstree.esm.js"

function slice(css, node) {
  if (!node?.loc) return ""
  return css.slice(node.loc.start.offset, node.loc.end.offset)
}

function importFromAtrule(css, node) {
  if (!node.prelude?.children || !node.loc) return null
  let url = ""
  let layer
  let supports = ""
  let media = ""

  for (const child of node.prelude.children) {
    if (child.type === "Url" || child.type === "String") {
      url = child.value
    } else if (child.type === "Identifier" && child.name === "layer") {
      layer = ""
    } else if (child.type === "Function" && child.name === "layer") {
      const named = child.children?.first
      layer = named?.name || ""
    } else if (child.type === "Function" && child.name === "supports") {
      const raw = slice(css, child)
      const open = raw.indexOf("(")
      supports = open === -1 ? raw : raw.slice(open)
    } else {
      const part = slice(css, child).trim()
      if (part) media = media ? `${media} ${part}` : part
    }
  }

  if (!url) return null
  return {
    url,
    layer,
    supports,
    media,
    start: node.loc.start.offset,
    end: node.loc.end.offset
  }
}

export function parseImports(cssText) {
  let ast
  try {
    ast = parse(cssText, { positions: true })
  } catch {
    return []
  }
  const rules = []
  walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name !== "import") return
      const rule = importFromAtrule(cssText, node)
      if (rule) rules.push(rule)
    }
  })
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
