import { daysBetweenRecords, getSortedRecords } from "./measurementModule.js";
import { additiveGroup, additiveLabel } from "./additiveLogModule.js";
import { foodLabel, isHigherFeeding, isLowFeeding } from "./feedingLogModule.js";

export const WEEKDAYS = [
  { value: "1", label: "星期一" },
  { value: "2", label: "星期二" },
  { value: "3", label: "星期三" },
  { value: "4", label: "星期四" },
  { value: "5", label: "星期五" },
  { value: "6", label: "星期六" },
  { value: "0", label: "星期日" },
];

function dateInRecentWindow(dateValue, latestDate, days = 14) {
  if (!dateValue || !latestDate) return false;
  const diffDays = (new Date(latestDate) - new Date(dateValue)) / 86400000;
  return diffDays >= 0 && diffDays <= days;
}

function nutrientTrend(latest, previous, key) {
  if (!latest || !previous) return "none";
  const current = Number(latest[key]);
  const before = Number(previous[key]);
  if (!Number.isFinite(current) || !Number.isFinite(before)) return "none";
  const delta = current - before;
  const tolerance = key === "po4" ? 0.01 : 0.1;
  if (Math.abs(delta) <= tolerance) return "stable";
  return delta > 0 ? "up" : "down";
}

function nutrientStatus(latest, targets, key) {
  if (!latest || !targets || !targets[key]) return "unknown";
  const value = Number(latest[key]);
  if (!Number.isFinite(value)) return "unknown";
  if (value < targets[key].min) return "low";
  if (value > targets[key].max) return "high";
  return "normal";
}

export function analyzeBioLoadReferences({ records, livestock, feedings, additives, targets, referenceDays = 14 }) {
  const sortedRecords = getSortedRecords(records);
  const latest = sortedRecords[sortedRecords.length - 1] || null;
  const previous = sortedRecords[sortedRecords.length - 2] || null;
  const latestDate = latest ? latest.date : new Date().toISOString().slice(0, 10);
  const daysBetween = daysBetweenRecords(latest, previous);
  const recentFish = livestock.filter((fish) => !fish.removed && dateInRecentWindow(fish.addedAt, latestDate, referenceDays));
  const recentFeedings = feedings.filter((feeding) => dateInRecentWindow(feeding.date, latestDate, referenceDays));
  const recentAdditives = additives.filter((additive) => dateInRecentWindow(additive.date, latestDate, referenceDays));
  const higherFeeding = recentFeedings.filter(isHigherFeeding);
  const lowFeedings = recentFeedings.filter(isLowFeeding);
  const coralNutritionAdditives = recentAdditives.filter((additive) => ["coral-nutrition", "amino"].includes(additiveGroup(additive.item)));
  const autoDosedAdditives = recentAdditives.filter((additive) => additive.autoDosed);
  const additiveTotals = recentAdditives.reduce((totals, additive) => {
    const item = additive.itemLabel || additiveLabel(additive.item || (additive.items || [])[0]);
    totals[item] = totals[item] || { count: 0, doseMl: 0, unknownDoseCount: 0 };
    totals[item].count += 1;
    if (Number.isFinite(Number(additive.doseMl))) {
      totals[item].doseMl += Number(additive.doseMl);
    } else {
      totals[item].unknownDoseCount += 1;
    }
    return totals;
  }, {});
  const no3Trend = nutrientTrend(latest, previous, "no3");
  const po4Trend = nutrientTrend(latest, previous, "po4");
  const no3Status = nutrientStatus(latest, targets, "no3");
  const po4Status = nutrientStatus(latest, targets, "po4");
  const factors = [];
  const possibleImpacts = [];

  if (recentFish.length) {
    factors.push({
      code: "RECENT_FISH_ADDED",
      text: `近 ${referenceDays} 天新增魚隻：${recentFish.map((fish) => `${fish.name} x${fish.quantity}`).join("、")}`,
    });
  }
  if (higherFeeding.length) {
    factors.push({
      code: "RECENT_FEEDING_HIGH",
      text: `近 ${referenceDays} 天有較高餵食紀錄：${higherFeeding.length} 筆`,
    });
  } else if (recentFeedings.length) {
    factors.push({
      code: "RECENT_FEEDING_LOGGED",
      text: `近 ${referenceDays} 天有餵食紀錄：${recentFeedings.length} 筆，類型：${[...new Set(recentFeedings.flatMap((feeding) => feeding.foodTypes || []).map(foodLabel))].join("、") || "未填種類"}`,
    });
  }
  if (recentAdditives.length) {
    factors.push({
      code: "RECENT_ADDITIVES",
      text: `近 ${referenceDays} 天有添加物紀錄：${Object.entries(additiveTotals)
        .map(([item, total]) => {
          const unknownText = total.unknownDoseCount ? `，另 ${total.unknownDoseCount} 筆未記錄 ml` : "";
          return `${item} ${total.count} 次，合計 ${Number(total.doseMl.toFixed(2))} ml${unknownText}`;
        })
        .join("、")}`,
    });
  }
  if (autoDosedAdditives.length) {
    factors.push({
      code: "RECENT_AUTO_DOSED_ADDITIVES",
      text: `近 ${referenceDays} 天有自動滴定添加物紀錄：${autoDosedAdditives.length} 筆，僅作參考，不改變主要滴定建議。`,
    });
  }

  if ((po4Trend === "up" || po4Status === "high") && (higherFeeding.length || coralNutritionAdditives.length)) {
    possibleImpacts.push("近期餵食或珊瑚營養添加增加，可能與 PO4 上升有關，建議觀察，不建議立即使用藥劑壓低。");
  }
  if ((no3Status === "low" || no3Trend === "down") && (!recentFeedings.length || lowFeedings.length >= recentFeedings.length)) {
    possibleImpacts.push("NO3 偏低且近期餵食紀錄較少，可考慮維持或微幅增加餵食，但不要激進調整。");
  }
  if ((no3Trend === "up" || po4Trend === "up") && recentFish.length) {
    possibleImpacts.push("近期新增魚隻可能提高生物負載，NO3 / PO4 變化先以觀察與穩定維護為主。");
  }
  if (!possibleImpacts.length) {
    possibleImpacts.push("目前沒有足夠跡象把 NO3 / PO4 變化歸因到單一餵食或添加物，建議持續記錄後再比對趨勢。");
  }

  const nutrientChanged = no3Trend === "up" || no3Trend === "down" || po4Trend === "up" || po4Trend === "down";
  const summary = [];
  if (!latest || !previous) {
    summary.push("尚無足夠水質紀錄可比對 NO3 / PO4 趨勢。");
  } else if (nutrientChanged && factors.length) {
    summary.push("NO3 / PO4 有變化，以下近期事件可作為原因判斷參考。");
  } else if (nutrientChanged) {
    summary.push("NO3 / PO4 有變化，但近期待查因素較少，可回頭確認換水、過濾與測試誤差。");
  } else {
    summary.push("NO3 / PO4 近期變化不明顯，生物負載紀錄先作為後續比對基準。");
  }

  return {
    referenceDays,
    latestDate,
    daysBetween,
    no3Trend,
    po4Trend,
    no3Status,
    po4Status,
    recentFish,
    recentFeedings,
    recentAdditives,
    additiveTotals,
    factors,
    possibleImpacts,
    summary,
    disclaimer: "此區只做參考因素分析，不計算 NO3 / PO4、不自動修正餵食、不建議藥劑，也不修改滴定。",
  };
}
