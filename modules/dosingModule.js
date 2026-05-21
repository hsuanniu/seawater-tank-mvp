import { toNumber } from "../services/formatService.js";

export const DEFAULT_DOSING = {
  kh: 0,
  ca: 0,
  mg: 0,
  aplus: 0,
  kplus: 0,
  customName: "",
  customDose: 0,
  lastSavedAt: "",
  status: {
    kh: { enabled: true, pausedDays: 0 },
    ca: { enabled: true, pausedDays: 0 },
    mg: { enabled: true, pausedDays: 0 },
    aplus: { enabled: true, pausedDays: 0 },
    kplus: { enabled: true, pausedDays: 0 },
    custom: { enabled: true, pausedDays: 0 },
  },
};

export const APPLICABLE_DOSE_KEYS = ["kh", "ca", "mg"];

export function getDoseStatus(dosing, key) {
  const status = (dosing.status && dosing.status[key]) || {};
  return {
    enabled: status.enabled !== false,
    pausedDays: Math.max(0, toNumber(status.pausedDays, 0)),
  };
}

export function mergeDosing(baseDosing, nextDosing) {
  return {
    ...baseDosing,
    ...nextDosing,
    status: {
      ...DEFAULT_DOSING.status,
      ...(baseDosing.status || {}),
      ...(nextDosing.status || {}),
    },
    lastSavedAt: nextDosing.lastSavedAt || new Date().toISOString(),
  };
}

export function createDoseApplicationEntry({
  appliedAt,
  relatedMeasurementId = null,
  parameter,
  label,
  oldDose,
  newDose,
  changeAmount,
  reasonCode,
  reason,
}) {
  return {
    appliedAt,
    recordId: relatedMeasurementId,
    relatedMeasurementId,
    parameter,
    label,
    oldDose,
    newDose,
    changeAmount,
    oldDoseMlPerDay: oldDose,
    newDoseMlPerDay: newDose,
    doseChangeMlPerDay: changeAmount,
    reasonCode,
    reason,
    reasonText: reason,
  };
}
