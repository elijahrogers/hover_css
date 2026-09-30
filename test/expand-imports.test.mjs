import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { parseImports, wrapImported } from "../shared/expand-imports.js"

describe("cross-origin @import rewrite", () => {
  test("layer() becomes an @layer block", () => {
    const [rule] = parseImports(`@import url("/nested.css") layer(base);\n.local { color: black; }\n`)
    assert.equal(rule.url, "/nested.css")
    assert.equal(rule.layer, "base")
    assert.equal(rule.media, "")
    const wrapped = wrapImported(".opaque-nested { color: purple; }\n", rule)
    assert.match(wrapped, /@layer base/)
    assert.doesNotMatch(wrapped, /@media/)
    assert.match(wrapped, /\.opaque-nested/)
  })

  test("a bare layer keyword becomes an anonymous @layer block", () => {
    const [rule] = parseImports(`@import "nested.css" layer;`)
    assert.equal(rule.layer, "")
    const wrapped = wrapImported(".a { color: red; }", rule)
    assert.match(wrapped, /@layer\s*\{/)
    assert.doesNotMatch(wrapped, /@media/)
  })

  test("media conditions stay media queries", () => {
    const [rule] = parseImports(`@import "wide.css" screen and (min-width: 1px);`)
    assert.equal(rule.layer, undefined)
    assert.equal(rule.media, "screen and (min-width: 1px)")
    const wrapped = wrapImported(".wide-import { color: brown; }", rule)
    assert.match(wrapped, /@media screen and \(min-width: 1px\)/)
    assert.doesNotMatch(wrapped, /@layer/)
  })

  test("layer, supports, and media wrap together", () => {
    const [rule] = parseImports(`@import url("s.css") layer(components) supports(display: grid) screen and (min-width: 20px);`)
    assert.equal(rule.layer, "components")
    assert.match(rule.supports, /display:\s*grid/)
    assert.equal(rule.media, "screen and (min-width: 20px)")
    const wrapped = wrapImported(".a { color: red; }", rule)
    assert.match(wrapped, /@layer components/)
    assert.match(wrapped, /@supports/)
    assert.match(wrapped, /@media screen and \(min-width: 20px\)/)
    const layerAt = wrapped.indexOf("@layer")
    const supportsAt = wrapped.indexOf("@supports")
    const mediaAt = wrapped.indexOf("@media")
    assert.ok(layerAt < supportsAt && supportsAt < mediaAt)
  })
})
