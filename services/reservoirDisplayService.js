export const INVENTORY_FRESHNESS_MS = 15 * 60 * 1000;

export function formatReservoirDays(days) {
  if (!Number.isFinite(days) || days < 0) return null;
  if (days > 0 && days < 1) return "不足 1 天";
  return `${days.toLocaleString("zh-TW", { maximumFractionDigits: 1 })} 天`;
}

export function inventoryFreshness({ calculatedAt, now = Date.now(), online = true, refreshError = "" }) {
  const timestamp = calculatedAt ? Date.parse(calculatedAt) : NaN;
  const valid = Number.isFinite(timestamp) && timestamp <= now + 60000;
  const stale = !online || Boolean(refreshError) || !valid || now - timestamp >= INVENTORY_FRESHNESS_MS;
  const reason = !online ? "目前離線" : refreshError ? "庫存更新失敗" : valid ? "庫存資料已過期" : "庫存計算時間待確認";
  const lastCalculated = valid ? new Date(timestamp).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }) : null;
  return { stale, lastCalculated, message: stale ? `${reason}；${lastCalculated ? `最後計算：${lastCalculated}（台灣時間）` : "尚無可靠計算時間"}，請更新確認。` : "" };
}
