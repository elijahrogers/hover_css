import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { inspect, startBrowser, stopBrowser } from "./harness.mjs"

before(startBrowser)
after(stopBrowser)

describe("cascade", { concurrency: 1 }, () => {
  test("unlayered rule beats a later layered rule", async () => {
    const got = await inspect({
      css: `.layered { color: blue; } @layer base { .layered { color: red; } }`,
      body: `<div id="el" class="layered"></div>`,
      selector: "#el",
      className: "layered",
      property: "color"
    })
    assert.deepEqual(got.applied, ["blue"])
    assert.deepEqual(got.overridden, ["red"])
  })

  test("later sibling layer beats an earlier layer", async () => {
    const got = await inspect({
      css: `@layer low, high; @layer low { .t { color: red; } } @layer high { .t { color: blue; } }`,
      body: `<div id="el" class="t"></div>`,
      selector: "#el",
      className: "t",
      property: "color"
    })
    assert.deepEqual(got.applied, ["blue"])
    assert.deepEqual(got.overridden, ["red"])
  })

  test("the same layer still uses source order", async () => {
    const got = await inspect({
      css: `@layer a { .t { color: red; } } @layer a { .t { color: green; } }`,
      body: `<div id="el" class="t"></div>`,
      selector: "#el",
      className: "t",
      property: "color"
    })
    assert.deepEqual(got.applied, ["green"])
    assert.deepEqual(got.overridden, ["red"])
  })

  test("a layer's own rules beat its sublayers", async () => {
    const got = await inspect({
      css: `@layer framework { .t { color: red; } @layer theme { .t { color: green; } } }`,
      body: `<div id="el" class="t"></div>`,
      selector: "#el",
      className: "t",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["green"])
  })

  test("earlier layer wins between important declarations", async () => {
    const got = await inspect({
      css: `@layer a, b; @layer a { .imp { color: red !important; } } @layer b { .imp { color: blue !important; } }`,
      body: `<div id="el" class="imp"></div>`,
      selector: "#el",
      className: "imp",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["blue"])
  })

  test("layered important beats a later unlayered important", async () => {
    const got = await inspect({
      css: `@layer base { .t { color: red !important; } } .t { color: blue !important; }`,
      body: `<div id="el" class="t"></div>`,
      selector: "#el",
      className: "t",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["blue"])
  })

  test("important sublayer beats important rules on the parent layer", async () => {
    const got = await inspect({
      css: `@layer framework { .t { color: red !important; } @layer later { .t { color: blue !important; } } }`,
      body: `<div id="el" class="t"></div>`,
      selector: "#el",
      className: "t",
      property: "color"
    })
    assert.deepEqual(got.applied, ["blue"])
    assert.deepEqual(got.overridden, ["red"])
  })

  test("stylesheet important beats a normal inline style", async () => {
    const got = await inspect({
      css: `.inline-demo { color: blue !important; }`,
      body: `<div id="el" class="inline-demo" style="color: red"></div>`,
      selector: "#el",
      className: "inline-demo",
      property: "color"
    })
    assert.deepEqual(got.applied, ["blue"])
    assert.deepEqual(got.inlineApplied, [])
    assert.deepEqual(got.inlineOverridden, ["red"])
  })

  test("normal inline style beats a normal class rule", async () => {
    const got = await inspect({
      css: `.inline-demo { color: blue; }`,
      body: `<div id="el" class="inline-demo" style="color: red"></div>`,
      selector: "#el",
      className: "inline-demo",
      property: "color"
    })
    assert.deepEqual(got.applied, [])
    assert.deepEqual(got.overridden, ["blue"])
    assert.deepEqual(got.inlineApplied, ["red"])
  })

  test("inline important beats stylesheet important", async () => {
    const got = await inspect({
      css: `.inline-demo { color: blue !important; }`,
      body: `<div id="el" class="inline-demo" style="color: red !important"></div>`,
      selector: "#el",
      className: "inline-demo",
      property: "color"
    })
    assert.deepEqual(got.applied, [])
    assert.deepEqual(got.overridden, ["blue"])
    assert.deepEqual(got.inlineApplied, ["red"])
  })

  test("non-matching container query does not apply", async () => {
    const got = await inspect({
      css: `.cq { color: navy; } @container (min-width: 9999px) { .cq { color: orange; } }`,
      body: `<div id="el" class="cq"></div>`,
      selector: "#el",
      className: "cq",
      property: "color"
    })
    assert.deepEqual(got.applied, ["navy"])
    assert.deepEqual(got.overridden, [])
  })

  test("container query applies when an ancestor container matches", async () => {
    const got = await inspect({
      css: `.cq { color: navy; } @container (min-width: 100px) { .cq { color: orange; } }`,
      body: `<div style="container-type: inline-size; width: 500px"><div id="el" class="cq"></div></div>`,
      selector: "#el",
      className: "cq",
      property: "color"
    })
    assert.deepEqual(got.applied, ["orange"])
    assert.deepEqual(got.overridden, ["navy"])
  })

  test("container query does not apply when the container is too small", async () => {
    const got = await inspect({
      css: `.cq { color: navy; } @container (min-width: 100px) { .cq { color: orange; } }`,
      body: `<div style="container-type: inline-size; width: 50px"><div id="el" class="cq"></div></div>`,
      selector: "#el",
      className: "cq",
      property: "color"
    })
    assert.deepEqual(got.applied, ["navy"])
    assert.deepEqual(got.overridden, [])
  })
})

describe("pseudo-classes", { concurrency: 1 }, () => {
  test(":where() does not add specificity", async () => {
    const got = await inspect({
      css: `.where-target { color: red; } :where(.where-target) { color: green; }`,
      body: `<div id="el" class="where-target"></div>`,
      selector: "#el",
      className: "where-target",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["green"])
  })

  test(":is() uses the most specific argument", async () => {
    const got = await inspect({
      css: `:is(.a, #missing) { color: green; } .a { color: red; }`,
      body: `<div id="el" class="a"></div>`,
      selector: "#el",
      className: "a",
      property: "color"
    })
    assert.deepEqual(got.applied, ["green"])
    assert.deepEqual(got.overridden, ["red"])
  })

  test(":not() uses the argument specificity", async () => {
    const got = await inspect({
      css: `:not(#nope) { color: green; } .btn { color: red; }`,
      body: `<div id="el" class="btn"></div>`,
      selector: "#el",
      className: "btn",
      property: "color"
    })
    assert.deepEqual(got.applied, [])
    assert.deepEqual(got.overridden, ["red"])
    assert.equal(got.computed, "rgb(0, 128, 0)")
  })

  test(":has() uses the most specific argument", async () => {
    const got = await inspect({
      css: `.box:has(#gone, .a) { color: green; } .box.extra { color: red; }`,
      body: `<div id="el" class="box extra"><span class="a"></span></div>`,
      selector: "#el",
      className: "box",
      property: "color"
    })
    assert.deepEqual(got.applied, ["green"])
    assert.deepEqual(got.overridden, ["red"])
  })
})

describe("imports", { concurrency: 1 }, () => {
  test("rules from a same-origin @import are visible", async () => {
    const got = await inspect({
      css: `@import url("__ORIGIN__/test/fixtures/imported.css");`,
      body: `<div id="el" class="imported-class"></div>`,
      selector: "#el",
      className: "imported-class",
      property: "color"
    })
    assert.equal(got.status, "applied")
    assert.deepEqual(got.applied, ["teal"])
  })

  test("@import layer() participates in layer order", async () => {
    const got = await inspect({
      css: `
        @layer early, base;
        @import url("__ORIGIN__/test/fixtures/base.css") layer(base);
        @import url("__ORIGIN__/test/fixtures/early.css") layer(early);
      `,
      body: `<div id="el" class="only-layered"></div>`,
      selector: "#el",
      className: "only-layered",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["blue"])
  })

  test("a non-matching @import media condition is skipped", async () => {
    const got = await inspect({
      css: `@import url("__ORIGIN__/test/fixtures/hidden.css") (max-width: 1px);`,
      body: `<div id="el" class="hidden-import"></div>`,
      selector: "#el",
      className: "hidden-import",
      property: "color"
    })
    assert.equal(got.status, "missing")
    assert.equal(got.ruleCount, 0)
  })

  test("a matching @import media condition is included", async () => {
    const got = await inspect({
      css: `@import url("__ORIGIN__/test/fixtures/wide.css") screen and (min-width: 1px);`,
      body: `<div id="el" class="wide-import"></div>`,
      selector: "#el",
      className: "wide-import",
      property: "color"
    })
    assert.deepEqual(got.applied, ["brown"])
  })

  test("@import supports() drops a failing condition", async () => {
    const got = await inspect({
      css: `@import url("__ORIGIN__/test/fixtures/purple.css") supports(display: not-a-display);`,
      body: `<div id="el" class="supports-import"></div>`,
      selector: "#el",
      className: "supports-import",
      property: "color"
    })
    assert.equal(got.ruleCount, 0)
    assert.equal(got.status, "missing")
  })

  test("@import supports() keeps a passing condition", async () => {
    const got = await inspect({
      css: `@import url("__ORIGIN__/test/fixtures/purple.css") supports(display: block);`,
      body: `<div id="el" class="supports-import"></div>`,
      selector: "#el",
      className: "supports-import",
      property: "color"
    })
    assert.deepEqual(got.applied, ["purple"])
  })
})

describe("nesting", { concurrency: 1 }, () => {
  test("nested rules match the descendant", async () => {
    const got = await inspect({
      css: `.nested { color: black; .nested-child { color: tomato; } }`,
      body: `<div class="nested"><span id="el" class="nested-child"></span></div>`,
      selector: "#el",
      className: "nested-child",
      property: "color"
    })
    assert.equal(got.status, "applied")
    assert.deepEqual(got.applied, ["tomato"])
  })

  test("declarations after a nested rule stay in source order", async () => {
    const got = await inspect({
      css: `.x { & { color: blue; } color: red; }`,
      body: `<div id="el" class="x"></div>`,
      selector: "#el",
      className: "x",
      property: "color"
    })
    assert.deepEqual(got.applied, ["red"])
    assert.deepEqual(got.overridden, ["blue"])
  })
})
