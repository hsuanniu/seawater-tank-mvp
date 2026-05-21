export function formatNumber(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Number(number.toFixed(decimals)).toString();
}

export function toNumber(value, fallback = 0) {
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : fallback;
}

export function targetToText(target) {
  if (!target) return "-";
  return `${formatNumber(target.min, 3)}-${formatNumber(target.max, 3)}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
