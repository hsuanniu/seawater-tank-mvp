import { APPLICABLE_DOSE_KEYS } from "../modules/dosingModule.js";
import { PARAMETERS, targetSpan } from "../modules/tankModule.js";

export const CRITICAL_RANGES = {
  kh: { low: 7, high: 10 },
  ca: { low: 350, high: 450 },
  mg: { low: 1250, high: 1450 },
  k: { low: 350, high: 450 },
  no3: { low: 0, high: 10 },
  po4: { low: 0, high: 0.3 },
};

export const FAST_CHANGE_THRESHOLDS = {
  kh: 0.3,
  ca: 15,
  mg: 30,
  k: 15,
  no3: 1,
  po4: 0.05,
};

export const DOSING_LIMITS = {
  kh: { maxMlChange: 0.3, normalMaxMlChange: 0.2, percent: 0.05, normalPercent: 0.03 },
  ca: { maxMlChange: 0.5, normalMaxMlChange: 0.2, percent: 0.05, normalPercent: 0.03 },
  mg: { maxMlChange: 0.5, normalMaxMlChange: 0.2, percent: 0.05, normalPercent: 0.03 },
};

export function classify(value, target, key) {
  const critical = CRITICAL_RANGES[key] || null;
  if (critical && value <= critical.low) return { code: "CRITICAL_LOW", text: "嚴重偏低", className: "status-critical" };
  if (critical && value >= critical.high) return { code: "CRITICAL_HIGH", text: "嚴重偏高", className: "status-critical" };
  if (value < target.min) return { code: "LOW", text: "偏低", className: "status-low" };
  if (value > target.max) return { code: "HIGH", text: "偏高", className: "status-high" };
  return { code: "NORMAL", text: "正常", className: "status-normal" };
}

export function trend(current, previous, tolerance) {
  if (previous === null || previous === undefined) return "無上次資料";
  const delta = current - previous;
  if (Math.abs(delta) <= tolerance) return "持平";
  return delta > 0 ? "上升" : "下降";
}

function boundedDoseChange(parameter, currentDoseMlPerDay, direction, statusCode) {
  const limits = DOSING_LIMITS[parameter];
  if (!limits || !currentDoseMlPerDay || currentDoseMlPerDay <= 0) return 0;
  const isNormalFineTune = statusCode === "NORMAL";
  const percentLimit = currentDoseMlPerDay * (isNormalFineTune ? limits.normalPercent : limits.percent);
  const mlLimit = isNormalFineTune ? limits.normalMaxMlChange : limits.maxMlChange;
  return Number((direction * Math.min(percentLimit, mlLimit)).toFixed(1));
}

export function classifyTrendSpeed(parameter, dailyDelta) {
  if (dailyDelta === null || dailyDelta === undefined) return { tooFast: false, text: "尚無足夠資料" };
  const threshold = FAST_CHANGE_THRESHOLDS[parameter] || Infinity;
  return {
    tooFast: Math.abs(dailyDelta) > threshold,
    text: Math.abs(dailyDelta) > threshold ? "變化偏快" : "變化可接受",
  };
}

function confidenceFor({ hasPrevious, doseStatus, currentDoseMlPerDay, statusCode, trendTooFast }) {
  if (!hasPrevious || currentDoseMlPerDay <= 0 || !doseStatus.enabled || doseStatus.pausedDays > 0) return "INSUFFICIENT";
  if (statusCode === "CRITICAL_LOW" || statusCode === "CRITICAL_HIGH" || trendTooFast) return "INSUFFICIENT";
  if (statusCode === "NORMAL") return "MEDIUM";
  return "HIGH";
}

