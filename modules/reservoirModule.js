export const DOSE_KEYS = ["kh", "ca", "mg", "aplus", "kplus", "custom"];
export const DEFAULT_RESERVOIRS = [
  { name: "KH", doseKey: "kh", capacityMl: 1000 },
  { name: "CA", doseKey: "ca", capacityMl: 1000 },
  { name: "MG", doseKey: "mg", capacityMl: 1000 },
  { name: "A+", doseKey: "aplus", capacityMl: 500 },
  { name: "K+", doseKey: "kplus", capacityMl: 500 },
];

export function reservoirDose(dosing = {}, key) {
  const raw = key === "custom" ? dosing.customDose : dosing[key];
  const configuredMlPerDay = Math.max(0, Number(raw) || 0);
  const enabled = dosing.status?.[key]?.enabled !== false;
  const pausedDays = Math.max(0, Number(dosing.status?.[key]?.pausedDays) || 0);
  return { configuredMlPerDay, enabled, pausedDays,
    effectiveMlPerDay: enabled && !pausedDays ? configuredMlPerDay : 0 };
}

export function sameReservoirDose(a, b) {
  return a?.configuredMlPerDay === b?.configuredMlPerDay && a?.enabled === b?.enabled && a?.pausedDays === b?.pausedDays;
}

export function dosingChanges(before, after, { at, createId, source }) {
  return DOSE_KEYS.flatMap((key) => {
    const previous = reservoirDose(before, key);
    const next = reservoirDose(after, key);
    return sameReservoirDose(previous, next) ? [] : [{ id: createId(), key, effectiveAt: at, before: previous, after: next, source }];
  });
}
