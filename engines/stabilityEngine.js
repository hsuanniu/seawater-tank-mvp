import { getSortedRecords } from "../modules/measurementModule.js";

export const MEASUREMENT_DEAD_ZONES = {
  kh: 0.2,
  ca: 10,
  mg: 30,
  k: 10,
  no3: 0.5,
  po4: 0.02,
};

export const STABILITY_RANGES = {
  kh: { min: 7.5, max: 8.5 },
  ca: { min: 400, max: 450 },
  mg: { min: 1320, max: 1400 },
  k: { min: 390, max: 420 },
  no3: { min: 0.5, max: 2 },
  po4: { min: 0.02, max: 0.08 },
};

export const REQUIRED_OUT_OF_RANGE_SAMPLES = {
  kh: 1,
  ca: 2,
  mg: 3,
};

const OBSERVE_EVENT_KEYWORDS = [
  "tube",
  "doser",
  "dosing",
  "air_leak",
  "air_purge",
  "manual_supplement",
  "manual_dose",
  "large_water_change",
  "livestock_added",
  "feeding_changed",
];

function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  return Math.floor((endDate - startDate) / 86400000);
}

function isMeasured(record, parameter) {
  return !record.measuredFields || record.measuredFields[parameter] !== false;
}

function rangeSide(value, targetRange) {
  if (!Number.isFinite(value)) return "unknown";
  if (value < targetRange.min) return "low";
  if (value > targetRange.max) return "high";
  return "inside";
}

function measuredValues(records, parameter) {
  return getSortedRecords(records)
    .filter((record) => isMeasured(record, parameter) && Number.isFinite(Number(record[parameter])))
    .map((record) => Number(record[parameter]));
}

export function buildStabilityContext({
  parameter,
  currentValue,
  previousValue,
  targetRange,
  daysBetweenTests,
  records = [],
}) {
  const deadZone = MEASUREMENT_DEAD_ZONES[parameter] ?? 0;
  const delta = previousValue === null || previousValue === undefined
    ? null
    : currentValue - previousValue;
  const withinDeadZone = delta !== null && Math.abs(delta) <= deadZone;
  const currentSide = rangeSide(currentValue, targetRange);
  const stabilityRange = STABILITY_RANGES[parameter] || targetRange;
  const inStabilityRange = rangeSide(currentValue, stabilityRange) === "inside";
  const values = measuredValues(records, parameter);
  const fallbackValues = values.length ? values : [previousValue, currentValue].filter(Number.isFinite);
  let consecutiveOutOfRange = 0;

  for (let index = fallbackValues.length - 1; index >= 0; index -= 1) {
    if (rangeSide(fallbackValues[index], targetRange) !== currentSide || currentSide === "inside") break;
    consecutiveOutOfRange += 1;
  }

  const requiredSamples = REQUIRED_OUT_OF_RANGE_SAMPLES[parameter] ?? 2;
  const stableLock = Boolean(
    withinDeadZone
    && daysBetweenTests >= 5
    && inStabilityRange,
  );

  return {
    deadZone,
    delta,
    withinDeadZone,
    stableLock,
    currentSide,
    inTargetRange: currentSide === "inside",
    inStabilityRange,
    consecutiveOutOfRange,
    requiredOutOfRangeSamples: requiredSamples,
    hasConfirmedOutOfRange: currentSide !== "inside" && consecutiveOutOfRange >= requiredSamples,
  };
}

function eventDate(event) {
  return dateText(
    event.date
    || event.start_date
    || event.event_start_date
    || event.createdAt
    || event.addedAt,
  );
}

function eventType(event) {
  return String(event.event_type || event.eventType || event.type || "").trim().toLowerCase();
}

function isRecent(date, latestDate, observeDays) {
  const elapsed = daysBetween(date, latestDate);
  return elapsed !== null && elapsed >= 0 && elapsed <= observeDays;
}

export function buildObserveContext({
  latestDate,
  tankVolumeLiters,
  events = [],
  maintenance = [],
  livestock = [],
  observeDays = 7,
} = {}) {
  if (!latestDate) return { observe_mode: false, reasons: [], adjustment_factor: 1 };

  const reasons = [];

  events.forEach((event) => {
    const type = eventType(event);
    const date = eventDate(event);
    if (!date || !isRecent(date, latestDate, observeDays)) return;
    if (OBSERVE_EVENT_KEYWORDS.some((keyword) => type.includes(keyword))) {
      reasons.push(event.title || event.summary || event.event_type || "近期設備或手動調整事件");
    }
  });

  maintenance.forEach((entry) => {
    const date = eventDate(entry);
    if (!date || !isRecent(date, latestDate, observeDays)) return;
    const changedWater = Number(entry.waterChangeCount || 0) * Number(entry.waterChangeVolume || 0);
    if (Number.isFinite(tankVolumeLiters) && tankVolumeLiters > 0 && changedWater / tankVolumeLiters >= 0.2) {
      reasons.push("近期有大換水");
    }
    if (entry.newFish || entry.newCoral) reasons.push("近期新增生物");
    if (entry.moreFeeding) reasons.push("近期餵食量改變");
    if (entry.changedAdditive) reasons.push("近期更換添加劑");
  });

  livestock.forEach((entry) => {
    const date = eventDate(entry);
    if (date && !entry.removed && isRecent(date, latestDate, observeDays)) {
      reasons.push("近期新增魚隻");
    }
  });

  return {
    observe_mode: reasons.length > 0,
    reasons: [...new Set(reasons)],
    adjustment_factor: reasons.length > 0 ? 0.5 : 1,
    observe_days: observeDays,
  };
}