function observeOnlyResult({
  currentDoseMlPerDay,
  reasonCode,
  reasonText,
  safetyWarnings,
  confidenceLevel = "INSUFFICIENT",
  dailyDelta,
  speed,
}) {
  return {
    suggestedDoseMlPerDay: currentDoseMlPerDay,
    doseChangeMlPerDay: 0,
    action: "OBSERVE",
    reasonCode,
    reasonText,
    safetyWarnings,
    confidenceLevel,
    canApply: false,
    dailyDelta,
    trendTooFast: speed.tooFast,
    trendSpeedText: speed.text,
  };
}

export function calculateDosingRecommendation({
  parameter,
  currentValue,
  previousValue,
  targetRange,
  currentDoseMlPerDay,
  tankVolumeLiters,
  daysBetweenTests,
  doseStatus,
  statusCode,
  trendText,
}) {
  const param = PARAMETERS.find((item) => item.key === parameter);
  const dailyDelta = previousValue === null || daysBetweenTests === null ? null : (currentValue - previousValue) / daysBetweenTests;
  const speed = classifyTrendSpeed(parameter, dailyDelta);
  const safetyWarnings = [];
  const hasPrevious = previousValue !== null && daysBetweenTests !== null;

  if (!APPLICABLE_DOSE_KEYS.includes(parameter)) {
    return {
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      action: "OBSERVE",
      reasonCode: "NO_AUTO_DOSING_FOR_PARAMETER",
      reasonText: "此項目不提供自動滴定量建議，只做狀態與趨勢提醒。",
      safetyWarnings: ["NO3 / PO4 / 鉀(K) 不進行自動滴定建議，避免用藥或微量元素快速修正。"],
      confidenceLevel: "INSUFFICIENT",
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
    };
  }

  if (!Number.isFinite(tankVolumeLiters) || tankVolumeLiters <= 0) {
    safetyWarnings.push("魚缸水量未正確設定，本模型只做極保守滴定速率微調。");
  }
  if (parameter === "kh") safetyWarnings.push("請避免任何方式讓 KH 單日大幅變動；本工具不計算一次性補正量。");
  if (parameter === "ca") safetyWarnings.push("請避免一次性快速拉高 CA；本工具只建議每日滴定量小幅微調。");
  if (parameter === "mg") safetyWarnings.push("請避免一次性快速拉高 MG；本工具只建議每日滴定量小幅微調。");
  if (speed.tooFast) safetyWarnings.push("本次與上次相比變化偏快，請確認測試誤差、鹽度與滴定設備狀態。");

  const confidenceLevel = confidenceFor({
    hasPrevious,
    doseStatus,
    currentDoseMlPerDay,
    statusCode,
    trendTooFast: speed.tooFast,
  });

  if (!hasPrevious) {
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "NO_PREVIOUS_RECORD",
      reasonText: "缺少上一次測量紀錄，先建立基準，不套用滴定調整。",
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
    });
  }

  if (daysBetweenTests < 2) {
    safetyWarnings.push("兩次測量間隔少於 2 天，短期測試誤差可能大於真實消耗變化。");
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "TEST_INTERVAL_TOO_SHORT",
      reasonText: "兩次測量間隔太短，保守模式不產生新的滴定數字，建議至少間隔 2 天後再判斷趨勢。",
      safetyWarnings,
      dailyDelta,
      speed,
    });
  }

  if (!doseStatus.enabled) {
    return {
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      action: "DO_NOT_DOSE",
      reasonCode: "DOSER_DISABLED",
      reasonText: "目前滴定關閉中，先確認設備或手動恢復後再觀察。",
      safetyWarnings,
      confidenceLevel,
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
    };
  }

  if (doseStatus.pausedDays > 0) {
    return {
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      action: "RESUME_THEN_OBSERVE",
      reasonCode: "DOSING_PAUSED_THIS_WEEK",
      reasonText: `本週暫停 ${doseStatus.pausedDays} 天，數值變化可能受暫停影響，建議恢復原滴定量並觀察。`,
      safetyWarnings,
      confidenceLevel,
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
    };
  }

  if (!currentDoseMlPerDay || currentDoseMlPerDay <= 0) {
    safetyWarnings.push("目前沒有固定滴定量基準，系統不會替你建立起始劑量。");
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "ZERO_CURRENT_DOSE",
      reasonText: "尚未建立基礎滴定資料；請先輸入目前固定滴定量，系統才會開始計算微調建議。",
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
    });
  }

  if (statusCode === "CRITICAL_LOW" || statusCode === "CRITICAL_HIGH") {
    safetyWarnings.push("目前數值超出保守計算範圍，請先確認測試結果、鹽度與設備狀態。");
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "OUTSIDE_SAFE_CALCULATION_RANGE",
      reasonText: "目前數值超出安全計算範圍，保守模式不產生新的滴定數字。",
      safetyWarnings,
      dailyDelta,
      speed,
    });
  }

  let direction = 0;
  let action = "MAINTAIN";
  let reasonCode = "WITHIN_TARGET";
  let reasonText = "目前在目標範圍內，優先維持。";
  const lowerZone = targetRange.min + targetSpan(targetRange) * 0.25;
  const upperZone = targetRange.max - targetSpan(targetRange) * 0.25;

  if (statusCode === "CRITICAL_HIGH" || statusCode === "HIGH") {
    direction = -1;
    action = "DECREASE_SMALL";
    reasonCode = statusCode === "CRITICAL_HIGH" ? "CRITICAL_HIGH_REDUCE_ONLY" : "HIGH_REDUCE_ONLY";
    reasonText = `${param.label} 高於目標，硬性規則禁止增加滴定，只允許小幅降低或觀察。`;
  } else if (statusCode === "CRITICAL_LOW" || statusCode === "LOW") {
    direction = 1;
    action = "INCREASE_SMALL";
    reasonCode = statusCode === "CRITICAL_LOW" ? "CRITICAL_LOW_SMALL_INCREASE" : "LOW_SMALL_INCREASE";
    reasonText = `${param.label} 低於目標，僅允許小幅提高每日滴定量，不做一次性快速補正。`;
  } else if (statusCode === "NORMAL" && trendText === "下降" && currentValue <= lowerZone && !speed.tooFast) {
    direction = 1;
    action = "INCREASE_SMALL";
    reasonCode = "NORMAL_NEAR_LOW_TREND_DOWN";
    reasonText = `${param.label} 仍在目標內，但接近下緣且呈下降趨勢，只做最小幅微調。`;
  } else if (statusCode === "NORMAL" && trendText === "上升" && currentValue >= upperZone && !speed.tooFast) {
    direction = -1;
    action = "DECREASE_SMALL";
    reasonCode = "NORMAL_NEAR_HIGH_TREND_UP";
    reasonText = `${param.label} 仍在目標內，但接近上緣且呈上升趨勢，只做最小幅微調。`;
  }

  if (direction === 0 || speed.tooFast) {
    return {
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      action: speed.tooFast ? "OBSERVE" : action,
      reasonCode: speed.tooFast ? "TREND_TOO_FAST_VERIFY_FIRST" : reasonCode,
      reasonText: speed.tooFast ? "變化速度偏快，先確認測試與設備，不自動套用滴定調整。" : reasonText,
      safetyWarnings,
      confidenceLevel,
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
    };
  }

  const doseChangeMlPerDay = boundedDoseChange(parameter, currentDoseMlPerDay, direction, statusCode);
  const suggestedDoseMlPerDay = Number(Math.max(0, currentDoseMlPerDay + doseChangeMlPerDay).toFixed(1));
  return {
    suggestedDoseMlPerDay,
    doseChangeMlPerDay,
    action,
    reasonCode,
    reasonText,
    safetyWarnings,
    confidenceLevel,
    canApply: suggestedDoseMlPerDay !== currentDoseMlPerDay,
    dailyDelta,
    trendTooFast: speed.tooFast,
    trendSpeedText: speed.text,
  };
}
