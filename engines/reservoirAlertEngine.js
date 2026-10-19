import { DEFAULT_RESERVOIR_ALERT_DAYS } from "../modules/reservoirModule.js";

export function validReservoirAlertDays(value) {
  return value && [value.reminderDays, value.warningDays, value.urgentDays].every((n) => typeof n === "number" && Number.isFinite(n))
    && value.reminderDays > value.warningDays && value.warningDays > value.urgentDays && value.urgentDays > 0;
}

export function evaluateReservoirAvailability({ remainingMl, bottomReserveMl = 0, effectiveMlPerDay,
  alertThresholds = DEFAULT_RESERVOIR_ALERT_DAYS, trackingActive = true, remainingIsUpperBound = false }) {
  const usableMl = Number.isFinite(remainingMl) && remainingMl >= 0 && Number.isFinite(bottomReserveMl) && bottomReserveMl >= 0
    ? Math.max(remainingMl - bottomReserveMl, 0) : null;
  const result = (alertStatus, alertLabel, alertReason, estimatedDaysRemaining = null) => ({
    usableMl, estimatedDaysRemaining, alertStatus, alertLabel, alertReason,
    requiresAlert: ["reminder", "warning", "urgent"].includes(alertStatus),
  });
  if (remainingMl === null || remainingMl === undefined) return result("pending_initialization", "待設定", "請先手動設定實際剩餘量，尚未填寫不代表空桶。");
  if (usableMl === null || !Number.isFinite(effectiveMlPerDay) || effectiveMlPerDay < 0 || !validReservoirAlertDays(alertThresholds)) {
    return result("unavailable", "無法估算／待設定", "有效每日滴定量、保留量或告警門檻缺失或無效，請確認設定。");
  }
  if (effectiveMlPerDay === 0) return result("not_dosing", "未滴定", "目前有效每日滴定量為 0，不產生可用天數告警。");
  if (remainingIsUpperBound) return result("needs_confirmation", "需確認", "有滴定時間資料缺口，庫存僅為上限，請人工確認後再估算天數。");
  if (!trackingActive) return result("tracking_disabled", "追蹤停用", "庫存追蹤已停用，請確認實際庫存後再啟用估算。");
  // Use the raw quotient at every boundary; rounding is presentation-only.
  const days = usableMl / effectiveMlPerDay;
  if (!Number.isFinite(days)) return result("unavailable", "無法估算／待設定", "可用天數超出可計算範圍，請確認每日滴定量。");
  if (days <= alertThresholds.urgentDays) return result("urgent", "緊急", usableMl === 0
    ? "可用液量已為 0，請儘快檢查或補液。" : "推估可用天數已達緊急門檻，請儘快補液。", days);
  if (days <= alertThresholds.warningDays) return result("warning", "警告", "推估可用天數已達警告門檻，請準備補液。", days);
  if (days <= alertThresholds.reminderDays) return result("reminder", "提醒", "請確認備品或安排採購。", days);
  return result("normal", "正常", "推估可用天數充足。", days);
}
