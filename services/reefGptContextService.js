import { analyzeTank } from "../engines/analysisEngine.js";
import { DEFAULT_DOSING, getDoseStatus } from "../modules/dosingModule.js";
import { getSortedRecords } from "../modules/measurementModule.js";
import { DEFAULT_TANK, PARAMETERS } from "../modules/tankModule.js";
import { splitActiveAndArchivedRecords } from "./retentionService.js";

export const GPT_DATA_POLICY = {
  readOnly: true,
  dosingSource: "existing_safety_engine",
  requiresManualConfirmation: true,
  inheritedValuesCanAdjustDosing: false,
  nutrientDosingAllowed: false,
  canControlEquipment: false,
  inventoryCanChangeDosing: false,
  mustReportReservoirWarnings: true,
  nullRecommendationMeansNoAutomaticCalculation: true,
};

function taipeiDate(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function recordDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T00:00:00+08:00`)
    : new Date(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function measurementData(record) {
  if (!record) return null;
  return {
    id: record.id || null,
    date: record.date,
    values: Object.fromEntries(PARAMETERS.map(({ key }) => [key, numberOrNull(record[key])])),
    measuredFields: Object.fromEntries(PARAMETERS.map(({ key }) => [key, record.measuredFields?.[key] !== false])),
    salinity: numberOrNull(record.salinity),
    temperature: numberOrNull(record.temperature),
    note: String(record.note || ""),
  };
}

function ownedTanks(state) {
  if (Array.isArray(state?.tanks)) return state.tanks;
  if (state?.tank) return [{ ...state, id: state.activeTankId || "legacy-tank" }];
  throw new Error("INVALID_CLOUD_STATE");
}

export function listReefGptTanks(state) {
  return ownedTanks(state).map((item) => ({
    id: item.id,
    name: item.tank?.name || DEFAULT_TANK.name,
    volumeLiters: numberOrNull(item.tank?.volume),
    isActive: item.id === state.activeTankId,
  }));
}

function recentEntries(entries = [], dateKey, now, fields) {
  const end = now.getTime();
  const start = end - 14 * 86400000;
  return entries
    .filter((item) => {
      const date = Array.isArray(dateKey) ? dateKey.map((key) => item[key]).find(Boolean) : item[dateKey];
      const time = recordDate(date).getTime();
      return time >= start && time <= end;
    })
    .sort((a, b) => {
      const value = (item) => Array.isArray(dateKey) ? dateKey.map((key) => item[key]).find(Boolean) : item[dateKey];
      return recordDate(value(b)) - recordDate(value(a));
    })
    .slice(0, 30)
    .map((item) => Object.fromEntries(fields.filter((key) => item[key] !== undefined).map((key) => [key, item[key]])));
}

export function buildReefGptContext({ state, tankId, cloudUpdatedAt = null, reservoirs = [], inventoryCalculatedAt = null, now = new Date() }) {
  const tanks = ownedTanks(state);
  const data = tankId
    ? tanks.find((item) => item.id === tankId)
    : tanks.find((item) => item.id === state.activeTankId) || tanks[0];
  if (!data) return null;
  const tank = {
    ...DEFAULT_TANK,
    ...data.tank,
    targets: { ...DEFAULT_TANK.targets, ...data.tank?.targets },
  };
  const dosing = { ...DEFAULT_DOSING, ...data.dosing, status: { ...DEFAULT_DOSING.status, ...data.dosing?.status } };
  const asOfDate = taipeiDate(now);
  const { activeRecords } = splitActiveAndArchivedRecords({
    activeRecords: Array.isArray(data.records) ? data.records : [],
    anchorDate: new Date(`${asOfDate}T12:00:00Z`),
  });
  const records = getSortedRecords(activeRecords).filter((record) => recordDate(record.date) <= now);
  const latest = records.at(-1) || null;
  const previous = records.at(-2) || null;
  const analysis = analyzeTank({
    tank, records, dosing,
    events: data.events || [],
    maintenance: data.maintenance || [],
    livestock: data.livestock || [],
    doseApplications: data.doseApplications || [],
  });
  const measurementAgeDays = latest ? Math.max(0, Math.floor((recordDate(asOfDate) - recordDate(latest.date)) / 86400000)) : null;
  const stale = measurementAgeDays === null || measurementAgeDays > 14;
  const recommendations = (analysis?.rows || []).map((row) => {
    // Respect the stored provenance even if a carried value differs from the preceding record.
    const inherited = latest.measuredFields?.[row.key] === false;
    const baselineInherited = previous?.measuredFields?.[row.key] === false;
    const missing = numberOrNull(latest[row.key]) === null || numberOrNull(previous?.[row.key]) === null;
    const applicable = ["kh", "ca", "mg"].includes(row.key);
    const alreadyApplied = Boolean(latest.id) && (data.doseApplications || []).some((entry) =>
      entry.parameter === row.key && (entry.relatedMeasurementId || entry.recordId) === latest.id);
    const canAdjust = applicable && row.canApplyRecommendation && !inherited && !baselineInherited && !missing && !stale && !alreadyApplied;
    const warnings = [...(row.safetyWarnings || [])];
    if (stale) warnings.push("測量已超過 14 天或沒有近期測量，請先重新測量。");
    if (alreadyApplied) warnings.push("這次測量的滴定建議已經套用，請勿重複加減量。");
    const reason = inherited
      ? "本次沿用上一筆數值，不參與滴定調整。"
      : baselineInherited ? "上次數值為沿用，不能用這兩筆紀錄建立滴定微調基準。"
      : missing ? "缺少本次或上次測量，請先建立基準。"
        : alreadyApplied ? "這次測量的滴定建議已套用，等待新測量。" : row.recommendationReason;
    return {
      parameter: row.key,
      label: row.label,
      unit: row.unit,
      currentValue: numberOrNull(latest[row.key]),
      previousValue: numberOrNull(previous?.[row.key]),
      measured: !inherited,
      targetRange: row.target,
      status: row.status.text,
      trend: inherited ? "沿用上一筆" : row.trendText,
      currentDoseMlPerDay: row.currentDose,
      suggestedDoseMlPerDay: canAdjust ? row.newDose : null,
      doseChangeMlPerDay: canAdjust ? row.doseChange : 0,
      adjustmentPercentage: canAdjust ? row.adjustment_percentage : 0,
      canAdjust,
      action: canAdjust ? row.action : "觀察／確認是否維持",
      reason,
      safetyWarnings: warnings,
      confidence: inherited || baselineInherited || missing || stale || alreadyApplied ? "low" : row.confidence_score,
      recoveryMode: Boolean(row.event_recovery_mode),
      observeMode: Boolean(row.observe_mode),
      autoCalculationPaused: Boolean(row.autoCalculationPaused),
    };
  });
  const inventory = reservoirs.filter((r) => r.tankId === data.id).map((r) => {
    const recommendation = recommendations.find((entry) => entry.parameter === r.doseKey);
    const validDose = recommendation?.canAdjust === true && Number.isFinite(recommendation.suggestedDoseMlPerDay)
      ? recommendation.suggestedDoseMlPerDay : null;
    const suggestedDays = validDose > 0 && r.remainingMl !== null && !r.remainingIsUpperBound ? r.remainingMl / validDose : null;
    return { ...r, daysAtApprovedSuggestedDose: suggestedDays,
      approvedSuggestionInventoryWarning: suggestedDays !== null && suggestedDays < 7
        ? `${r.name} 庫存不足以支持安全引擎建議量使用 7 天，請先補充或確認庫存；不可因此自行改變滴定量。` : null };
  });
  return {
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    cloudUpdatedAt,
    policy: GPT_DATA_POLICY,
    tank: { id: data.id, name: tank.name, volumeLiters: tank.volume, targets: tank.targets },
    freshness: {
      latestMeasurementDate: latest?.date || null,
      measurementAgeDays,
      requiresNewMeasurement: stale,
      warning: "GPT 只能讀到最後成功同步的資料；請先核對測量日期與雲端更新時間。",
    },
    dosing: Object.fromEntries(["kh", "ca", "mg", "aplus", "kplus"].map((key) => {
      const status = getDoseStatus(dosing, key);
      const configuredDose = numberOrNull(dosing[key]);
      return [key, {
        configuredMlPerDay: configuredDose,
        effectiveMlPerDay: status.enabled && status.pausedDays === 0 ? configuredDose : 0,
        ...status,
      }];
    })),
    latestMeasurement: measurementData(latest),
    previousMeasurement: measurementData(previous),
    recentMeasurements: records.slice(-8).reverse().map(measurementData),
    recommendations,
    reservoirInventory: {
      timeZone: "Asia/Taipei", calculatedAt: inventoryCalculatedAt,
      defaultWarningThreshold: 80, reservoirs: inventory,
      warnings: inventory.flatMap((r) => [r.warning, r.approvedSuggestionInventoryWarning].filter(Boolean)),
      interpretation: "每次水質分析都須列出全部滴定桶庫存與警告。庫存是按已同步設定估算，除非 quality=actual；手動確認時間不是計算時間，也不是水質測量日期或同步時間。canAdjust=false 或 suggestedDoseMlPerDay=null 時不可產生新劑量，暫不計算不等於維持。庫存不足只提醒補充，不可自動改滴定。",
    },
    referenceFactors: {
      events: recentEntries(data.events, ["event_start_date", "start_date", "date", "createdAt"], now, ["id", "type", "event_type", "date", "event_start_date", "start_date", "affected_element", "title", "note", "notes", "expected_recovery_days", "recovery_days"]),
      maintenance: recentEntries(data.maintenance, "date", now, ["date", "waterChangeCount", "waterChangeVolume", "newFish", "newCoral", "moreFeeding", "changedAdditive", "note"]),
      feeding: recentEntries(data.feedings, "date", now, ["date", "timesPerDay", "amountLevel", "foodTypes", "foodType", "note"]),
      additives: recentEntries(data.additives, "date", now, ["date", "item", "itemLabel", "doseMl", "autoDosed", "note"]),
      livestock: recentEntries(data.livestock, ["removedAt", "addedAt"], now, ["name", "quantity", "addedAt", "removed", "removedAt"]),
      dosingApplications: recentEntries(data.doseApplications, "appliedAt", now, ["parameter", "oldDose", "newDose", "changeAmount", "appliedAt", "relatedMeasurementId", "reason"]),
    },
  };
}
