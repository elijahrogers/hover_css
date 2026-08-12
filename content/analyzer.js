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

  function parseSpecificity(selectorText) {
    let a = 0
    let b = 0
    let c = 0
    const sel = selectorText.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, (m) => {
      if (m.startsWith("::")) {
        c += 1
        return " "
      }
      b += 1
      return " "
    })

    const ids = sel.match(/#[a-zA-Z0-9_-]+/g)
    if (ids) a += ids.length

    const classes = sel.match(/\.[a-zA-Z0-9_-]+/g)
    if (classes) b += classes.length

    const attrs = sel.match(/\[[^\]]+\]/g)
    if (attrs) b += attrs.length

    const elements = sel.match(/(^|[\s>+~])([a-zA-Z][a-zA-Z0-9_-]*)/g)
    if (elements) c += elements.length

    return [a, b, c]
  }

  function compareSpecificity(sa, sb) {
    for (let i = 0; i < 3; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i]
    }
    return 0
  }

  function walkRules(ruleList, visit, orderState) {
    if (!ruleList) return
    for (const rule of ruleList) {
      if (rule.type === CSSRule.STYLE_RULE) {
        visit(rule, orderState.i++)
      } else if (
        rule.type === CSSRule.MEDIA_RULE ||
        rule.type === CSSRule.SUPPORTS_RULE ||
        rule.type === CSSRule.LAYER_BLOCK_RULE ||
        rule.cssRules
      ) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          try {
            if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) {
              continue
            }
          } catch {
            // ignore media parse failures
          }
        }
        if (rule.type === CSSRule.SUPPORTS_RULE) {
          try {
            if (rule.conditionText && !CSS.supports(rule.conditionText)) continue
          } catch {
            // ignore
          }
        }
        walkRules(rule.cssRules, visit, orderState)
      }
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

  function getDeclarations(styleRule, fallbackHref) {
    const decls = []
    const style = styleRule.style
    const href = styleRule.parentStyleSheet?.href || fallbackHref || "(inline)"
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
        selector: styleRule.selectorText,
        href
      })
    }
    return decls
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
    const orderState = { i: 0 }

    for (const sheet of sheets) {
      try {
        walkRules(sheet.cssRules, (rule, order) => {
          const selectors = splitSelectors(rule.selectorText || "")
          for (const selector of selectors) {
            let matches = false
            try {
              matches = element.matches(selector)
            } catch {
              matches = false
            }
            if (!matches) continue
            matchedRules.push({
              rule,
              selector,
              order,
              specificity: parseSpecificity(selector),
              declarations: getDeclarations(rule, sheet.href).map((d) => ({
                ...d,
                selector
              }))
            })
            break
          }
        }, orderState)
      } catch {
        // skip broken sheets
      }
    }

    const winners = new Map()

    for (const matched of matchedRules) {
      for (const decl of matched.declarations) {
        const entry = {
          ...decl,
          specificity: matched.specificity,
          order: matched.order
        }

        if (decl.invalid) continue

        const key = decl.property
        const prev = winners.get(key)
        if (!prev) {
          winners.set(key, entry)
          continue
        }

        if (entry.important !== prev.important) {
          if (entry.important) winners.set(key, entry)
          continue
        }

        const spec = compareSpecificity(entry.specificity, prev.specificity)
        if (spec > 0 || (spec === 0 && entry.order >= prev.order)) {
          winners.set(key, entry)
        }
      }
    }

    const winnerIds = new Set(
      [...winners.values()].map((w) => `${w.property}|${w.selector}|${w.value}|${w.order}`)
    )

    const classAnalyses = classNames.map((className) => {
      const classRules = []
      for (const matched of matchedRules) {
        if (!selectorReferencesClass(matched.selector, className)) continue
        classRules.push(matched)
      }

      const declarations = []
      for (const matched of classRules) {
        for (const decl of matched.declarations) {
          const id = `${decl.property}|${decl.selector}|${decl.value}|${matched.order}`
          const applied = !decl.invalid && winnerIds.has(id)
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

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      classes: classAnalyses,
      opaqueSheets: opaqueCount,
      fetchedSheets: fetchedCount,
      matchedRuleCount: matchedRules.length
    }
  }

  window.HoverCssAnalyzer = { analyzeElement, prefetchSheets }
})()
