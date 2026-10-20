import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../app.module.js", import.meta.url), "utf8");
const navigationSource = source.slice(source.indexOf("function pageIdFromHash()"), source.indexOf("function formData(form)"));
const sections = ["dashboard", "water", "dosing", "history", "tank"];

function navigation({ hash = "", hasTank = true } = {}) {
  const element = (id) => {
    const classes = new Set();
    const attributes = new Map();
    return { id, dataset: { section: id }, classes, attributes,
      classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    };
  };
  const links = sections.map(element);
  const pages = [...sections, "analysis", "trends", "cloud", "bio-load"].map(element);
  const location = { hash };
  const entries = [];
  const title = { textContent: "" };
  const noop = () => {};
  const context = {
    window: { location }, CSS: { escape: value => value }, hasTanks: () => hasTank, tankFormMode: "edit",
    document: {
      querySelector: selector => selector === "#pageTitle" ? title : pages.find(page => `.page#${page.id}` === selector),
      querySelectorAll: selector => selector === ".page" ? pages : links,
    },
    history: { pushState(_state, _unused, url) { entries.push(url); location.hash = url; } },
    renderAnalysis: noop, renderDosingSavedMeta: noop, renderDashboard: noop, renderForms: noop,
    ReservoirInventory: { refresh: noop },
  };
  const functions = runInNewContext(`${navigationSource}\n({ switchPage, pageIdFromHash });`, context);
  return { ...functions, links, pages, entries, location, title };
}

function assertSelection(nav, section, page = section) {
  assert.deepEqual(nav.links.filter(link => link.classes.has("active")).map(link => link.id), [section]);
  assert.deepEqual(nav.links.filter(link => link.attributes.get("aria-current") === "page").map(link => link.id), [section]);
  assert.deepEqual(nav.pages.filter(item => item.classes.has("active")).map(item => item.id), [page]);
}

test("All five bottom tabs share a single route-driven selection, including rapid revisits", () => {
  const nav = navigation();
  for (const section of [...sections, ...sections.toReversed(), "water", "history", "dashboard"]) {
    nav.switchPage(section);
    assertSelection(nav, section);
    assert.equal(nav.location.hash, `#${section}`);
  }
});

test("Deep links and browser history restoration reuse the current hash without creating entries", () => {
  for (const section of sections) {
    const nav = navigation({ hash: `#${section}` });
    nav.switchPage(nav.pageIdFromHash(), { updateRoute: false });
    assertSelection(nav, section);
    assert.equal(nav.entries.length, 0);
    nav.location.hash = "#water";
    nav.switchPage(nav.pageIdFromHash(), { updateRoute: false });
    assertSelection(nav, "water");
    assert.equal(nav.entries.length, 0);
  }
  const nav = navigation({ hash: "#unknown" });
  nav.switchPage(nav.pageIdFromHash(), { updateRoute: false });
  assertSelection(nav, "dashboard");
});

test("Secondary pages select their existing parent tab, not measurement", () => {
  const nav = navigation();
  for (const [page, section] of [["analysis", "dashboard"], ["trends", "history"], ["cloud", "tank"], ["bio-load", "tank"]]) {
    nav.switchPage(page);
    assertSelection(nav, section, page);
  }
});

test("Navigation creates history entries only when the route actually changes", () => {
  const nav = navigation({ hash: "#dashboard" });
  nav.switchPage("dashboard");
  nav.switchPage("water");
  nav.switchPage("water");
  nav.switchPage("history");
  assert.deepEqual(nav.entries, ["#water", "#history"]);
  assert.match(source, /addEventListener\("hashchange",\s*\(\) =>\s*{\s*switchPage\(pageIdFromHash\(\),\s*{ updateRoute: false }\)/);
});

test("First-tank redirect selects settings rather than leaving measurement highlighted", () => {
  const nav = navigation({ hasTank: false });
  nav.switchPage("water");
  assertSelection(nav, "tank");
  assert.equal(nav.location.hash, "#tank");
});

test("Bottom navigation has no permanent primary tab and keeps keyboard focus separate from selection", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(html + css, /mobile-nav-primary/);
  const base = css.match(/\.mobile-bottom-nav \.nav-link \{([^}]+)\}/)[1];
  const active = css.match(/\.mobile-bottom-nav \.nav-link\.active \{([^}]+)\}/)[1];
  const focus = css.match(/\.mobile-bottom-nav \.nav-link:focus-visible \{([^}]+)\}/)[1];
  assert.match(base, /background: transparent/);
  assert.match(base, /box-shadow: none/);
  assert.match(base, /-webkit-tap-highlight-color: transparent/);
  assert.match(active, /background: linear-gradient/);
  assert.match(active, /color: #fff/);
  assert.match(focus, /outline: 2px solid/);
  assert.doesNotMatch(focus, /background:/);
});
