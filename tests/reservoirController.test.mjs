import test from "node:test";
import assert from "node:assert/strict";
import { createReservoirController } from "../components/reservoirComponent.js";
import { captureReservoirDrafts, restoreReservoirDrafts, reservoirFormKey } from "../components/reservoirDraftModule.js";

function mockRoot({ correction = false } = {}) {
  const document = { activeElement: null };
  let forms;
  const listeners = {};
  const field = (name, value = "", type = "number") => ({ name, value, defaultValue: value, type, tagName: "INPUT", dataset: {},
    focus() { document.activeElement = this; }, setSelectionRange() {} });
  const makeForm = (id) => {
    const inputs = [field("amountMl")];
    if (correction) inputs.push(field("targetEventId", "event", "hidden"), field("expectedRevisionId", "revision-1", "hidden"));
    return { dataset: { inventoryType: correction ? "correct" : "refill", id }, inputs,
      elements: { namedItem: name => inputs.find(f => f.name === name) },
      querySelectorAll: () => inputs, contains: el => inputs.includes(el) };
  };
  const root = { ownerDocument: document, contains: el => forms.some(form => form.contains(el)), getClientRects: () => [{}], addEventListener: (name, callback) => { listeners[name] = callback; },
    querySelectorAll(selector) {
      if (selector === "form[data-inventory-type]") return forms;
      if (selector === "input") return forms.flatMap(form => form.inputs);
      return [];
    },
    set innerHTML(html) { forms = [makeForm("kh"), makeForm("ca")]; },
    get forms() { return forms; }, listeners,
  };
  root.innerHTML = "";
  return root;
}

test("An unsaved stock draft no longer blocks API refresh and survives both re-renders", async () => {
  const root = mockRoot();
  let requests = 0, snapshot;
  const controller = createReservoirController({ root, getTankId: () => "reef", getClient: () => ({
    list: async () => ({ reservoirs: [], calculatedAt: new Date().toISOString(), version: ++requests }),
  }), ensureSynced: async () => {}, onToast() {}, onChange: value => { snapshot = value; } });
  await controller.refresh();
  root.forms[0].inputs[0].value = "500";
  root.forms[0].inputs[0].focus();
  await controller.refresh();
  assert.equal(requests, 2);
  assert.equal(snapshot.result.version, 2);
  assert.equal(root.forms[0].inputs[0].value, "500");
  assert.equal(root.ownerDocument.activeElement, root.forms[0].inputs[0]);
  await controller.refresh({ force: true });
  assert.equal(root.forms[0].inputs[0].value, "");
});

test("Drafts are tank scoped and correction drafts retain their original expected revision", async () => {
  const root = mockRoot({ correction: true });
  root.forms[0].inputs[0].value = "300";
  const draft = captureReservoirDrafts(root);
  root.innerHTML = "new response";
  root.forms[0].elements.namedItem("expectedRevisionId").value = "revision-2";
  restoreReservoirDrafts(root, draft);
  assert.equal(root.forms[0].inputs[0].value, "300");
  assert.equal(root.forms[0].elements.namedItem("expectedRevisionId").value, "revision-1");
  let selected = "reef-a";
  const controller = createReservoirController({ root, getTankId: () => selected,
    getClient: () => ({ list: async () => ({ reservoirs: [], calculatedAt: new Date().toISOString() }) }), ensureSynced: async () => {}, onToast() {} });
  await controller.refresh();
  root.forms[0].inputs[0].value = "200";
  selected = "reef-b";
  await controller.refresh();
  assert.equal(root.forms[0].inputs[0].value, "");
  root.forms[0].inputs[0].value = "800";
  selected = "reef-a";
  await controller.refresh();
  assert.equal(root.forms[0].inputs[0].value, "200");
  assert.notEqual(reservoirFormKey("refill", "kh"), reservoirFormKey("calibrate", "kh"));
});

test("A successful retry clears only its submitted draft and exposes pending target identity", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored = JSON.stringify({ tankId: "reef", operation: { type: "refill", reservoirId: "kh", amountMl: 500, idempotencyKey: "retry" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => stored, setItem: (_, value) => { stored = value; }, removeItem: () => { stored = null; },
  } });
  try {
    const root = mockRoot();
    let snapshot;
    const controller = createReservoirController({ root, getTankId: () => "reef", getClient: () => ({
      list: async () => ({ reservoirs: [], calculatedAt: new Date().toISOString() }),
      operate: async () => ({ reservoirs: [], calculatedAt: new Date().toISOString() }),
    }), ensureSynced: async () => {}, onToast() {}, onChange: value => { snapshot = value; } });
    await controller.refresh();
    assert.equal(snapshot.pendingOperation.reservoirId, "kh");
    root.forms[0].inputs[0].value = "500";
    root.forms[1].inputs[0].value = "42";
    await root.listeners.click({ target: { closest: () => ({ dataset: { inventoryAction: "retry" } }) } });
    assert.equal(snapshot.pendingOperation, null);
    assert.equal(root.forms[0].inputs[0].value, "");
    assert.equal(root.forms[1].inputs[0].value, "42");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage;
  }
});
