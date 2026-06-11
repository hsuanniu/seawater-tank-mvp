import { getDoseStatus } from "../modules/dosingModule.js";
import { daysBetweenRecords, latestRecords } from "../modules/measurementModule.js";
import { PARAMETERS } from "../modules/tankModule.js";
import { toNumber } from "../services/formatService.js";
import { buildRecoveryContext, recoveryContextForElement } from "./eventRecoveryEngine.js";
import { buildObserveContext, buildStabilityContext } from "./stabilityEngine.js";
import { calculateDosingRecommendation, classify, trend } from "./safetyEngine.js?v=20260611-stable-lock";

export function analyzeTank({
  tank,
  records,
  dosing,
  events = [],
  maintenance = [],
  livestock = [],
}) {
  const { latest, previous } = latestRecords(records);
  if (!latest) return null;
  const intervalDays = daysBetweenRecords(latest, previous);
  const recoveryContext = buildRecoveryContext({
    events,
    latestDate: latest.date,
    records,
    targets: tank.targets,
  });
  const observeContext = buildObserveContext({
    latestDate: latest.date,
    tankVolumeLiters: toNumber(tank.volume),
    events,
    maintenance,
    livestock,
  });

  const rows = PARAMETERS.map((param) => {
    const value = toNumber(latest[param.key]);
    const previousValue = previous ? toNumber(previous[param.key]) : null;
    const flaggedAsCarried = latest.measuredFields ? latest.measuredFields[param.key] === false : false;
    const valueChangedFromPrevious = previous
      ? Math.abs(value - previousValue) > 0.000001
      : false;
    const isMeasured = flaggedAsCarried ? valueChangedFromPrevious : true;
    const target = tank.targets[param.key];
    const status = classify(value, target, param.key);
    const trendText = isMeasured ? trend(value, previousValue, param.tolerance) : "沿用上次";
    const currentDose = param.doseKey ? toNumber(dosing[param.doseKey]) : null;
    const doseStatus = param.doseKey ? getDoseStatus(dosing, param.doseKey) : null;
    const elementRecoveryContext = recoveryContextForElement(recoveryContext, param.key);
    const stabilityContext = buildStabilityContext({
      parameter: param.key,
      currentValue: value,
      previousValue,
      targetRange: target,
      daysBetweenTests: intervalDays,
      records,
    });
    let recommendation = calculateDosingRecommendation({
      parameter: param.key,
      currentValue: value,
      previousValue,
      targetRange: target,
      currentDoseMlPerDay: currentDose === null ? 0 : currentDose,
      tankVolumeLiters: toNumber(tank.volume),
      daysBetweenTests: intervalDays,
      doseStatus: doseStatus || { enabled: true, pausedDays: 0 },
      statusCode: status.code,
      trendText,
      recoveryContext: elementRecoveryContext,
      stabilityContext,
      observeContext,
    });
    if (!isMeasured) {
      recommendation = {
        ...recommendation,
        suggestedDoseMlPerDay: currentDose === null ? 0 : currentDose,
        doseChangeMlPerDay: 0,
        action: "OBSERVE",
        reasonCode: "VALUE_CARRIED_FORWARD",
        reasonText: "本項目這次未測量，沿用上一筆數值；不使用沿用值做滴定調整。",
        canApply: false,
        dailyDelta: null,
        confidenceLevel: "INSUFFICIENT",
        confidence_score: "low",
        event_recovery_mode: Boolean(elementRecoveryContext.event_recovery_mode),
        affected_element: elementRecoveryContext.affected_element || null,
        warning_message: elementRecoveryContext.event_recovery_mode
          ? "本項目這次未測量，且目前處於設備恢復期；不使用沿用值建立新趨勢。"
          : "",
      };
    }
    const isDosePaused = doseStatus ? !doseStatus.enabled || doseStatus.pausedDays > 0 : false;
    const newDose = recommendation.suggestedDoseMlPerDay;
    const doseChange = recommendation.doseChangeMlPerDay;
    const rate = currentDose ? doseChange / currentDose : 0;
    let action = "觀察";

    if (status.text === "正常") action = "維持";
    if (param.doseKey && param.key !== "k") {
      if (rate > 0) action = "增加";
      if (rate < 0) action = "減少";
      if (rate === 0) action = "維持";
    }

    if (param.key === "k") action = "觀察";
    if (param.key === "no3" || param.key === "po4") action = "觀察";
    if (isDosePaused) action = "觀察";

    return {
      ...param,
      value,
      previousValue,
      target,
      status,
      trendText,
      isMeasured,
      currentDose,
      newDose,
      doseChange,
      action,
      rate,
      doseStatus,
      isDosePaused,
      recommendationMode: recommendation.action,
      recommendationReason: recommendation.reasonText,
      reasonCode: recommendation.reasonCode,
      safetyWarnings: recommendation.safetyWarnings,
      confidenceLevel: recommendation.confidenceLevel,
      confidence_score: recommendation.confidence_score,
      canApplyRecommendation: recommendation.canApply,
      dailyDelta: recommendation.dailyDelta,
      trendTooFast: recommendation.trendTooFast,
      trendSpeedText: recommendation.trendSpeedText,
      recommended_dosing: recommendation.recommended_dosing,
      adjustment_percentage: recommendation.adjustment_percentage,
      event_recovery_mode: recommendation.event_recovery_mode,
      affected_element: recommendation.affected_element,
      warning_message: recommendation.warning_message,
      stableLock: stabilityContext.stableLock,
      withinDeadZone: stabilityContext.withinDeadZone,
      observe_mode: recommendation.observe_mode,
    };
  });

  return {
    latest,
    previous,
    daysSincePrevious: intervalDays,
    recoveryContext,
    observeContext,
    rows,
  };
}
