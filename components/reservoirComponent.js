import { escapeHtml } from "../services/formatService.js";

const n = (v) => v === null ? "—" : Number(v).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
const date = (v) => v ? new Date(v).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "尚未設定";
const labels = { create: "建立滴定桶", calibrate: "人工校正", refill: "補充滴定液", capacity: "修改容量", threshold: "修改警告門檻",
  tracking: "庫存追蹤啟停", delete: "移除滴定桶", consumption: "每日消耗", consumption_correction: "消耗重新核算", execution: "裝置執行紀錄", execution_reconciliation: "實際消耗核對" };
const errorMessage = (error) => ({
  INVENTORY_CAPACITY_EXCEEDED: "補充後超過總容量，請調整補充量或先修改容量。",
  INVENTORY_CONFIRMATION_REQUIRED: "請先確認並校正實際剩餘量，再進行補充或容量調整。",
  DOSE_LINK_ALREADY_EXISTS: "這個滴定項目已有庫存桶，請先移除原桶或選擇其他項目。",
  INVALID_INVENTORY_INPUT: "請輸入有效的容量、數量或百分比。",
  INVENTORY_CONFLICT_RETRY: "同時有其他更新，請稍後重試。",
  IDEMPOTENCY_KEY_REUSED: "這筆操作識別碼已被使用，請重新整理後確認歷史紀錄。",
  SESSION_EXPIRED: "管理連線已到期，請至設定重新連線。",
  NO_SYNCED_DATA: "請先完成首次雲端匯入。",
  LOCAL_SYNC_REQUIRED: "滴定設定尚未成功同步，請先完成同步再管理庫存。",
}[error.message] || "暫時無法確認結果。請勿重複補充，使用重試確認這一筆操作。");

