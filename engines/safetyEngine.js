import { APPLICABLE_DOSE_KEYS } from "../modules/dosingModule.js";
import { PARAMETERS, targetSpan } from "../modules/tankModule.js";

export const CRITICAL_RANGES = {
  kh: { low: 7, high: 10 },
  ca: { low: 350, high: 480 },
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

export const KH_DOSING_STABILITY_RULES = {
  targetMin: 8.0,
  targetMax: 9.0,
  stableTolerance: 0.2,
  significantDropThreshold: 0.3,
  mildIncrease: 0.3,
  minimumLowCountForAdjustment: 3,
  minimumObservationDaysAfterAdjustment: 7,
  priorityLowThreshold: 7.5,
};

export const RECOVERY_DOSING_LIMITS = {
  kh: { percent: 0.03 },
  ca: { percent: 0.02 },
  mg: { percent: 0.01 },
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

function boundedDoseChange(
  parameter,
  currentDoseMlPerDay,
  direction,
  statusCode,
  recoveryContext = {},
  tankVolumeLiters,
  observeContext = {},
  adjustmentProfile = "",
) {
  const limits = DOSING_LIMITS[parameter];
  if (!limits || !currentDoseMlPerDay || currentDoseMlPerDay <= 0) return 0;
  let baseLimit = 0;
  if (recoveryContext.event_recovery_mode) {
    const recoveryLimit = RECOVERY_DOSING_LIMITS[parameter];
    if (!recoveryLimit) return 0;
    baseLimit = currentDoseMlPerDay * recoveryLimit.percent;
  } else {
    const isNormalFineTune = statusCode === "NORMAL";
    if (adjustmentProfile === "KH_IN_RANGE_TREND_MICRO_ADJUST") {
      baseLimit = Math.min(Math.max(currentDoseMlPerDay * 0.05, 0.5), 0.8);
    } else {
      const percentLimit = currentDoseMlPerDay * (isNormalFineTune ? limits.normalPercent : limits.percent);
      const mlLimit = isNormalFineTune ? limits.normalMaxMlChange : limits.maxMlChange;
      baseLimit = Math.min(percentLimit, mlLimit);
    }
  }

  const nanoFactor = Number.isFinite(tankVolumeLiters) && tankVolumeLiters < 100 ? 0.5 : 1;
  const observeFactor = observeContext.observe_mode ? observeContext.adjustment_factor || 0.5 : 1;
  const conservativeLimit = Math.floor(baseLimit * nanoFactor * observeFactor * 10) / 10;
  return Number((direction * conservativeLimit).toFixed(1));
}

export function classifyTrendSpeed(parameter, dailyDelta) {
  if (dailyDelta === null || dailyDelta === undefined) return { tooFast: false, text: "尚無足夠資料" };
  const threshold = FAST_CHANGE_THRESHOLDS[parameter] || Infinity;
  return {
    tooFast: Math.abs(dailyDelta) > threshold,
    text: Math.abs(dailyDelta) > threshold ? "變化偏快" : "變化可接受",
  };
}

function confidenceFor({
  hasPrevious,
  doseStatus,
  currentDoseMlPerDay,
  statusCode,
  trendTooFast,
  recoveryContext,
  observeContext,
}) {
  if (!hasPrevious || currentDoseMlPerDay <= 0 || !doseStatus.enabled || doseStatus.pausedDays > 0) return "INSUFFICIENT";
  if (recoveryContext?.event_recovery_mode && trendTooFast) return "LOW";
  if (recoveryContext?.event_recovery_mode) return "MEDIUM";
  if (observeContext?.observe_mode) return "MEDIUM";
  if (statusCode === "CRITICAL_LOW" || statusCode === "CRITICAL_HIGH" || trendTooFast) return "INSUFFICIENT";
  if (statusCode === "NORMAL") return "MEDIUM";
  return "HIGH";
}

function confidenceScore(confidenceLevel) {
  if (confidenceLevel === "HIGH") return "high";
  if (confidenceLevel === "MEDIUM") return "medium";
  return "low";
}

function adjustmentPercentage(doseChangeMlPerDay, currentDoseMlPerDay) {
  if (!currentDoseMlPerDay || currentDoseMlPerDay <= 0) return 0;
  return Number(((doseChangeMlPerDay / currentDoseMlPerDay) * 100).toFixed(1));
}

function recoveryWarning(parameter) {
  const label = PARAMETERS.find((item) => item.key === parameter)?.label || parameter.toUpperCase();
  return `目前 ${label} 受設備事件恢復期影響，請勿把本週變化直接當成長期消耗趨勢。`;
}

function nutrientRecoveryReason(parameter, currentValue, previousValue, targetRange, trendText) {
  if (!["no3", "po4"].includes(parameter)) return null;
  if (previousValue === null || previousValue === undefined || trendText !== "上升") return null;
  const isSafe = currentValue >= targetRange.min && currentValue <= targetRange.max;
  if (!isSafe) return null;
  const label = parameter.toUpperCase();
  return {
    reasonCode: `${label}_RECOVERING_IN_SAFE_RANGE`,
    reasonText: `${label} 正在回升且仍在安全範圍，優先觀察，不要同時增加多種營養來源或使用激進藥劑。`,
    warning: `${label} 本週回升可能代表系統正在恢復，先持續記錄餵食、AB+、珊瑚糧與換水事件。`,
  };
}

function observeOnlyResult({
  currentDoseMlPerDay,
  reasonCode,
  reasonText,
  safetyWarnings,
  confidenceLevel = "INSUFFICIENT",
  dailyDelta,
  speed,
  recoveryContext = {},
  observeContext = {},
  warningMessage = "",
  autoCalculationPaused = false,
  action = "OBSERVE",
}) {
  return {
    suggestedDoseMlPerDay: currentDoseMlPerDay,
    doseChangeMlPerDay: 0,
    recommended_dosing: currentDoseMlPerDay,
    adjustment_percentage: 0,
    action,
    reasonCode,
    reasonText,
    reason: reasonText,
    safetyWarnings,
    confidenceLevel,
    confidence_score: confidenceScore(confidenceLevel),
    canApply: false,
    dailyDelta,
    trendTooFast: speed.tooFast,
    trendSpeedText: speed.text,
    event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
    observe_mode: Boolean(observeContext.observe_mode),
    affected_element: recoveryContext.affected_element || null,
    warning_message: warningMessage || (recoveryContext.event_recovery_mode ? recoveryWarning(recoveryContext.affected_element) : ""),
    autoCalculationPaused,
    suggestedDoseLabel: autoCalculationPaused ? "暫不自動計算" : "",
  };
}

function roundedDose(value) {
  return Number(Number(value).toFixed(1));
}

function khNextAdjustmentCondition({ currentValue, targetRange, consecutiveLowCount, daysSinceLastDoseAdjustment }) {
  const rules = KH_DOSING_STABILITY_RULES;
  if (currentValue >= targetRange.min) return "KH 若再次連續低於目標下限，才重新累積偏低趨勢。";
  if (!Number.isFinite(daysSinceLastDoseAdjustment)) {
    return `需要確認目前滴定量或上次調整後已維持至少 ${rules.minimumObservationDaysAfterAdjustment} 天，且 KH 連續第 ${rules.minimumLowCountForAdjustment} 次低於 ${targetRange.min}。`;
  }
  if (daysSinceLastDoseAdjustment < rules.minimumObservationDaysAfterAdjustment) {
    const remaining = rules.minimumObservationDaysAfterAdjustment - daysSinceLastDoseAdjustment;
    return `目前仍在調整後觀察期，距離可再次判斷還有 ${remaining} 天；觀察期內不得再次增加。`;
  }
  if (consecutiveLowCount < rules.minimumLowCountForAdjustment) {
    return `若下次量測仍低於 ${targetRange.min}，且目前滴定量已維持至少 ${rules.minimumObservationDaysAfterAdjustment} 天，再考慮小幅增加 ${rules.mildIncrease} ml。`;
  }
  return `KH 連續第 ${rules.minimumLowCountForAdjustment} 次低於 ${targetRange.min}，且目前滴定量或上次調整後已維持至少 ${rules.minimumObservationDaysAfterAdjustment} 天。`;
}

export function evaluateKhDosingStability({
  currentValue,
  previousValue,
  targetRange,
  currentDoseMlPerDay,
  consecutiveLowCount = 0,
  daysSinceLastDoseAdjustment = null,
  hasRecentDoseAdjustment = false,
  safetyWarnings = [],
  confidenceLevel = "HIGH",
  dailyDelta = null,
  speed = { tooFast: false, text: "尚無足夠資料" },
  recoveryContext = {},
  observeContext = {},
} = {}) {
  const rules = KH_DOSING_STABILITY_RULES;
  const lowCount = currentValue < targetRange.min ? Math.max(1, Number(consecutiveLowCount) || 1) : 0;
  const deltaFromPrevious = Number.isFinite(previousValue) ? currentValue - previousValue : null;
  const isStable = deltaFromPrevious !== null && Math.abs(deltaFromPrevious) <= rules.stableTolerance;
  const significantDrop = deltaFromPrevious !== null && previousValue - currentValue > rules.significantDropThreshold;
  const priorityLow = currentValue < rules.priorityLowThreshold;
  const hasObservationAge = Number.isFinite(daysSinceLastDoseAdjustment);
  const inObservationPeriod = hasObservationAge && daysSinceLastDoseAdjustment < rules.minimumObservationDaysAfterAdjustment;
  const doseHistoryInsufficient = !hasObservationAge && (hasRecentDoseAdjustment || lowCount >= rules.minimumLowCountForAdjustment || significantDrop || priorityLow);
  const base = {
    safetyWarnings,
    confidenceLevel,
    confidence_score: confidenceScore(confidenceLevel),
    dailyDelta,
    trendTooFast: speed.tooFast,
    trendSpeedText: speed.text,
    event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
    observe_mode: Boolean(observeContext.observe_mode),
    affected_element: recoveryContext.affected_element || null,
    warning_message: recoveryContext.event_recovery_mode ? recoveryWarning("kh") : "",
    khConsecutiveLowCount: lowCount,
    daysSinceLastDoseAdjustment: hasObservationAge ? daysSinceLastDoseAdjustment : null,
    observationDaysRemaining: inObservationPeriod ? rules.minimumObservationDaysAfterAdjustment - daysSinceLastDoseAdjustment : 0,
  };

  const observeResult = ({ reasonCode, reasonText, action = "OBSERVE", extraWarnings = [] }) => {
    const nextAdjustmentCondition = khNextAdjustmentCondition({
      currentValue,
      targetRange,
      consecutiveLowCount: lowCount,
      daysSinceLastDoseAdjustment,
    });
    return {
      ...base,
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      recommended_dosing: currentDoseMlPerDay,
      adjustment_percentage: 0,
      action,
      reasonCode,
      reasonText,
      reason: reasonText,
      canApply: false,
      nextAdjustmentCondition,
      khDosingStatus: action === "MAINTAIN" ? "維持" : action === "KH_PRIORITY" ? "優先處理" : "觀察",
      safetyWarnings: [...safetyWarnings, ...extraWarnings],
    };
  };

  if (currentValue >= targetRange.min && currentValue <= targetRange.max) {
    return observeResult({
      reasonCode: "KH_IN_TARGET_MAINTAIN",
      reasonText: "KH 已位於目標區間，目前滴定量可維持不變。",
      action: "MAINTAIN",
    });
  }

  if (currentValue >= targetRange.max) return null;

  if (inObservationPeriod) {
    return observeResult({
      reasonCode: priorityLow ? "KH_PRIORITY_LOW_OBSERVATION_PERIOD" : "KH_OBSERVATION_PERIOD_ACTIVE",
      reasonText: priorityLow
        ? "KH 已低於優先處理門檻，但上次調整後尚未滿 7 天，先確認量測與滴定設備，觀察期內不自動再次增加。"
        : "上次調整後尚未滿 7 天，仍在觀察期內；先維持目前滴定量，避免連續累加。",
      action: priorityLow ? "KH_PRIORITY" : "OBSERVE",
      extraWarnings: priorityLow ? ["KH 已低於優先處理門檻，請優先確認量測、滴定設備與缸內消耗狀況。"] : [],
    });
  }

  if (doseHistoryInsufficient) {
    return observeResult({
      reasonCode: priorityLow ? "KH_PRIORITY_LOW_HISTORY_INSUFFICIENT" : "KH_DOSE_HISTORY_INSUFFICIENT",
      reasonText: priorityLow
        ? "KH 已低於優先處理門檻，建議先確認量測與滴定設備；因缺少上次調整日期，不自動再次累加滴定量。"
        : "缺少目前滴定量已維持滿 7 天的佐證，先觀察，不在資訊不足時連續增加。",
      action: priorityLow ? "KH_PRIORITY" : "OBSERVE",
      extraWarnings: priorityLow ? ["KH 已低於優先處理門檻，建議採小幅、分段方式調整並縮短量測間隔。"] : [],
    });
  }

  if (priorityLow) {
    const doseChangeMlPerDay = Math.min(rules.mildIncrease, DOSING_LIMITS.kh.maxMlChange);
    const suggestedDoseMlPerDay = roundedDose(currentDoseMlPerDay + doseChangeMlPerDay);
    const reasonText = "KH 已低於優先處理門檻，建議先確認量測與滴定設備，並採小幅、分段方式調整，避免一次修正過多。";
    return {
      ...base,
      suggestedDoseMlPerDay,
      doseChangeMlPerDay,
      recommended_dosing: suggestedDoseMlPerDay,
      adjustment_percentage: adjustmentPercentage(doseChangeMlPerDay, currentDoseMlPerDay),
      action: "KH_PRIORITY",
      reasonCode: "KH_PRIORITY_LOW_SMALL_INCREASE",
      reasonText,
      reason: reasonText,
      canApply: suggestedDoseMlPerDay !== currentDoseMlPerDay,
      nextAdjustmentCondition: `調整後重新開始至少 ${rules.minimumObservationDaysAfterAdjustment} 天觀察期，期間不得再次增加。`,
      khDosingStatus: "優先處理",
      safetyWarnings: [...safetyWarnings, "KH 已低於優先處理門檻，請優先確認量測、滴定設備與缸內消耗狀況。"],
    };
  }

  if (significantDrop) {
    const doseChangeMlPerDay = Math.min(rules.mildIncrease, DOSING_LIMITS.kh.maxMlChange);
    const suggestedDoseMlPerDay = roundedDose(currentDoseMlPerDay + doseChangeMlPerDay);
    const reasonText = "KH 較上次明顯下降，建議小幅增加滴定量並密切觀察，單次調整不超過 0.3 ml。";
    return {
      ...base,
      suggestedDoseMlPerDay,
      doseChangeMlPerDay,
      recommended_dosing: suggestedDoseMlPerDay,
      adjustment_percentage: adjustmentPercentage(doseChangeMlPerDay, currentDoseMlPerDay),
      action: "INCREASE_SMALL",
      reasonCode: "KH_SIGNIFICANT_DROP_SMALL_INCREASE",
      reasonText,
      reason: reasonText,
      canApply: suggestedDoseMlPerDay !== currentDoseMlPerDay,
      nextAdjustmentCondition: `調整後重新開始至少 ${rules.minimumObservationDaysAfterAdjustment} 天觀察期，期間不得再次增加。`,
      khDosingStatus: "小幅增加",
    };
  }

  if (lowCount >= rules.minimumLowCountForAdjustment && !isStable) {
    return observeResult({
      reasonCode: "KH_LOW_UNSTABLE_VERIFY_FIRST",
      reasonText: "KH 已連續偏低但短期波動仍需確認，先維持目前滴定量，避免因測量誤差造成過度修正。",
    });
  }

  if (lowCount >= rules.minimumLowCountForAdjustment) {
    const doseChangeMlPerDay = Math.min(rules.mildIncrease, DOSING_LIMITS.kh.maxMlChange);
    const suggestedDoseMlPerDay = roundedDose(currentDoseMlPerDay + doseChangeMlPerDay);
    const reasonText = "KH 已連續多次低於目標，且目前滴定量未能使數值回升，因此進行小幅調整。";
    return {
      ...base,
      suggestedDoseMlPerDay,
      doseChangeMlPerDay,
      recommended_dosing: suggestedDoseMlPerDay,
      adjustment_percentage: adjustmentPercentage(doseChangeMlPerDay, currentDoseMlPerDay),
      action: "INCREASE_SMALL",
      reasonCode: "KH_CONSECUTIVE_LOW_SMALL_INCREASE",
      reasonText,
      reason: reasonText,
      canApply: suggestedDoseMlPerDay !== currentDoseMlPerDay,
      nextAdjustmentCondition: `調整後重新開始至少 ${rules.minimumObservationDaysAfterAdjustment} 天觀察期，期間不得再次增加。`,
      khDosingStatus: "小幅增加",
    };
  }

  return observeResult({
    reasonCode: "KH_LOW_STABLE_OBSERVE",
    reasonText: "KH 略低但趨勢穩定，先觀察，避免因單次測量或頻繁調整造成波動。",
  });
}

function isConsecutiveHighRising(currentValue, previousValue, targetRange) {
  return Number.isFinite(previousValue)
    && previousValue > targetRange.max
    && currentValue > targetRange.max
    && currentValue > previousValue;
}

function highRangeReason({ parameter, currentValue, previousValue, targetRange, statusCode }) {
  const label = PARAMETERS.find((item) => item.key === parameter)?.label || parameter.toUpperCase();
  const consecutiveHighRising = isConsecutiveHighRising(currentValue, previousValue, targetRange);
  if (statusCode === "CRITICAL_HIGH") {
    if (parameter === "mg") {
      return {
        reasonCode: consecutiveHighRising ? "MG_CRITICAL_HIGH_RISING_MANUAL_CONFIRM" : "MG_OBSERVATION_RANGE_EXCEEDED",
        reasonText: consecutiveHighRising
          ? "Mg 偏高且持續上升，請考慮手動降低或暫停 Mg 滴定。"
          : "Mg 超出觀察範圍，暫不自動計算；請先人工確認測量值、鹽度與滴定狀態。",
        action: consecutiveHighRising ? "CONSIDER_REDUCE" : "MANUAL_CONFIRM",
        warning: "目前滴定量僅供參考，不代表最佳建議。",
      };
    }
    return {
      reasonCode: consecutiveHighRising ? "CRITICAL_HIGH_RISING_MANUAL_CONFIRM" : "OUTSIDE_SAFE_CALCULATION_RANGE",
      reasonText: consecutiveHighRising
        ? `${label} 連續偏高且上升，建議人工確認後再考慮降低或暫停滴定。`
        : `${label} 超出安全計算範圍，暫不自動計算；請先人工確認測量值與設備狀態。`,
      action: consecutiveHighRising ? "CONSIDER_REDUCE" : "MANUAL_CONFIRM",
      warning: "目前滴定量僅供參考，不代表最佳建議。",
    };
  }
  if (consecutiveHighRising) {
    return {
      reasonCode: "CONSECUTIVE_HIGH_RISING_MANUAL_CONFIRM",
      reasonText: `${label} 連續偏高且上升，建議考慮降低或暫停滴定，但不要因單次數值做激進調整。`,
      action: "CONSIDER_REDUCE",
      warning: "連續偏高且上升，請先確認測試誤差、鹽度與滴定設備狀態。",
    };
  }
  return {
    reasonCode: "SINGLE_HIGH_OBSERVE",
    reasonText: `${label} 單次偏高，建議先觀察，不急著調整。`,
    action: "OBSERVE",
    warning: "目前滴定量僅供參考，不代表最佳建議。",
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
  recoveryContext = {},
  stabilityContext = {},
  observeContext = {},
  daysSinceLastDoseAdjustment = null,
  hasRecentDoseAdjustment = false,
}) {
  const param = PARAMETERS.find((item) => item.key === parameter);
  const dailyDelta = previousValue === null || daysBetweenTests === null ? null : (currentValue - previousValue) / daysBetweenTests;
  const speed = classifyTrendSpeed(parameter, dailyDelta);
  const safetyWarnings = [];
  const hasPrevious = previousValue !== null && daysBetweenTests !== null;

  if (!APPLICABLE_DOSE_KEYS.includes(parameter)) {
    const nutrientReason = nutrientRecoveryReason(parameter, currentValue, previousValue, targetRange, trendText);
    const stableReason = stabilityContext.inStabilityRange && stabilityContext.withinDeadZone
      ? `${param.label} 位於建議範圍內，且變化落在測量誤差容忍區，維持目前管理方式。`
      : "";
    return {
      suggestedDoseMlPerDay: currentDoseMlPerDay,
      doseChangeMlPerDay: 0,
      recommended_dosing: currentDoseMlPerDay,
      adjustment_percentage: 0,
      action: "OBSERVE",
      reasonCode: nutrientReason?.reasonCode || (stableReason ? "STABLE_IN_RANGE" : "NO_AUTO_DOSING_FOR_PARAMETER"),
      reasonText: nutrientReason?.reasonText || stableReason || "此項目不提供自動滴定量建議，只做狀態與趨勢提醒。",
      reason: nutrientReason?.reasonText || stableReason || "此項目不提供自動滴定量建議，只做狀態與趨勢提醒。",
      safetyWarnings: [
        "NO3 / PO4 / 鉀(K) 不進行自動滴定建議，避免用藥或微量元素快速修正。",
        ...(nutrientReason?.warning ? [nutrientReason.warning] : []),
      ],
      confidenceLevel: "INSUFFICIENT",
      confidence_score: "low",
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
      event_recovery_mode: false,
      observe_mode: Boolean(observeContext.observe_mode),
      affected_element: null,
      warning_message: nutrientReason?.warning || "",
    };
  }

  if (!Number.isFinite(tankVolumeLiters) || tankVolumeLiters <= 0) {
    safetyWarnings.push("魚缸水量未正確設定，本模型只做極保守滴定速率微調。");
  }
  if (parameter === "kh") safetyWarnings.push("請避免任何方式讓 KH 單日大幅變動；本工具不計算一次性補正量。");
  if (parameter === "ca") safetyWarnings.push("請避免一次性快速拉高 CA；本工具只建議每日滴定量小幅微調。");
  if (parameter === "mg") safetyWarnings.push("請避免一次性快速拉高 MG；本工具只建議每日滴定量小幅微調。");
  if (speed.tooFast) safetyWarnings.push("本次與上次相比變化偏快，請確認測試誤差、鹽度與滴定設備狀態。");
  if (recoveryContext.event_recovery_mode) {
    safetyWarnings.push(recoveryWarning(parameter));
  }
  if (observeContext.observe_mode) {
    safetyWarnings.push(`近 7 天有影響判讀的事件：${observeContext.reasons.join("、")}。本次只允許更保守的微調或觀察。`);
  }
  if (Number.isFinite(tankVolumeLiters) && tankVolumeLiters < 100) {
    safetyWarnings.push("目前為 100L 以下小缸，滴定調整幅度已套用 0.5 保守係數。");
  }

  const confidenceLevel = confidenceFor({
    hasPrevious,
    doseStatus,
    currentDoseMlPerDay,
    statusCode,
    trendTooFast: speed.tooFast,
    recoveryContext,
    observeContext,
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
      recoveryContext,
      observeContext,
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
      recoveryContext,
      observeContext,
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
      confidence_score: confidenceScore(confidenceLevel),
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
      recommended_dosing: currentDoseMlPerDay,
      adjustment_percentage: 0,
      reason: "目前滴定關閉中，先確認設備或手動恢復後再觀察。",
      event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
      affected_element: recoveryContext.affected_element || null,
      warning_message: recoveryContext.event_recovery_mode ? recoveryWarning(parameter) : "",
      observe_mode: Boolean(observeContext.observe_mode),
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
      confidence_score: confidenceScore(confidenceLevel),
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
      recommended_dosing: currentDoseMlPerDay,
      adjustment_percentage: 0,
      reason: `本週暫停 ${doseStatus.pausedDays} 天，數值變化可能受暫停影響，建議恢復原滴定量並觀察。`,
      event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
      affected_element: recoveryContext.affected_element || null,
      warning_message: recoveryContext.event_recovery_mode ? recoveryWarning(parameter) : "",
      observe_mode: Boolean(observeContext.observe_mode),
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
      recoveryContext,
      observeContext,
    });
  }

  if (parameter === "kh") {
    const khConsecutiveLowCount = Number.isFinite(Number(stabilityContext.consecutiveLowCount))
      ? Number(stabilityContext.consecutiveLowCount)
      : stabilityContext.consecutiveOutOfRange;
    const khRecommendation = evaluateKhDosingStability({
      currentValue,
      previousValue,
      targetRange,
      currentDoseMlPerDay,
      consecutiveLowCount: khConsecutiveLowCount,
      daysSinceLastDoseAdjustment,
      hasRecentDoseAdjustment,
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
    });
    if (khRecommendation) return khRecommendation;
  }

  if (statusCode === "CRITICAL_HIGH") {
    const highReason = highRangeReason({ parameter, currentValue, previousValue, targetRange, statusCode });
    safetyWarnings.push(highReason.warning);
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: highReason.reasonCode,
      reasonText: highReason.reasonText,
      safetyWarnings,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
      autoCalculationPaused: true,
      action: highReason.action,
      warningMessage: highReason.warning,
    });
  }

  if (statusCode === "CRITICAL_LOW") {
    safetyWarnings.push("目前數值超出保守計算範圍，請先確認測試結果、鹽度與設備狀態。");
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "OUTSIDE_SAFE_CALCULATION_RANGE",
      reasonText: "目前數值超出安全計算範圍，暫不自動計算；請先人工確認測量值、鹽度與設備狀態。",
      safetyWarnings,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
      autoCalculationPaused: true,
      action: "MANUAL_CONFIRM",
      warningMessage: "目前滴定量僅供參考，不代表最佳建議。",
    });
  }

  if (
    stabilityContext.stableLock
    || (
      stabilityContext.withinDeadZone
      && (stabilityContext.inTargetRange || !stabilityContext.hasConfirmedOutOfRange)
    )
  ) {
    const stableLockActive = stabilityContext.stableLock;
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: stableLockActive ? "STABLE_LOCK_MAINTAIN" : "DEAD_ZONE_MAINTAIN",
      reasonText: stableLockActive
        ? `${param.label} 與前次差異落在測量誤差內，且間隔至少 5 天；穩定鎖定優先，維持目前滴定量。`
        : `${param.label} 與前次差異落在測量誤差容忍區，先維持目前滴定量，不追逐單次目標數字。`,
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
    });
  }

  if (statusCode === "HIGH") {
    const highReason = highRangeReason({ parameter, currentValue, previousValue, targetRange, statusCode });
    safetyWarnings.push(highReason.warning);
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: highReason.reasonCode,
      reasonText: highReason.reasonText,
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
      autoCalculationPaused: true,
      action: highReason.action,
      warningMessage: highReason.warning,
    });
  }

  if (
    statusCode !== "NORMAL"
    && ["ca", "mg"].includes(parameter)
    && !stabilityContext.hasConfirmedOutOfRange
  ) {
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: `${parameter.toUpperCase()}_WAIT_FOR_CONFIRMED_DEVIATION`,
      reasonText: `${param.label} 尚未連續 ${stabilityContext.requiredOutOfRangeSamples} 次偏離建議範圍，先維持並確認趨勢，不因單次數值調整。`,
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
    });
  }

  let direction = 0;
  let action = "MAINTAIN";
  let reasonCode = "WITHIN_TARGET";
  let reasonText = "目前在目標範圍內，優先維持。";
  const lowerZone = targetRange.min + targetSpan(targetRange) * 0.25;
  const upperZone = targetRange.max - targetSpan(targetRange) * 0.25;
  const khDropFromPrevious = previousValue - currentValue;
  const khInRangeTrendMicroAdjust = Boolean(
    parameter === "kh"
    && statusCode === "NORMAL"
    && daysBetweenTests >= 5
    && !speed.tooFast
    && (
      khDropFromPrevious >= 0.4
      || (
        stabilityContext.consecutiveDrops >= 2
        && stabilityContext.consecutiveDropTotal >= 0.4
        && stabilityContext.consecutiveDropDays >= 5
      )
    )
  );

  if (statusCode === "CRITICAL_HIGH" || statusCode === "HIGH") {
    direction = -1;
    action = "DECREASE_SMALL";
    reasonCode = statusCode === "CRITICAL_HIGH" ? "CRITICAL_HIGH_REDUCE_ONLY" : "HIGH_REDUCE_ONLY";
    reasonText = `${param.label} 高於目標，硬性規則禁止增加滴定，只允許小幅降低或觀察。`;
    if (recoveryContext.event_recovery_mode && parameter === "ca") {
      reasonCode = "CA_RECOVERY_RISE_SMALL_REDUCE";
      reasonText = "CA 設備事件剛修復，快速上升可能是滴定恢復準確造成的短期補償，不作為長期過量判斷，只允許小幅降低或觀察。";
    }
  } else if (statusCode === "CRITICAL_LOW" || statusCode === "LOW") {
    direction = 1;
    action = "INCREASE_SMALL";
    reasonCode = statusCode === "CRITICAL_LOW" ? "CRITICAL_LOW_SMALL_INCREASE" : "LOW_SMALL_INCREASE";
    reasonText = `${param.label} 低於目標，僅允許小幅提高每日滴定量，不做一次性快速補正。`;
    if (parameter === "kh" && trendText === "上升") {
      direction = 0;
      action = "OBSERVE";
      reasonCode = "KH_LOW_BUT_RISING_OBSERVE";
      reasonText = "KH 雖低於目標但正在上升，先觀察趨勢是否回到目標，避免連續過度補償。";
    }
    if (parameter === "mg") {
      direction = 0;
      action = "OBSERVE";
      reasonCode = "MG_LOW_OBSERVE_FIRST";
      reasonText = "MG 變化通常較慢，除非連續明顯低於目標，否則優先維持與觀察。";
    }
  } else if (khInRangeTrendMicroAdjust) {
    direction = 1;
    action = "MICRO_ADJUST";
    reasonCode = "KH_IN_RANGE_TREND_MICRO_ADJUST";
    reasonText = "KH仍位於目標範圍，但消耗量略高於目前滴定量，建議小幅提高滴定以維持穩定。";
  } else if (statusCode === "NORMAL" && trendText === "下降" && currentValue <= lowerZone && !speed.tooFast) {
    direction = 1;
    action = "INCREASE_SMALL";
    reasonCode = "NORMAL_NEAR_LOW_TREND_DOWN";
    reasonText = `${param.label} 仍在目標內，但接近下緣且呈下降趨勢，只做最小幅微調。`;
    if (parameter === "mg") {
      direction = 0;
      action = "MAINTAIN";
      reasonCode = "MG_NORMAL_OBSERVE";
      reasonText = "MG 在目標範圍內，且 MG 變化通常較慢，優先維持與觀察。";
    }
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
      reason: speed.tooFast ? "變化速度偏快，先確認測試與設備，不自動套用滴定調整。" : reasonText,
      safetyWarnings,
      confidenceLevel,
      confidence_score: confidenceScore(confidenceLevel),
      canApply: false,
      dailyDelta,
      trendTooFast: speed.tooFast,
      trendSpeedText: speed.text,
      recommended_dosing: currentDoseMlPerDay,
      adjustment_percentage: 0,
      event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
      affected_element: recoveryContext.affected_element || null,
      warning_message: recoveryContext.event_recovery_mode ? recoveryWarning(parameter) : "",
      observe_mode: Boolean(observeContext.observe_mode),
    };
  }

  const boundedChangeMlPerDay = boundedDoseChange(
    parameter,
    currentDoseMlPerDay,
    direction,
    statusCode,
    recoveryContext,
    tankVolumeLiters,
    observeContext,
    khInRangeTrendMicroAdjust ? "KH_IN_RANGE_TREND_MICRO_ADJUST" : "",
  );
  const doseChangeMlPerDay = boundedChangeMlPerDay;
  if (doseChangeMlPerDay === 0) {
    return observeOnlyResult({
      currentDoseMlPerDay,
      reasonCode: "CONSERVATIVE_LIMIT_BELOW_MINIMUM_STEP",
      reasonText: `${param.label} 雖有偏離，但套用小缸或事件保守係數後低於最小 0.1 ml/day 調整刻度，先維持觀察。`,
      safetyWarnings,
      confidenceLevel,
      dailyDelta,
      speed,
      recoveryContext,
      observeContext,
    });
  }
  const suggestedDoseMlPerDay = Number(Math.max(0, currentDoseMlPerDay + doseChangeMlPerDay).toFixed(1));
  const percent = adjustmentPercentage(doseChangeMlPerDay, currentDoseMlPerDay);
  let finalReasonText = reasonText;
  if (recoveryContext.event_recovery_mode) {
    finalReasonText = `${reasonText} 目前處於設備恢復期，先建立 temporary baseline，至少觀察 2-3 次正常測量後再恢復完整演算法。`;
  }
  return {
    suggestedDoseMlPerDay,
    doseChangeMlPerDay,
    recommended_dosing: suggestedDoseMlPerDay,
    adjustment_percentage: percent,
    action,
    reasonCode,
    reasonText: finalReasonText,
    reason: finalReasonText,
    safetyWarnings,
    confidenceLevel,
    confidence_score: confidenceScore(confidenceLevel),
    canApply: suggestedDoseMlPerDay !== currentDoseMlPerDay,
    dailyDelta,
    trendTooFast: speed.tooFast,
    trendSpeedText: speed.text,
    event_recovery_mode: Boolean(recoveryContext.event_recovery_mode),
    observe_mode: Boolean(observeContext.observe_mode),
    affected_element: recoveryContext.affected_element || null,
    warning_message: recoveryContext.event_recovery_mode ? recoveryWarning(parameter) : "",
  };
}
