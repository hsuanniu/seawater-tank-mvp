import { getDoseStatus } from "../modules/dosingModule.js";
import { daysBetweenRecords, latestRecords } from "../modules/measurementModule.js";
import { PARAMETERS } from "../modules/tankModule.js";
import { toNumber } from "../services/formatService.js";
import { calculateDosingRecommendation, classify, trend } from "./safetyEngine.js?v=20260520-safety-ux";

export function analyzeTank({ tank, records, dosing }) {
  const { latest, previous } = latestRecords(records);
  if (!latest) return null;
  const intervalDays = daysBetweenRecords(latest, previous);

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
      canApplyRecommendation: recommendation.canApply,
      dailyDelta: recommendation.dailyDelta,
      trendTooFast: recommendation.trendTooFast,
      trendSpeedText: recommendation.trendSpeedText,
    };
  });

  return {
    latest,
    previous,
    daysSincePrevious: intervalDays,
    rows,
  };
}