export function createReservoirController({ root, getTankId, getClient, ensureSynced, onToast }) {
  let tankId = null, result = null, busy = false, error = "", requestVersion = 0, invalidated = false;
  let pending = null;
  const history = new Map();
  const storageKey = "seawaterTankPendingInventory.v1";
  try { pending = JSON.parse(localStorage.getItem(storageKey)); } catch { /* A pending retry never changes tank records. */ }

  function storePending(value) {
    pending = value;
    try { value ? localStorage.setItem(storageKey, JSON.stringify(value)) : localStorage.removeItem(storageKey); } catch { /* In-memory retry still retains its idempotency key. */ }
  }

  function render() {
    const open = new Set([...root.querySelectorAll("details[open][data-reservoir]")].map((el) => el.dataset.reservoir));
    const rows = result?.reservoirs || [];
    root.innerHTML = `
      <div class="reservoir-heading"><div><h3>滴定桶庫存管理</h3><p class="muted">${result ? `計算 ${escapeHtml(date(result.calculatedAt))}` : "依已同步的有效滴定量估算"}</p></div>
        <button type="button" class="ghost-button" data-inventory-action="refresh" ${busy ? "disabled" : ""}>${busy ? "處理中" : "更新"}</button></div>
      ${!getClient() ? `<p class="notice">庫存保存在雲端。請先至<a href="#cloud">設定建立管理連線</a>，原本滴定設定不受影響。</p>` : ""}
      ${error ? `<p class="notice reservoir-warning" role="alert">${escapeHtml(error)}</p>` : ""}
      ${pending ? `<div class="notice reservoir-warning"><p>有一筆操作尚未確認結果，請先重試。重試不會重複入帳。</p><button type="button" class="ghost-button" data-inventory-action="retry" ${busy ? "disabled" : ""}>確認上一筆操作</button></div>` : ""}
      <div class="reservoir-list">${rows.map((r) => card(r, open.has(r.id))).join("")}</div>
      ${result && !busy && !pending ? `<details class="reservoir-add"><summary>新增滴定桶</summary>
        <form data-inventory-type="create"><label>名稱<input name="name" maxlength="80" required></label>
          <label>連動滴定項目<select name="doseKey">${["kh", "ca", "mg", "aplus", "kplus", "custom"].map((key) => `<option value="${key}" ${rows.some((r) => r.doseKey === key) ? "disabled" : ""}>${({ kh: "KH", ca: "CA", mg: "MG", aplus: "A+", kplus: "K+", custom: "自訂添加劑" })[key]}</option>`).join("")}</select></label>
          <label>總容量 mL<input name="capacityMl" type="number" inputmode="decimal" min="0.01" max="1000000" step="any" required></label>
          <button class="ghost-button" type="submit">新增</button></form></details>` : ""}
    `;
  }

  function card(r, open) {
    const disabled = busy || Boolean(pending);
    const status = r.remainingMl === null ? "待初始化" : r.remainingIsUpperBound ? "需確認" : r.alertStatus === "low" ? "低庫存" : "正常";
    const source = r.quality === "actual" ? "裝置執行量計算" : r.quality === "manually_confirmed" ? "人工確認基準" : r.remainingIsUpperBound ? "資料不完整" : "估算剩餘量";
    const days = r.estimatedDaysRemaining === null ? (!r.effectiveMlPerDay ? "停用／無消耗" : "待確認") : `約 ${n(r.estimatedDaysRemaining)} 天`;
    const h = history.get(r.id);
    const numeric = (name, label, value = "", required = true) => `<label>${label}<input name="${name}" type="number" inputmode="decimal" min="0" max="1000000" step="any" ${required ? "required" : ""} value="${value}" ${disabled ? "disabled" : ""}></label>`;
    return `<details class="reservoir-card ${r.alertStatus === "low" ? "is-low" : ""}" data-reservoir="${r.id}" ${open ? "open" : ""}>
      <summary><div class="reservoir-card-title"><strong>${escapeHtml(r.name)}</strong><span class="reservoir-status">${status}</span></div>
        <div class="reservoir-balance"><strong>${r.remainingMl === null ? "尚未設定" : `${r.remainingIsUpperBound ? "最多 " : ""}${n(r.remainingMl)}`} <small>/ ${n(r.capacityMl)} mL</small></strong><span>${r.percentage === null ? "—" : `${n(r.percentage)}%`}</span></div>
        <progress max="100" ${r.percentage !== null ? `value="${r.percentage}"` : "value=\"0\""} aria-label="${escapeHtml(r.name)} 剩餘百分比"></progress>
        <div class="reservoir-caption"><span>${r.remainingMl === null ? "輸入實際剩餘量後開始計算" : source}</span><span>${days}</span></div>
      </summary>
      <div class="reservoir-card-body">
        <dl class="reservoir-stats"><div><dt>設定滴定量</dt><dd>${n(r.configuredMlPerDay)} mL/day</dd></div><div><dt>有效消耗量</dt><dd>${n(r.effectiveMlPerDay)} mL/day</dd></div>
          <div><dt>滴定狀態</dt><dd>${r.enabled && !r.pausedDays ? "啟用" : "停用／暫停"}</dd></div><div><dt>庫存追蹤</dt><dd>${r.trackingActive ? "啟用" : "停用"}</dd></div></dl>
        ${r.warning ? `<p class="notice ${r.alertStatus === "low" || r.remainingIsUpperBound ? "reservoir-warning" : ""}">${escapeHtml(r.warning)}</p>` : ""}
        <form data-inventory-type="calibrate" data-id="${r.id}">${numeric("amountMl", r.remainingMl === null ? "實際剩餘量 mL" : "校正剩餘量 mL")}<button class="primary-button" ${disabled ? "disabled" : ""}>${r.remainingMl === null ? "設定初始庫存" : "確認校正"}</button></form>
        <form data-inventory-type="refill" data-id="${r.id}">${numeric("amountMl", "補充量 mL")}<button class="ghost-button" ${disabled || r.remainingMl === null || r.remainingIsUpperBound ? "disabled" : ""}>補充滴定液</button></form>
        <details class="reservoir-options"><summary>容量與庫存設定</summary>
          <form data-inventory-type="capacity" data-id="${r.id}">${numeric("capacityMl", "總容量 mL", r.capacityMl)}${numeric("correctedRemainingMl", "若縮小容量，確認實際剩餘量 mL", "", false)}<button class="ghost-button" ${disabled ? "disabled" : ""}>儲存容量</button></form>
          <form data-inventory-type="threshold" data-id="${r.id}">${numeric("warningThreshold", "低庫存門檻 %", r.warningThreshold)}<button class="ghost-button" ${disabled ? "disabled" : ""}>儲存門檻</button></form>
          <div class="reservoir-actions"><button class="ghost-button" type="button" data-inventory-action="tracking" data-id="${r.id}" ${disabled ? "disabled" : ""}>${r.trackingActive ? "停用" : "啟用"}庫存追蹤</button><button class="danger-button" type="button" data-inventory-action="delete" data-id="${r.id}" ${disabled ? "disabled" : ""}>移除滴定桶</button></div>
        </details>
        <dl class="reservoir-times"><div><dt>最後人工確認</dt><dd>${escapeHtml(date(r.lastManualConfirmedAt))}</dd></div><div><dt>最近補充</dt><dd>${escapeHtml(date(r.lastRefilledAt))}</dd></div><div><dt>最後計算</dt><dd>${escapeHtml(date(r.lastCalculatedAt))}</dd></div></dl>
        <details class="reservoir-history"><summary>補充與每日消耗紀錄</summary><button type="button" class="ghost-button" data-inventory-action="history" data-id="${r.id}" ${busy ? "disabled" : ""}>${h ? "重新載入" : "查看紀錄"}</button>
          ${h ? `<ol>${h.entries.map((e) => `<li><div><strong>${escapeHtml(labels[e.type] || e.type)}</strong><time>${escapeHtml(e.local_date?.slice?.(0, 10) || String(e.local_date).slice(0, 10))}</time></div><p>${["consumption", "consumption_correction", "execution_reconciliation"].includes(e.type) ? `消耗 ${n(Number(e.amount_ml))} mL${e.metadata?.dailyTotal?.estimatedMl ? "（估算）" : ""}` : `${e.before_ml === null ? "未設定" : n(Number(e.before_ml))} → ${e.after_ml === null ? "未設定" : n(Number(e.after_ml))} mL`}</p></li>`).join("")}</ol>${h.nextCursor ? `<button type="button" class="ghost-button" data-inventory-action="more-history" data-id="${r.id}" ${busy ? "disabled" : ""}>較早紀錄</button>` : ""}` : ""}
        </details>
      </div></details>`;
  }

  async function refresh({ force = false } = {}) {
    if (busy) return;
    const selected = getTankId();
    if (selected !== tankId) { tankId = selected; result = null; history.clear(); }
    else if (!force && (root.contains(document.activeElement) || [...root.querySelectorAll("input")].some((input) => input.value !== input.defaultValue))) return;
    if (!selected || !getClient()) { render(); return; }
    const version = ++requestVersion;
    busy = true; error = ""; render();
    try {
      await ensureSynced();
      const next = await getClient().list(selected);
      if (version === requestVersion && selected === getTankId()) result = next;
    } catch (e) { if (version === requestVersion) error = errorMessage(e); }
    finally {
      busy = false;
      if (invalidated) { invalidated = false; void refresh({ force: true }); }
      else if (selected === getTankId()) render();
      else { tankId = null; void refresh(); }
    }
  }

  async function submitOperation(operation, selected = getTankId()) {
    if (busy || !getClient()) return;
    busy = true; error = "";
    storePending({ tankId: selected, operation });
    render();
    try {
      await ensureSynced();
      const next = await getClient().operate(selected, operation);
      storePending(null);
      if (selected === getTankId()) { result = next; history.clear(); }
      onToast("庫存已更新，滴定設定未變更");
    } catch (e) {
      // Deterministic validation failures cannot have committed; network failures keep the exact retry request.
      if (["INVALID_INVENTORY_INPUT", "INVENTORY_CAPACITY_EXCEEDED", "INVENTORY_CONFIRMATION_REQUIRED", "DOSE_LINK_ALREADY_EXISTS", "RESERVOIR_NOT_FOUND", "TANK_NOT_FOUND", "INVENTORY_LIMIT_REACHED", "LOCAL_SYNC_REQUIRED"].includes(e.message)) storePending(null);
      error = errorMessage(e);
      onToast(error);
    } finally { busy = false; render(); }
  }

  root.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-inventory-type]");
    if (!form) return;
    event.preventDefault();
    if (pending || busy) return;
    const operation = { type: form.dataset.inventoryType, reservoirId: form.dataset.id, idempotencyKey: crypto.randomUUID() };
    for (const [key, value] of new FormData(form)) if (value !== "") operation[key] = ["name", "doseKey"].includes(key) ? value : Number(value);
    const r = result?.reservoirs.find((entry) => entry.id === operation.reservoirId);
    const message = operation.type === "refill" ? `確認補充 ${r?.name} ${n(operation.amountMl)} mL？\n將留下補充紀錄，不改變每日滴定量。`
      : operation.type === "calibrate" ? `確認 ${r?.name} 實際剩餘 ${n(operation.amountMl)} mL？\n庫存將從現在重新計算。`
      : operation.type === "capacity" ? "確認修改容量？剩餘量不會自動變滿。" : "確認儲存這項庫存設定？";
    if (confirm(message)) void submitOperation(operation);
  });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-inventory-action]");
    if (!button || busy) return;
    const action = button.dataset.inventoryAction;
    if (action === "refresh") {
      if ([...root.querySelectorAll("input")].some((input) => input.value !== input.defaultValue) && !confirm("更新會清除尚未送出的庫存輸入，確定更新？")) return;
      return refresh({ force: true });
    }
    if (action === "retry" && pending) return submitOperation(pending.operation, pending.tankId);
    const r = result?.reservoirs.find((entry) => entry.id === button.dataset.id);
    if (!r) return;
    if (action === "history" || action === "more-history") {
      button.disabled = true;
      try {
        const selected = tankId;
        const h = await getClient().history(selected, r.id, action === "more-history" ? history.get(r.id)?.nextCursor : null);
        if (selected !== getTankId()) return;
        history.set(r.id, action === "more-history" ? { ...h, entries: [...history.get(r.id).entries, ...h.entries] } : h);
        render();
        root.querySelector(`[data-reservoir="${r.id}"] .reservoir-history`).open = true;
      } catch (e) { onToast(errorMessage(e)); button.disabled = false; }
      return;
    }
    if (pending) return;
    if (confirm(action === "delete" ? `移除 ${r.name} 滴定桶？\n庫存歷史保留，原有滴定設定不會刪除或停用。`
      : `${r.trackingActive ? "停用" : "啟用"} ${r.name} 庫存追蹤？\n這不會改變實際滴定機或每日滴定設定。`)) {
      void submitOperation({ type: action, reservoirId: r.id, ...(action === "tracking" ? { active: !r.trackingActive } : {}), idempotencyKey: crypto.randomUUID() });
    }
  });
  render();
  return { refresh, invalidate() { ++requestVersion; tankId = null; result = null; error = ""; history.clear(); if (busy) invalidated = true; else render(); } };
}
