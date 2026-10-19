import { reservoirDose, sameReservoirDose } from "../modules/reservoirModule.js";
import { escapeHtml } from "../services/formatService.js";
import { formatReservoirDays, inventoryFreshness } from "../services/reservoirDisplayService.js";

// Present the inventory API's classification; never calculate stock or classify rounded days here.
export function reservoirFocusMessages({ tankId, dosing, snapshot = {}, online = true, now = Date.now() }) {
  if (!tankId) return [];
  const message = (text) => [{ level: "needs_confirmation", text }];
  if (!snapshot.connected) return message("滴定桶庫存尚未連線，請至滴定頁確認資料。");
  if (snapshot.tankId !== tankId || !snapshot.result) return message("滴定桶資料待更新，請至滴定頁確認。");
  if (!Array.isArray(snapshot.result.reservoirs)) return message("滴定桶資料不完整，請至滴定頁確認。");
  const rows = snapshot.result.reservoirs.filter((r) => r.tankId === tankId && !r.deletedAt);
  if (!rows.length) return message("尚未設定滴定桶庫存，請至滴定頁補齊資料。");
  const freshness = inventoryFreshness({ calculatedAt: snapshot.result.calculatedAt, now, online,
    refreshError: snapshot.refreshError ?? snapshot.error });
  const pending = snapshot.pendingOperation?.tankId === tankId ? snapshot.pendingOperation : null;
  const unknownPending = snapshot.pending && !snapshot.pendingOperation;
  const pendingNames = [];
  const groups = { urgent: [], warning: [], reminder: [], needs_confirmation: [] };
  for (const row of rows) {
    const current = reservoirDose(dosing, row.doseKey);
    if (pending?.reservoirId === row.id) { pendingNames.push(row.name); continue; }
    if (current.enabled === false || current.pausedDays > 0 || current.effectiveMlPerDay === 0) continue;
    const incomplete = () => groups.needs_confirmation.push(row.name);
    if (!sameReservoirDose(current, row)) { incomplete(); continue; }
    if (["pending_initialization", "unavailable", "needs_confirmation", "tracking_disabled"].includes(row.alertStatus)) { incomplete(); continue; }
    if (!Number.isFinite(row.remainingMl) || row.remainingMl < 0 || !Number.isFinite(row.estimatedDaysRemaining)
      || row.estimatedDaysRemaining < 0 || row.remainingIsUpperBound) { incomplete(); continue; }
    if (row.alertStatus === "normal") continue;
    if (!groups[row.alertStatus]) { incomplete(); continue; }
    groups[row.alertStatus].push(row);
  }
  const messages = [];
  const actions = { urgent: "請儘快檢查或補液", warning: "請準備補液", reminder: "請確認備品或安排採購" };
  for (const level of ["urgent", "warning", "reminder"]) {
    const entries = groups[level].sort((a, b) => a.estimatedDaysRemaining - b.estimatedDaysRemaining || a.name.localeCompare(b.name));
    if (!entries.length) continue;
    const text = entries.map((r) => r.remainingMl === 0 ? `${r.name} 滴定液預估耗盡`
      : r.usableMl === 0 ? `${r.name} 滴定液可用量預估耗盡`
      : r.estimatedDaysRemaining < 1 ? `${r.name} 滴定液預估不足 1 天`
      : `${r.name} 滴定液預估剩 ${formatReservoirDays(r.estimatedDaysRemaining)}`).join("；");
    messages.push({ level, text: `${freshness.stale || unknownPending ? "上次估算：" : ""}${text}，${actions[level]}。` });
  }
  if (pendingNames.length) messages.push({ level: "needs_confirmation", text: `${pendingNames.join("、")} 操作待確認，請至滴定頁確認結果；該桶暫不顯示可用天數。` });
  else if (pending || unknownPending) messages.push({ level: "needs_confirmation", text: "有滴定桶操作待確認，請至滴定頁確認結果。" });
  if (groups.needs_confirmation.length) messages.push({ level: "needs_confirmation",
    text: `${groups.needs_confirmation.join("、")} 庫存或滴定資料需補齊／更新，暫無可靠可用天數。` });
  if (freshness.stale) messages.push({ level: "needs_confirmation", text: freshness.message });
  return messages;
}

export function renderReservoirFocus(messages, priority) {
  return messages.filter((entry) => (entry.level === "urgent") === priority)
    .map((entry) => `<a class="focus-inventory-alert is-${entry.level}" href="#dosing" title="查看目前魚缸的滴定桶庫存">${escapeHtml(entry.text)}</a>`).join("");
}
