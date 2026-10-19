import { escapeHtml } from "../services/formatService.js";
import { MAX_RESERVOIR_CAPACITY_ML } from "../modules/reservoirModule.js";
import { validReservoirAlertDays } from "../engines/reservoirAlertEngine.js";

const n = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
const dayText = (v) => Number(v).toLocaleString("zh-TW", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const date = (v) => v ? new Date(v).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "尚未設定";
const labels = { create: "建立滴定桶", calibrate: "人工校正", refill: "添加滴定液", correct: "更正歷史紀錄", capacity: "修改容量", threshold: "修改天數門檻", reserve: "修改桶底保留量",
  tracking: "庫存追蹤啟停", delete: "移除滴定桶", consumption: "每日消耗", consumption_correction: "消耗重新核算", execution: "裝置執行紀錄", execution_reconciliation: "實際消耗核對" };
const errorMessage = (error) => ({
  INVENTORY_CAPACITY_EXCEEDED: "補充後超過總容量，請調整補充量或先修改容量。",
  INVENTORY_CONFIRMATION_REQUIRED: "請先確認並校正實際剩餘量，再進行補充或容量調整。",
  DOSE_LINK_ALREADY_EXISTS: "這個滴定項目已有庫存桶，請先移除原桶或選擇其他項目。",
  INVALID_INVENTORY_INPUT: "請輸入有效數值，剩餘量及保留量不能超過此桶容量。",
  INVALID_INVENTORY_ALERT_DAYS: "請設定：採購提醒天數 > 警告天數 > 緊急天數 > 0。",
  INVENTORY_RESERVE_EXCEEDS_CAPACITY: "新容量小於桶底保留量，請先調整保留量。",
  INVENTORY_CONFLICT_RETRY: "同時有其他更新，請稍後重試。",
  INVENTORY_HISTORY_NOT_FOUND: "找不到這筆添加或校正紀錄，請更新後確認。",
  INVENTORY_HISTORY_CONFLICT: "這筆紀錄已被其他裝置更正，請更新後再操作。",
  INVENTORY_CORRECTION_CONFLICT: "更正會讓歷史存量超過當時容量，請確認添加量、校正值或容量設定。",
  IDEMPOTENCY_KEY_REUSED: "這筆操作識別碼已被使用，請重新整理後確認歷史紀錄。",
  SESSION_EXPIRED: "管理連線已到期，請至設定重新連線。",
  NO_SYNCED_DATA: "請先完成首次雲端匯入。",
  LOCAL_SYNC_REQUIRED: "滴定設定尚未成功同步，請先完成同步再管理庫存。",
}[error.message] || "暫時無法確認結果。請勿重複補充，使用重試確認這一筆操作。");

export function renderReservoirManualHistory(r, disabled = false) {
  const quality = (value) => ({ estimated: "系統估算", manually_confirmed: "人工校正基準", actual: "依裝置執行量計算", data_gap: "資料不完整" })[value] || "舊紀錄未標示來源";
  return ["refill", "calibrate"].map((type) => {
    const entries = type === "refill" ? r.refillHistory || [] : r.calibrationHistory || [];
    const label = type === "refill" ? "添加" : "校正";
    return `<details class="reservoir-manual-history" data-history-key="${r.id}-${type}"><summary>${label}歷史${entries.length ? ` · ${entries.length}` : ""}</summary>
      ${entries.length ? `<ol class="reservoir-manual-list">${entries.map((entry) => `<li>
        <div><strong>${label} ${n(entry.amountMl)} mL${entry.corrected ? " · 已更正" : ""}</strong><time>${escapeHtml(date(entry.occurredAt))}</time></div>
        <p>${entry.corrected ? "原始紀錄：" : ""}${entry.beforeMl === null ? "未設定" : n(entry.beforeMl)} → ${entry.afterMl === null ? "未設定" : n(entry.afterMl)} mL</p>
        <p class="muted">添加／校正前：${escapeHtml(quality(entry.beforeQuality))}</p>
        ${entry.notes ? `<p>備註：${escapeHtml(entry.notes)}</p>` : ""}${entry.reason ? `<p>原因：${escapeHtml(entry.reason)}</p>` : ""}
        ${entry.corrected ? `<p>更正後${label}量 ${n(entry.effectiveAmountMl)} mL${entry.effectiveNotes ? ` · ${escapeHtml(entry.effectiveNotes)}` : ""}</p>
          <details><summary>更正痕跡</summary><ol>${entry.corrections.map((c) => `<li><time>${escapeHtml(date(c.recordedAt))}</time><p>${n(c.previousAmountMl)} → ${n(c.amountMl)} mL</p><p>${escapeHtml(c.reason)}</p><p>更正當下存量 ${n(c.beforeRemainingMl)} → ${n(c.afterRemainingMl)} mL</p></li>`).join("")}</ol></details>` : ""}
        <details class="reservoir-options"><summary>更正此紀錄</summary><form data-inventory-type="correct" data-id="${r.id}">
          <input type="hidden" name="targetEventId" value="${escapeHtml(entry.id)}"><input type="hidden" name="targetType" value="${type}"><input type="hidden" name="expectedRevisionId" value="${escapeHtml(entry.revisionId)}">
          <label>正確的${label}量 mL<input name="amountMl" type="number" inputmode="decimal" min="${type === "refill" ? "0.000001" : "0"}" max="${MAX_RESERVOIR_CAPACITY_ML}" step="any" value="${entry.effectiveAmountMl}" required ${disabled ? "disabled" : ""}></label>
          <label>備註<input name="notes" maxlength="1000" value="${escapeHtml(entry.effectiveNotes)}" ${disabled ? "disabled" : ""}></label>
          <label>更正原因<input name="reason" maxlength="1000" required ${disabled ? "disabled" : ""}></label><button class="ghost-button" ${disabled ? "disabled" : ""}>儲存更正</button>
        </form></details></li>`).join("")}</ol>` : `<p class="muted">尚無${label}紀錄</p>`}
    </details>`;
  }).join("");
}

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
    const expandedHistory = new Set([...root.querySelectorAll("details[open][data-history-key]")].map((el) => el.dataset.historyKey));
    const rows = result?.reservoirs || [];
    root.innerHTML = `
      <div class="reservoir-heading"><div><h3>滴定桶庫存管理</h3><p class="muted">${result ? `計算 ${escapeHtml(date(result.calculatedAt))}` : "依已同步的有效滴定量估算"}</p></div>
        <button type="button" class="ghost-button" data-inventory-action="refresh" ${busy ? "disabled" : ""}>${busy ? "處理中" : "更新"}</button></div>
      <p class="reservoir-estimate-note">庫存與可用天數為系統推估，非液位感測器實測。</p>
      ${!getClient() ? `<p class="notice">庫存保存在雲端。請先至<a href="#cloud">設定建立管理連線</a>，原本滴定設定不受影響。</p>` : ""}
      ${error ? `<p class="notice reservoir-warning" role="alert">${escapeHtml(error)}</p>` : ""}
      ${pending ? `<div class="notice reservoir-warning"><p>有一筆操作尚未確認結果，請先重試。重試不會重複入帳。</p><button type="button" class="ghost-button" data-inventory-action="retry" ${busy ? "disabled" : ""}>確認上一筆操作</button></div>` : ""}
      <div class="reservoir-list">${rows.map((r) => card(r, open.has(r.id))).join("")}</div>
      ${result && !busy && !pending ? `<details class="reservoir-add"><summary>新增滴定桶</summary>
        <form data-inventory-type="create"><label>名稱<input name="name" maxlength="80" required></label>
          <label>連動滴定項目<select name="doseKey">${["kh", "ca", "mg", "aplus", "kplus", "custom"].map((key) => `<option value="${key}" ${rows.some((r) => r.doseKey === key) ? "disabled" : ""}>${({ kh: "KH", ca: "CA", mg: "MG", aplus: "A+", kplus: "K+", custom: "自訂添加劑" })[key]}</option>`).join("")}</select></label>
          <label>總容量 mL<input name="capacityMl" type="number" inputmode="decimal" min="0.000001" max="${MAX_RESERVOIR_CAPACITY_ML}" step="any" required></label>
          <button class="ghost-button" type="submit">新增</button></form></details>` : ""}
    `;
    root.querySelectorAll("details[data-history-key]").forEach((el) => { el.open = expandedHistory.has(el.dataset.historyKey); });
  }

  function card(r, open) {
    const disabled = busy || Boolean(pending);
    const status = r.alertLabel || "無法估算／待設定";
    const source = r.quality === "actual" ? "裝置執行量計算" : r.quality === "manually_confirmed" ? "人工確認基準" : r.remainingIsUpperBound ? "資料不完整" : "估算剩餘量";
    const days = r.estimatedDaysRemaining === null ? status : `推估 ${dayText(r.estimatedDaysRemaining)} 天`;
    const h = history.get(r.id);
    const numeric = (name, label, value = "", required = true, max = MAX_RESERVOIR_CAPACITY_ML, min = 0) => `<label>${label}<input name="${name}" type="number" inputmode="decimal" min="${min}" max="${max}" step="any" ${required ? "required" : ""} value="${value}" ${disabled ? "disabled" : ""}></label>`;
    return `<details class="reservoir-card is-${r.alertStatus}" data-reservoir="${r.id}" ${open ? "open" : ""}>
      <summary><div class="reservoir-card-title"><strong>${escapeHtml(r.name)}</strong><span class="reservoir-status">${status}</span></div>
        <div class="reservoir-balance"><strong>${r.remainingMl === null ? "尚未設定" : `${r.remainingIsUpperBound ? "最多 " : ""}${n(r.remainingMl)}`} <small>/ ${n(r.capacityMl)} mL</small></strong><span>${r.percentage === null ? "—" : `${n(r.percentage)}%`}</span></div>
        <progress max="100" ${r.percentage !== null ? `value="${r.percentage}"` : "value=\"0\""} aria-label="${escapeHtml(r.name)} 剩餘百分比"></progress>
        <div class="reservoir-caption"><span>${r.remainingMl === null ? "輸入實際剩餘量後開始計算" : source}</span><span>${days}</span></div>
        <p class="reservoir-last-refill">${r.lastRefill ? `最近添加 ${n(r.lastRefilledAmountMl)} mL · ${escapeHtml(date(r.lastRefill.occurredAt))}` : "尚無添加紀錄"}</p>
      </summary>
      <div class="reservoir-card-body">
        <dl class="reservoir-stats"><div><dt>設定滴定量</dt><dd>${n(r.configuredMlPerDay)} mL/day</dd></div><div><dt>有效消耗量</dt><dd>${n(r.effectiveMlPerDay)} mL/day</dd></div>
          <div><dt>桶底保留量</dt><dd>${n(r.bottomReserveMl)} mL</dd></div><div><dt>可用液量</dt><dd>${n(r.usableMl)} mL</dd></div>
          <div><dt>滴定狀態</dt><dd>${r.enabled && !r.pausedDays ? "啟用" : "停用／暫停"}</dd></div><div><dt>庫存追蹤</dt><dd>${r.trackingActive ? "啟用" : "停用"}</dd></div></dl>
        ${r.warning ? `<p class="notice ${r.requiresAlert || r.remainingIsUpperBound ? "reservoir-warning" : ""}">${escapeHtml(r.warning)}</p>` : ""}
        <form data-inventory-type="calibrate" data-id="${r.id}">${numeric("amountMl", r.remainingMl === null ? "實際剩餘量 mL" : "校正剩餘量 mL", "", true, r.capacityMl)}<label>校正原因<input name="reason" maxlength="1000" ${r.remainingMl !== null ? "required" : ""} ${disabled ? "disabled" : ""}></label><button class="primary-button" ${disabled ? "disabled" : ""}>${r.remainingMl === null ? "設定初始庫存" : "確認校正"}</button></form>
        <form data-inventory-type="refill" data-id="${r.id}">${numeric("amountMl", "本次添加量 mL", "", true, r.remainingMl === null ? r.capacityMl : Math.max(r.capacityMl - r.remainingMl, 0), 0.000001)}<label>備註（選填）<input name="notes" maxlength="1000" ${disabled ? "disabled" : ""}></label><button class="ghost-button" ${disabled || r.remainingMl === null || r.remainingIsUpperBound ? "disabled" : ""}>添加滴定液</button></form>
        ${renderReservoirManualHistory(r, disabled)}
        <details class="reservoir-options"><summary>容量與庫存設定</summary>
          <form data-inventory-type="capacity" data-id="${r.id}">${numeric("capacityMl", "總容量 mL", r.capacityMl)}${numeric("correctedRemainingMl", "若縮小容量，確認實際剩餘量 mL", "", false, r.capacityMl)}<button class="ghost-button" ${disabled ? "disabled" : ""}>儲存容量</button></form>
          <form data-inventory-type="reserve" data-id="${r.id}">${numeric("bottomReserveMl", "桶底保留量 mL", r.bottomReserveMl, true, r.capacityMl)}<button class="ghost-button" ${disabled ? "disabled" : ""}>儲存保留量</button></form>
          <form data-inventory-type="threshold" data-id="${r.id}">${numeric("reminderDays", "採購提醒天數", r.alertThresholds.reminderDays)}${numeric("warningDays", "警告天數", r.alertThresholds.warningDays)}${numeric("urgentDays", "緊急天數", r.alertThresholds.urgentDays)}<button class="ghost-button" ${disabled ? "disabled" : ""}>儲存天數門檻</button></form>
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
      if (["INVENTORY_HISTORY_NOT_FOUND", "INVENTORY_HISTORY_CONFLICT", "INVENTORY_CORRECTION_CONFLICT", "INVALID_INVENTORY_INPUT", "INVALID_INVENTORY_ALERT_DAYS", "INVENTORY_RESERVE_EXCEEDS_CAPACITY", "INVENTORY_CAPACITY_EXCEEDED", "INVENTORY_CONFIRMATION_REQUIRED", "DOSE_LINK_ALREADY_EXISTS", "RESERVOIR_NOT_FOUND", "TANK_NOT_FOUND", "INVENTORY_LIMIT_REACHED", "LOCAL_SYNC_REQUIRED"].includes(e.message)) storePending(null);
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
    for (const [key, value] of new FormData(form)) if (value !== "" || key === "notes") operation[key] = ["name", "doseKey", "notes", "reason", "targetEventId", "targetType", "expectedRevisionId"].includes(key) ? value : Number(value);
    const r = result?.reservoirs.find((entry) => entry.id === operation.reservoirId);
    if (operation.type === "threshold") {
      operation.alertThresholds = { reminderDays: operation.reminderDays, warningDays: operation.warningDays, urgentDays: operation.urgentDays };
      delete operation.reminderDays; delete operation.warningDays; delete operation.urgentDays;
      if (!validReservoirAlertDays(operation.alertThresholds)) return onToast(errorMessage({ message: "INVALID_INVENTORY_ALERT_DAYS" }));
    }
    if (operation.type === "capacity" && r.remainingMl !== null && operation.capacityMl < r.remainingMl && operation.correctedRemainingMl === undefined) {
      return onToast("新容量小於目前剩餘量，請輸入並確認修正後的實際剩餘量。");
    }
    const message = operation.type === "refill" ? `確認添加 ${r?.name} ${n(operation.amountMl)} mL？\n添加前為${r?.quality === "manually_confirmed" ? "人工確認" : "系統估算"} ${n(r?.remainingMl)} mL，時間自動記錄。`
      : operation.type === "correct" ? "確認更正這筆紀錄？原始紀錄保留，存量會依歷史設定重新計算，不改每日滴定量。"
      : operation.type === "calibrate" ? `確認 ${r?.name} 實際剩餘 ${n(operation.amountMl)} mL？\n庫存將從現在重新計算。`
      : operation.type === "capacity" ? "確認修改容量？剩餘量不會自動變滿。" : "確認儲存這項庫存設定？";
    if (confirm(message)) void submitOperation(operation);
  });

  root.addEventListener("input", (event) => {
    const input = event.target;
    const form = input.closest('form[data-inventory-type="capacity"]');
    if (form && input.name === "capacityMl") form.elements.correctedRemainingMl.max = input.value || MAX_RESERVOIR_CAPACITY_ML;
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
