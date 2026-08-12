;(() => {
  const IMPORTANT_RE = /\s*!important\s*$/i

  function escapeClassForSelector(className) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(className)
    }
    return className.replace(/([^a-zA-Z0-9_-])/g, "\\$1")
  }

  function selectorReferencesClass(selectorText, className) {
    if (!selectorText) return false
    const escaped = escapeClassForSelector(className)
    const re = new RegExp(`(^|[^a-zA-Z0-9_-])\\.${escaped}($|[^a-zA-Z0-9_-])`)
    return re.test(selectorText)
  }

  function parseSpecificity(selectorText) {
    // Approximate specificity for a single selector (no :where/:is nuance)
    let a = 0
    let b = 0
    let c = 0
    const sel = selectorText.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, (m) => {
      if (m.startsWith("::")) {
        c += 1
        return " "
      }
      // :not() args ignored for simplicity; pseudo-classes count as classes
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
        // Respect media/supports when possible
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

  function collectStyleSheets() {
    const sheets = []
    let opaqueCount = 0

    for (const sheet of document.styleSheets) {
      try {
        // Accessing cssRules throws for cross-origin sheets
        void sheet.cssRules
        sheets.push(sheet)
      } catch {
        opaqueCount += 1
      }
    }

    return { sheets, opaqueCount }
  }

  function getDeclarations(styleRule) {
    const decls = []
    const style = styleRule.style
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
        href: styleRule.parentStyleSheet?.href || "(inline)"
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

  function analyzeElement(element) {
    const classNames = [...element.classList]
    const { sheets, opaqueCount } = collectStyleSheets()

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
              declarations: getDeclarations(rule).map((d) => ({
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

    // Build cascade winners across ALL matched rules (element-level)
    const winners = new Map()
    const allDecls = []

    for (const matched of matchedRules) {
      for (const decl of matched.declarations) {
        const entry = {
          ...decl,
          specificity: matched.specificity,
          order: matched.order,
          fromClass: null
        }
        allDecls.push(entry)

        if (decl.invalid) continue

        const key = decl.property
        const prev = winners.get(key)
        if (!prev) {
          winners.set(key, entry)
          continue
        }

        // !important beats normal
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
      matchedRuleCount: matchedRules.length
    }
  }

  window.HoverCssAnalyzer = { analyzeElement }
})()
