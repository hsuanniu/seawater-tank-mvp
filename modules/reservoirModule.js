export const DOSE_KEYS = ["kh", "ca", "mg", "aplus", "kplus", "custom"];
export const DEFAULT_RESERVOIRS = [
  { name: "KH", doseKey: "kh", capacityMl: 1500 },
  { name: "CA", doseKey: "ca", capacityMl: 1500 },
  { name: "MG", doseKey: "mg", capacityMl: 1500 },
  { name: "A+", doseKey: "aplus", capacityMl: 800 },
  { name: "K+", doseKey: "kplus", capacityMl: 800 },
];

export const DEFAULT_RESERVOIR_ALERT_DAYS = { reminderDays: 30, warningDays: 14, urgentDays: 7 };
export const MAX_RESERVOIR_CAPACITY_ML = 1000000;

function doseNumber(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function reservoirDose(dosing = {}, key) {
  const raw = key === "custom" ? dosing.customDose : dosing[key];
  // Existing ml/day is the entire day's total, not the amount of a single pump execution.
  const configuredMlPerDay = doseNumber(raw);
  const enabled = dosing.status?.[key]?.enabled !== false;
  const pausedDays = doseNumber(dosing.status?.[key]?.pausedDays ?? 0);
  return { configuredMlPerDay, enabled, pausedDays,
    effectiveMlPerDay: !enabled || pausedDays > 0 ? 0 : pausedDays === null ? null : configuredMlPerDay };
}

export function sameReservoirDose(a, b) {
  return a?.configuredMlPerDay === b?.configuredMlPerDay && a?.enabled === b?.enabled && a?.pausedDays === b?.pausedDays
    && a?.effectiveMlPerDay === b?.effectiveMlPerDay;
}

export function dosingChanges(before, after, { at, createId, source }) {
  return DOSE_KEYS.flatMap((key) => {
    const previous = reservoirDose(before, key);
    const next = reservoirDose(after, key);
    return sameReservoirDose(previous, next) ? [] : [{ id: createId(), key, effectiveAt: at, before: previous, after: next, source }];
  });
}
