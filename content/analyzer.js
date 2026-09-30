;(() => {
  const IMPORTANT_RE = /\s*!important\s*$/i
  const fetchedSheetCache = new Map()
  const fetchedFailCache = new Set()
  let prefetchPromise = null

  function escapeClassForSelector(className) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(className)
    }
    return className.replace(/([^a-zA-Z0-9_-])/g, "\\$1")
  }

  function escapeForRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function selectorReferencesClass(selectorText, className) {
    if (!selectorText) return false
    // Match the CSS-escaped class token as it appears in selectorText
    // (e.g. class "!rounded" → ".\!rounded"). Only an end boundary is required so
    // compound selectors like ".foo.\!rounded" still attribute correctly.
    const token = `.${escapeClassForSelector(className)}`
    const re = new RegExp(
      `${escapeForRegex(token)}(?=$|[^a-zA-Z0-9_-])`
    )
    return re.test(selectorText)
  }

  const ZERO_SPEC_PSEUDOS = new Set(["where"])
  const MAX_SPEC_PSEUDOS = new Set(["is", "not", "has", "matches", "-webkit-any", "-moz-any"])
  const PSEUDO_ELEMENTS = new Set([
    "before", "after", "first-line", "first-letter", "selection", "placeholder",
    "marker", "backdrop", "file-selector-button", "slotted", "part", "cue"
  ])

  function compareSpecificity(sa, sb) {
    for (let i = 0; i < 3; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i]
    }
    return 0
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

  function isIdentChar(ch) {
    return /[A-Za-z0-9_\u0080-\uFFFF-]/.test(ch)
  }

  function skipIdent(selector, i) {
    while (i < selector.length) {
      if (selector[i] === "\\") {
        i += 2
        continue
      }
      if (isIdentChar(selector[i])) {
        i++
        continue
      }
      break
    }
    return i
  }

  function skipBracket(selector, i) {
    let quote = ""
    for (; i < selector.length; i++) {
      const ch = selector[i]
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
      if (ch === "]") return i + 1
    }
    return selector.length
  }

  function readPseudo(selector, i) {
    let element = false
    i++
    if (selector[i] === ":") {
      element = true
      i++
    }
    const start = i
    while (i < selector.length && /[A-Za-z-]/.test(selector[i])) i++
    const name = selector.slice(start, i).toLowerCase()
    let args = ""
    if (selector[i] === "(") {
      const close = findBalanced(selector, i)
      if (close === -1) return { name, args: "", element, end: selector.length }
      args = selector.slice(i + 1, close)
      i = close + 1
    }
    return { name, args, element, end: i }
  }

  function maxSpec(listText) {
    const parts = splitSelectors(listText || "")
    let best = [0, 0, 0]
    for (const part of parts) {
      const spec = specOfComplex(part)
      if (compareSpecificity(spec, best) > 0) best = spec
    }
    return best
  }

  function pseudoSpec(pseudo) {
    if (pseudo.element || PSEUDO_ELEMENTS.has(pseudo.name)) return [0, 0, 1]
    if (ZERO_SPEC_PSEUDOS.has(pseudo.name)) return [0, 0, 0]
    if (MAX_SPEC_PSEUDOS.has(pseudo.name)) return maxSpec(pseudo.args)
    if (pseudo.name === "nth-child" || pseudo.name === "nth-last-child") {
      const ofAt = pseudo.args.search(/\sof\s/i)
      const extra = ofAt === -1 ? [0, 0, 0] : maxSpec(pseudo.args.slice(ofAt + 4))
      return [extra[0], extra[1] + 1, extra[2]]
    }
    if ((pseudo.name === "host" || pseudo.name === "host-context") && pseudo.args) {
      const inner = maxSpec(pseudo.args)
      return [inner[0], inner[1] + 1, inner[2]]
    }
    return [0, 1, 0]
  }

  function specOfComplex(selector) {
    let a = 0
    let b = 0
    let c = 0
    let i = 0
    while (i < selector.length) {
      const ch = selector[i]
      if (ch === "/" && selector[i + 1] === "*") {
        const end = selector.indexOf("*/", i + 2)
        i = end === -1 ? selector.length : end + 2
        continue
      }
      if (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~" || ch === "|") {
        i++
        continue
      }
      if (ch === "*") {
        i++
        continue
      }
      if (ch === "#") {
        i = skipIdent(selector, i + 1)
        a++
        continue
      }
      if (ch === ".") {
        i = skipIdent(selector, i + 1)
        b++
        continue
      }
      if (ch === "[") {
        i = skipBracket(selector, i)
        b++
        continue
      }
      if (ch === ":") {
        const pseudo = readPseudo(selector, i)
        i = pseudo.end
        const add = pseudoSpec(pseudo)
        a += add[0]
        b += add[1]
        c += add[2]
        continue
      }
      if (ch === "&") {
        i++
        continue
      }
      if (/[A-Za-z_\u0080-\uFFFF\\]/.test(ch)) {
        i = skipIdent(selector, i)
        c++
        continue
      }
      i++
    }
    return [a, b, c]
  }

  function parseSpecificity(selectorText) {
    return specOfComplex(selectorText || "")
  }

  // Unlayered is null. A shorter key is the layer's own rules, which outrank its sublayers.
  function compareLayerKeys(a, b) {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    const length = Math.max(a.length, b.length)
    for (let i = 0; i < length; i++) {
      const av = i < a.length ? a[i] : Infinity
      const bv = i < b.length ? b[i] : Infinity
      if (av !== bv) return av > bv ? 1 : -1
    }
    return 0
  }

  function preferCandidate(candidate, current) {
    if (candidate.important !== current.important) return candidate.important
    if (candidate.inline !== current.inline) return candidate.inline
    const layerCmp = compareLayerKeys(candidate.layerKey, current.layerKey)
    const directed = candidate.important ? -layerCmp : layerCmp
    if (directed !== 0) return directed > 0
    const spec = compareSpecificity(candidate.specificity, current.specificity)
    if (spec !== 0) return spec > 0
    return candidate.order >= current.order
  }

  function ruleName(rule) {
    return rule.constructor?.name || ""
  }

  function createCascadeState(element) {
    const named = new Map()
    const counters = new Map()
    let anonSerial = 0
    const stack = []

    function create(parent, name) {
      const parentFull = parent ? parent.full : ""
      const anon = name === ""
      const part = anon ? `anon${++anonSerial}` : name
      const full = parentFull ? `${parentFull}.${part}` : part
      if (!anon && named.has(full)) return named.get(full)
      const index = counters.get(parentFull) || 0
      counters.set(parentFull, index + 1)
      const key = parent ? parent.key.concat(index) : [index]
      const layer = { full, key }
      if (!anon) named.set(full, layer)
      return layer
    }

    return {
      element,
      href: "(inline)",
      order: 0,
      layerKey() {
        return stack.length ? stack[stack.length - 1].key : null
      },
      establish(name) {
        const parent = stack.length ? stack[stack.length - 1] : null
        const parts = name ? String(name).split(".") : [""]
        let current = parent
        let layer = null
        for (const part of parts) {
          layer = create(current, part)
          current = layer
        }
        return layer
      },
      push(layer) {
        stack.push(layer)
      },
      pop() {
        stack.pop()
      }
    }
  }

  function replaceAmpersand(selector, replacement) {
    let out = ""
    let quote = ""
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i]
      if (quote) {
        out += ch
        if (ch === "\\") {
          out += selector[++i] || ""
          continue
        }
        if (ch === quote) quote = ""
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        out += ch
        continue
      }
      if (ch === "&") {
        out += replacement
        continue
      }
      out += ch
    }
    return out
  }

  function expandNested(parent, child) {
    if (!child || !child.includes("&")) return child
    return replaceAmpersand(child, `:is(${parent})`)
  }

  function mediaMatches(rule) {
    try {
      if (rule.media?.mediaText && !matchMedia(rule.media.mediaText).matches) return false
    } catch {
      return true
    }
    return true
  }

  function supportsMatches(condition) {
    if (!condition) return true
    try {
      return CSS.supports(condition)
    } catch {
      return true
    }
  }

  function contentSize(el, axis) {
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (axis === "width") {
      return rect.width
        - parseFloat(cs.paddingLeft)
        - parseFloat(cs.paddingRight)
        - parseFloat(cs.borderLeftWidth)
        - parseFloat(cs.borderRightWidth)
    }
    return rect.height
      - parseFloat(cs.paddingTop)
      - parseFloat(cs.paddingBottom)
      - parseFloat(cs.borderTopWidth)
      - parseFloat(cs.borderBottomWidth)
  }

  function toPx(token, container) {
    const match = /^(-?[\d.]+)(px|em|rem)$/.exec(String(token).trim())
    if (!match) return null
    const amount = parseFloat(match[1])
    if (match[2] === "px") return amount
    if (match[2] === "em") return amount * parseFloat(getComputedStyle(container).fontSize)
    return amount * parseFloat(getComputedStyle(document.documentElement).fontSize)
  }

  function findSizeContainer(element, name) {
    let el = element.parentElement
    while (el) {
      const cs = getComputedStyle(el)
      if (cs.containerType && cs.containerType !== "normal") {
        const names = cs.containerName.split(/\s+/).filter(Boolean)
        if (!name || names.includes(name)) return el
      }
      el = el.parentElement
    }
    return null
  }

  function splitConjunction(query) {
    const parts = []
    let current = ""
    let depth = 0
    for (let i = 0; i < query.length; i++) {
      const ch = query[i]
      if (ch === "(") depth++
      if (ch === ")") depth = Math.max(0, depth - 1)
      if (depth === 0 && query.slice(i, i + 5).toLowerCase() === " and ") {
        parts.push(current.trim())
        current = ""
        i += 4
        continue
      }
      current += ch
    }
    if (current.trim()) parts.push(current.trim())
    return parts
  }

  function sizeFeatureMatches(container, feature) {
    const match = /^\(\s*(min-width|max-width|width|min-height|max-height|height)\s*:\s*([^)]+)\)$/i.exec(feature)
    if (!match) return null
    const featureName = match[1].toLowerCase()
    const type = getComputedStyle(container).containerType
    const axis = featureName.includes("height") ? "height" : "width"
    if (type === "inline-size" && axis === "height") return false
    const actual = contentSize(container, axis)
    const expected = toPx(match[2], container)
    if (expected == null || !Number.isFinite(actual)) return null
    if (featureName.startsWith("min-")) return actual + 0.5 >= expected
    if (featureName.startsWith("max-")) return actual - 0.5 <= expected
    return Math.abs(actual - expected) <= 0.5
  }

  function containerMatches(element, rule) {
    const query = (rule.containerQuery || rule.conditionText || "").trim()
    const name = (rule.containerName || "").trim()
    const container = findSizeContainer(element, name)
    if (!container) return false
    if (!query) return true
    for (const part of splitConjunction(query)) {
      const matched = sizeFeatureMatches(container, part)
      if (matched === false) return false
    }
    return true
  }

  function importSupportsCondition(rule) {
    if (typeof rule.supportsText === "string" && rule.supportsText) return rule.supportsText
    const css = rule.cssText || ""
    const at = css.search(/\bsupports\s*\(/)
    if (at === -1) return ""
    const open = css.indexOf("(", at)
    const close = findBalanced(css, open)
    if (close === -1) return ""
    return css.slice(open, close + 1)
  }

  function walkImport(rule, state, emit) {
    if (!mediaMatches(rule)) return
    if (!supportsMatches(importSupportsCondition(rule))) return
    const layered = typeof rule.layerName === "string"
    if (layered) state.push(state.establish(rule.layerName))
    const previous = state.href
    if (rule.styleSheet?.href) state.href = rule.styleSheet.href
    try {
      if (rule.styleSheet) walkRules(rule.styleSheet.cssRules, state, emit)
    } finally {
      state.href = previous
      if (layered) state.pop()
    }
  }

  function emitStyle(source, selectorText, state, emit) {
    if (!source.style || source.style.length === 0) return
    emit({
      style: source.style,
      selectorText,
      order: state.order++,
      layerKey: state.layerKey(),
      href: source.parentStyleSheet?.href || state.href
    })
  }

  function walkStyle(rule, selectorText, state, emit) {
    emitStyle(rule, selectorText, state, emit)
    if (!rule.cssRules) return
    for (const child of rule.cssRules) {
      if (ruleName(child) === "CSSNestedDeclarations") {
        emitStyle(child, selectorText, state, emit)
      } else if (child.type === CSSRule.STYLE_RULE) {
        for (const parent of splitSelectors(selectorText)) {
          walkStyle(child, expandNested(parent, child.selectorText || ""), state, emit)
        }
      } else {
        walkRules([child], state, emit)
      }
    }
  }

  function walkRules(ruleList, state, emit) {
    if (!ruleList) return
    for (const rule of ruleList) {
      if (rule.type === CSSRule.STYLE_RULE) {
        walkStyle(rule, rule.selectorText || "", state, emit)
        continue
      }
      if (rule.type === CSSRule.IMPORT_RULE) {
        walkImport(rule, state, emit)
        continue
      }
      if (ruleName(rule) === "CSSLayerStatementRule") {
        for (const name of rule.nameList || []) state.establish(name)
        continue
      }
      if (ruleName(rule) === "CSSLayerBlockRule") {
        const layer = state.establish(rule.name || "")
        state.push(layer)
        walkRules(rule.cssRules, state, emit)
        state.pop()
        continue
      }
      if (rule.type === CSSRule.MEDIA_RULE) {
        if (!mediaMatches(rule)) continue
        walkRules(rule.cssRules, state, emit)
        continue
      }
      if (rule.type === CSSRule.SUPPORTS_RULE) {
        if (!supportsMatches(rule.conditionText)) continue
        walkRules(rule.cssRules, state, emit)
        continue
      }
      if (ruleName(rule) === "CSSContainerRule") {
        if (!containerMatches(state.element, rule)) continue
        walkRules(rule.cssRules, state, emit)
        continue
      }
      if (rule.cssRules) walkRules(rule.cssRules, state, emit)
    }
  }

  function listDocumentSheets() {
    const entries = []
    for (const sheet of document.styleSheets) {
      try {
        void sheet.cssRules
        entries.push({ kind: "live", sheet, href: sheet.href || null })
      } catch {
        entries.push({
          kind: "opaque",
          sheet: null,
          href: sheet.href || null
        })
      }
    }
    return entries
  }

  async function fetchCssText(url) {
    const response = await chrome.runtime.sendMessage({
      type: "hover-css:fetch-css",
      url
    })
    return response
  }

  async function getFetchedSheet(url) {
    if (fetchedSheetCache.has(url)) return fetchedSheetCache.get(url)
    if (fetchedFailCache.has(url)) return null

    const result = await fetchCssText(url)
    if (!result?.ok || typeof result.text !== "string") {
      fetchedFailCache.add(url)
      return null
    }

    try {
      const sheet = new CSSStyleSheet({ baseURL: url })
      sheet.replaceSync(result.text)
      const wrapped = { sheet, href: url }
      fetchedSheetCache.set(url, wrapped)
      return wrapped
    } catch {
      // baseURL option may be unsupported — retry without it
      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(result.text)
        const wrapped = { sheet, href: url }
        fetchedSheetCache.set(url, wrapped)
        return wrapped
      } catch {
        fetchedFailCache.add(url)
        return null
      }
    }
  }

  async function resolveSheets() {
    const entries = listDocumentSheets()
    const resolved = []
    let opaqueCount = 0
    let fetchedCount = 0

    for (const entry of entries) {
      if (entry.kind === "live") {
        resolved.push({
          cssRules: entry.sheet.cssRules,
          href: entry.href || "(inline)"
        })
        continue
      }

      if (!entry.href) {
        opaqueCount += 1
        continue
      }

      const fetched = await getFetchedSheet(entry.href)
      if (!fetched) {
        opaqueCount += 1
        continue
      }

      fetchedCount += 1
      resolved.push({
        cssRules: fetched.sheet.cssRules,
        href: fetched.href
      })
    }

    return { sheets: resolved, opaqueCount, fetchedCount }
  }

  async function prefetchSheets() {
    if (prefetchPromise) return prefetchPromise
    prefetchPromise = (async () => {
      const entries = listDocumentSheets().filter((e) => e.kind === "opaque" && e.href)
      await Promise.all(entries.map((e) => getFetchedSheet(e.href)))
    })().finally(() => {
      prefetchPromise = null
    })
    return prefetchPromise
  }

  function getDeclarations(style, href) {
    const decls = []
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i)
      const raw = style.getPropertyValue(prop).trim()
      const priority = style.getPropertyPriority(prop)
      const important = priority === "important" || IMPORTANT_RE.test(raw)
      const value = raw.replace(IMPORTANT_RE, "").trim()
      let invalid = false
      try {
        invalid = value !== "" && !CSS.supports(prop, value)
      } catch {
        invalid = false
      }
      decls.push({
        property: prop,
        value,
        important,
        invalid,
        href: href || "(inline)"
      })
    }
    return decls
  }

  function readInline(element) {
    const style = element.style
    if (!style) return []
    return getDeclarations(style, "(inline)").map((decl) => ({
      ...decl,
      selector: "(inline)",
      specificity: [1, 0, 0],
      order: 0,
      layerKey: null,
      inline: true
    }))
  }

  function winnerKey(decl) {
    return `${decl.property}|${decl.selector}|${decl.value}|${decl.order}|${decl.inline ? "inline" : "sheet"}`
  }

  function splitSelectors(selectorText) {
    const parts = []
    let current = ""
    let depth = 0
    for (let i = 0; i < selectorText.length; i++) {
      const ch = selectorText[i]
      if (ch === "(" || ch === "[") depth++
      if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1)
      if (ch === "," && depth === 0) {
        if (current.trim()) parts.push(current.trim())
        current = ""
        continue
      }
      current += ch
    }
    if (current.trim()) parts.push(current.trim())
    return parts
  }

  async function analyzeElement(element) {
    const classNames = [...element.classList]
    const { sheets, opaqueCount, fetchedCount } = await resolveSheets()

    const matchedRules = []
    const state = createCascadeState(element)

    function emit(record) {
      const selectors = splitSelectors(record.selectorText || "")
      for (const selector of selectors) {
        let matches = false
        try {
          matches = element.matches(selector)
        } catch {
          matches = false
        }
        if (!matches) continue
        matchedRules.push({
          selector,
          order: record.order,
          layerKey: record.layerKey,
          specificity: parseSpecificity(selector),
          declarations: getDeclarations(record.style, record.href).map((decl) => ({
            ...decl,
            selector,
            order: record.order,
            layerKey: record.layerKey,
            inline: false
          }))
        })
        break
      }
    }

    for (const sheet of sheets) {
      state.href = sheet.href
      try {
        walkRules(sheet.cssRules, state, emit)
      } catch {
        // skip broken sheets
      }
    }

    const inlineDecls = readInline(element)
    const winners = new Map()

    function consider(entry) {
      if (entry.invalid) return
      const prev = winners.get(entry.property)
      if (!prev || preferCandidate(entry, prev)) winners.set(entry.property, entry)
    }

    for (const matched of matchedRules) {
      for (const decl of matched.declarations) {
        consider({
          ...decl,
          specificity: matched.specificity,
          order: matched.order,
          layerKey: matched.layerKey,
          inline: false
        })
      }
    }
    for (const decl of inlineDecls) consider(decl)

    const winnerIds = new Set([...winners.values()].map((winner) => winnerKey(winner)))

    const classAnalyses = classNames.map((className) => {
      const classRules = []
      for (const matched of matchedRules) {
        if (!selectorReferencesClass(matched.selector, className)) continue
        classRules.push(matched)
      }

      const declarations = []
      for (const matched of classRules) {
        for (const decl of matched.declarations) {
          const applied = !decl.invalid && winnerIds.has(winnerKey({ ...decl, order: matched.order, inline: false }))
          declarations.push({
            property: decl.property,
            value: decl.value,
            important: decl.important,
            invalid: decl.invalid,
            applied,
            overridden: !decl.invalid && !applied,
            selector: decl.selector,
            href: decl.href
          })
        }
      }

      let status = "missing"
      if (classRules.length === 0) {
        status = opaqueCount > 0 ? "unknown" : "missing"
      } else {
        const hasInvalid = declarations.some((d) => d.invalid)
        const hasOverridden = declarations.some((d) => d.overridden)
        const hasApplied = declarations.some((d) => d.applied)
        if (hasInvalid && !hasApplied) status = "broken"
        else if (hasInvalid || hasOverridden) status = "partial"
        else if (hasApplied) status = "applied"
        else status = "applied"
      }

      return {
        className,
        status,
        ruleCount: classRules.length,
        declarations
      }
    })

    const inline = inlineDecls.map((decl) => {
      const applied = !decl.invalid && winnerIds.has(winnerKey(decl))
      return {
        property: decl.property,
        value: decl.value,
        important: decl.important,
        invalid: decl.invalid,
        applied,
        overridden: !decl.invalid && !applied
      }
    })

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      classes: classAnalyses,
      inline,
      opaqueSheets: opaqueCount,
      fetchedSheets: fetchedCount,
      matchedRuleCount: matchedRules.length
    }
  }

  window.HoverCssAnalyzer = { analyzeElement, prefetchSheets }
})()
