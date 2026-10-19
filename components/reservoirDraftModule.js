export function reservoirFormKey(type, id = "", targetEventId = "") {
  return JSON.stringify([type, id || "", targetEventId || ""]);
}

const formKey = (form) => reservoirFormKey(form.dataset.inventoryType, form.dataset.id, form.elements.namedItem("targetEventId")?.value);
const fields = (form) => [...form.querySelectorAll("input, select, textarea")].filter((field) => field.name);
const panelKey = (panel) => panel.dataset.reservoir || panel.dataset.historyKey || panel.dataset.inventoryPanel;

export function captureReservoirDrafts(root) {
  const active = root.ownerDocument?.activeElement;
  const forms = new Map();
  const formKeys = new Set();
  let focus = null;
  for (const form of root.querySelectorAll("form[data-inventory-type]")) {
    const key = formKey(form);
    formKeys.add(key);
    const values = fields(form);
    const dirty = values.some((field) => ["checkbox", "radio"].includes(field.type)
      ? field.checked !== field.defaultChecked
      : field.value !== (field.tagName === "SELECT" ? field.dataset.initialValue ?? field.value : field.defaultValue));
    if (!dirty && !form.contains(active)) continue;
    // Keep the expected revision with a correction draft so concurrent edits still conflict safely.
    forms.set(key, values.map((field) => ({ name: field.name, value: field.value, checked: field.checked })));
    if (values.includes(active)) focus = { key, name: active.name, start: active.selectionStart, end: active.selectionEnd };
  }
  return { forms, formKeys, focus, panelKeys: new Set([...root.querySelectorAll("details")].map(panelKey).filter(Boolean)),
    openPanels: new Set([...root.querySelectorAll("details[open]")].map(panelKey).filter(Boolean)) };
}

export function restoreReservoirDrafts(root, draft) {
  for (const select of root.querySelectorAll("select")) select.dataset.initialValue = select.value;
  if (!draft) return;
  for (const panel of root.querySelectorAll("details")) panel.open = draft.openPanels.has(panelKey(panel));
  for (const form of root.querySelectorAll("form[data-inventory-type]")) {
    const key = formKey(form);
    for (const saved of draft.forms.get(key) || []) {
      const field = form.elements.namedItem(saved.name);
      if (!field) continue;
      field.value = saved.value;
      if (["checkbox", "radio"].includes(field.type)) field.checked = saved.checked;
    }
    const capacity = form.elements.namedItem("capacityMl");
    const remaining = form.elements.namedItem("correctedRemainingMl");
    if (capacity && remaining && capacity.value) remaining.max = capacity.value;
    if (draft.focus?.key !== key) continue;
    const field = form.elements.namedItem(draft.focus.name);
    if (!field || field.disabled || !root.getClientRects().length) continue;
    field.focus({ preventScroll: true });
    if (typeof draft.focus.start === "number") {
      try { field.setSelectionRange(draft.focus.start, draft.focus.end); } catch { /* Number inputs do not expose a text selection. */ }
    }
  }
}
