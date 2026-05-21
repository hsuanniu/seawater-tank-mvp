import { formatNumber } from "../services/formatService.js";

export function statusRank(row) {
  if (row.status.text === "偏高") return 3;
  if (row.status.text === "偏低") return 2;
  return 1;
}

export function primaryFocus(analysis) {
  if (!analysis) return null;
  const actionable = analysis.rows
    .filter((row) => row.status.text !== "正常")
    .sort((a, b) => statusRank(b) - statusRank(a));
  return actionable[0] || analysis.rows.find((row) => row.key === "kh") || analysis.rows[0];
}

export function actionText(action) {
  const labels = {
    MAINTAIN: "維持",
    INCREASE_SMALL: "小幅增加",
    DECREASE_SMALL: "小幅減少",
    OBSERVE: "觀察",
    RESUME_THEN_OBSERVE: "恢復後觀察",
    DO_NOT_DOSE: "先不調整",
  };
  return labels[action] || "觀察";
}

export function confidenceText(level) {
  const labels = { HIGH: "高", MEDIUM: "中", LOW: "資料不足", INSUFFICIENT: "資料不足" };
  return labels[level] || "資料不足";
}

export function changeText(row) {
  if (row.isMeasured === false) return "沿用上次";
  if (row.previousValue === null || row.previousValue === undefined) return "尚無上次資料";
  const decimals = row.key === "po4" ? 3 : row.key === "kh" || row.key === "no3" ? 2 : 1;
  const delta = row.value - row.previousValue;
  const sign = delta > 0 ? "+" : "";
  return `${row.trendText} ${sign}${formatNumber(delta, decimals)} ${row.unit}`;
}

export function dailyDeltaText(row) {
  if (row.dailyDelta === null || row.dailyDelta === undefined) return "每日變化：尚無足夠資料";
  const decimals = row.key === "kh" ? 2 : row.key === "po4" ? 3 : row.key === "no3" ? 2 : 1;
  const value = formatNumber(row.dailyDelta, decimals);
  return `每日變化：約 ${value} ${row.unit}/day`;
}

export function formatDoseSentence(row, doseStatusText) {
  if (row.isMeasured === false) return `${row.label} 這次未測量，沿用上一筆數值，建議先觀察不調整。`;
  if (row.reasonCode === "ZERO_CURRENT_DOSE") return `尚未建立 ${row.label} 滴定基準，請先輸入目前固定滴定量。`;
  if (row.recommendationMode === "DO_NOT_DOSE") return `${row.label} 滴定${doseStatusText(row.doseKey)}，先確認設備狀態，不自動放大補量。`;
  if (row.recommendationMode === "RESUME_THEN_OBSERVE") return `${row.label} ${doseStatusText(row.doseKey)}，建議恢復原本 ${formatNumber(row.currentDose)} ml/day 後觀察。`;
  if (row.rate === 0) return `${row.label} 目前建議維持 ${formatNumber(row.currentDose)} ml/day。`;
  return `${row.label} 建議由 ${formatNumber(row.currentDose)} 調整為 ${formatNumber(row.newDose)} ml/day。`;
}

export function doseSuggestionText(row, doseStatusText) {
  const current = `${formatNumber(row.currentDose)} ml/day`;
  const status = doseStatusText(row.doseKey);
  if (row.reasonCode === "ZERO_CURRENT_DOSE") return `尚未建立 ${row.label} 滴定基準`;
  if (row.isMeasured === false) return `目前 ${current}，本次未測量，建議維持觀察`;
  if (row.recommendationMode === "DO_NOT_DOSE") return `目前 ${current}，${status}，建議先確認設備或手動恢復後再測一次`;
  if (row.recommendationMode === "RESUME_THEN_OBSERVE") return `目前 ${current}，${status}，建議恢復原本滴定量並觀察`;
  if (row.rate === 0) return `目前 ${current}，建議維持`;
  return `目前 ${current}，建議調整為 ${formatNumber(row.newDose)} ml/day`;
}
