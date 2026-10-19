import { DEFAULT_RESERVOIR_ALERT_DAYS, MAX_RESERVOIR_CAPACITY_ML, DOSE_KEYS, reservoirDose, sameReservoirDose } from "../modules/reservoirModule.js";
import { evaluateReservoirAvailability, validReservoirAlertDays } from "./reservoirAlertEngine.js";
import { effectiveManualEvents, reservoirManualHistory } from "../modules/reservoirHistoryModule.js";

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const time = (value) => Date.parse(value);
export const inventoryRound = (value) => Math.round(value * 1e6) / 1e6;
export const taipeiInventoryDate = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();

export function createReservoir({ id, tankId, name, doseKey, capacityMl, bottomReserveMl = 0, alertThresholds = DEFAULT_RESERVOIR_ALERT_DAYS }, dosing, at) {
  if (!id || !tankId || !String(name || "").trim() || String(name).length > 80 || !DOSE_KEYS.includes(doseKey)
    || !Number.isFinite(capacityMl) || capacityMl <= 0 || capacityMl > MAX_RESERVOIR_CAPACITY_ML
    || !Number.isFinite(bottomReserveMl) || bottomReserveMl < 0 || bottomReserveMl > capacityMl
    || !validReservoirAlertDays(alertThresholds)) throw new Error("INVALID_INVENTORY_INPUT");
  const setting = reservoirDose(dosing, doseKey);
  return { id, tankId, name: name.trim(), doseKey, capacityMl, initialCapacityMl: capacityMl, bottomReserveMl, alertThresholds: { ...alertThresholds },
    active: true, deletedAt: null, createdAt: at, remainingMl: null, lastCalculatedAt: null,
    lastManualConfirmedAt: null, lastRefilledAt: null, manualEvents: [], executions: [],
    schedule: [{ id: "origin", at, setting }], seenDosingEventIds: [], dataGaps: [],
    lastObservedAt: at, observedDosing: setting, dailyConsumption: {}, activeAlertId: null };
}

// An explicit timeline is required. Older clients without timestamps create a gap, never a guessed deduction.
export function ingestDosingHistory(reservoir, tank, cloudUpdatedAt, at) {
  const r = structuredClone(reservoir);
  const origin = time(r.createdAt);
  const known = new Set(r.seenDosingEventIds);
  const entries = (tank.dosingHistory || []).filter((e) => e.key === r.doseKey && !known.has(e.id))
    .sort((a, b) => time(a.effectiveAt) - time(b.effectiveAt));
  for (const entry of entries) {
    known.add(entry.id);
    const when = time(entry.effectiveAt);
    if (when < origin) continue;
    if (!Number.isFinite(when) || when > time(at) || !validSetting(entry.after) || !validSetting(entry.before)) {
      addGap(r, r.lastObservedAt, at, "滴定變更時間或內容無法確認");
      continue;
    }
    if (entry.timingUncertain) addGap(r, r.lastObservedAt, entry.effectiveAt, "僅確認雲端設定變更時間，先前實際生效時間不明");
    const preceding = [...r.schedule].filter((e) => time(e.at) <= when).at(-1);
    if (!sameReservoirDose(preceding?.setting, entry.before)) addGap(r, preceding?.at || r.lastObservedAt, entry.effectiveAt, "滴定變更紀錄不連續");
    r.schedule.push({ id: entry.id, at: entry.effectiveAt, setting: entry.after });
    r.schedule.sort((a, b) => time(a.at) - time(b.at));
  }
  const current = reservoirDose(tank.dosing, r.doseKey);
  if (!sameReservoirDose(r.schedule.at(-1).setting, current)) {
    const effectiveAt = iso(Math.min(time(at), Math.max(time(r.lastObservedAt), time(cloudUpdatedAt) || time(at))));
    addGap(r, r.lastObservedAt, effectiveAt, "缺少滴定量或啟停生效時間，請重新確認庫存");
    r.schedule.push({ id: `unknown:${effectiveAt}`, at: effectiveAt, setting: current });
  }
  r.seenDosingEventIds = [...known];
  r.observedDosing = current;
  r.lastObservedAt = at;
  return r;
}

function validSetting(s) {
  const validOrUnknown = (n) => n === null || Number.isFinite(n) && n >= 0;
  return s && validOrUnknown(s.configuredMlPerDay) && typeof s.enabled === "boolean" && validOrUnknown(s.pausedDays)
    && s.effectiveMlPerDay === (!s.enabled || s.pausedDays > 0 ? 0 : s.pausedDays === null ? null : s.configuredMlPerDay);
}

function addGap(r, start, end, reason) {
  if (!r.dataGaps.some((g) => g.start === start && g.end === end && g.reason === reason)) r.dataGaps.push({ start, end, reason });
}

// Replay from the latest manual baseline. Late, timestamped offline settings correct estimates, not historical rates.
export function calculateReservoir(reservoir, at, { rejectOverflow = false } = {}) {
  const r = structuredClone(reservoir);
  const end = time(at);
  const events = effectiveManualEvents(r.manualEvents, end);
  const baselineIndex = events.findLastIndex((e) => e.type === "calibrate");
  r.lastCalculatedAt = at;
  r.dailyConsumption = {};
  if (baselineIndex < 0) return { ...r, remainingMl: null, quality: "uninitialized", relevantGaps: [] };
  const baseline = events[baselineIndex];
  const start = time(baseline.at);
  if (end < start) throw new Error("INVALID_INVENTORY_TIME");
  let remaining = baseline.amountMl;
  let capacity = r.initialCapacityMl;
  let tracking = true;
  for (const e of events.slice(0, baselineIndex + 1)) {
    if (e.type === "capacity") capacity = e.capacityMl;
    if (e.type === "tracking") tracking = e.active;
  }
  if (rejectOverflow && remaining > capacity + 0.000001) throw new Error("INVENTORY_CORRECTION_CONFLICT");
  const manual = events.slice(baselineIndex + 1);
  const points = new Set([start, end]);
  for (const e of [...r.schedule, ...manual]) if (time(e.at) >= start && time(e.at) <= end) points.add(time(e.at));
  for (const g of r.dataGaps) for (const v of [g.start, g.end]) if (time(v) > start && time(v) < end) points.add(time(v));
  for (const e of r.executions) for (const v of [e.start, e.end, ...e.records.map((record) => record.executedAt)]) {
    if (time(v) > start && time(v) < end) points.add(time(v));
  }
  for (let day = (Math.floor((start + OFFSET) / DAY) + 1) * DAY - OFFSET; day < end; day += DAY) points.add(day);
  const times = [...points].sort((a, b) => a - b);
  const potentialGaps = r.dataGaps.filter((g) => time(g.end) >= start && time(g.start) <= end && time(g.end) > start);
  const relevantGaps = [];
  const bucketAt = (ms) => r.dailyConsumption[taipeiInventoryDate(ms)] ||= { consumedMl: 0, demandedMl: 0, estimatedMl: 0, actualMl: 0, gapSeconds: 0, estimatedSeconds: 0, actualSeconds: 0 };
  for (let index = 0; index < times.length; index += 1) {
    const a = times[index];
    if (index > 0) {
      const from = times[index - 1];
      const bucket = bucketAt(from);
      const coverage = r.executions.find((e) => time(e.start) <= from && time(e.end) >= a);
      const gap = potentialGaps.find((g) => time(g.start) < a && time(g.end) > from);
      const setting = [...r.schedule].filter((e) => time(e.at) <= from).at(-1)?.setting;
      if (coverage) bucket.actualSeconds += (a - from) / 1000;
      if (!coverage && !tracking && setting?.effectiveMlPerDay > 0) {
        bucket.gapSeconds += (a - from) / 1000;
        if (!relevantGaps.some((g) => g.reason === "庫存追蹤停用期間仍有設定滴定，請重新確認剩餘量")) relevantGaps.push({ start: iso(from), end: iso(a), reason: "庫存追蹤停用期間仍有設定滴定，請重新確認剩餘量" });
      }
      if (!coverage && gap) {
        bucket.gapSeconds += (a - from) / 1000;
        if (!relevantGaps.some((g) => g.start === gap.start && g.end === gap.end && g.reason === gap.reason)) relevantGaps.push(gap);
      }
      const validDose = Number.isFinite(setting?.effectiveMlPerDay) && setting.effectiveMlPerDay >= 0;
      if (!coverage && tracking && !validDose) {
        bucket.gapSeconds += (a - from) / 1000;
        relevantGaps.push({ start: iso(from), end: iso(a), reason: "有效每日滴定量缺失或無效，未扣除未知消耗" });
      }
      if (!coverage && !gap && tracking && validDose) {
        bucket.estimatedSeconds += (a - from) / 1000;
        const demand = setting.effectiveMlPerDay * (a - from) / DAY;
        const deducted = Math.min(remaining, demand);
        remaining -= deducted;
        bucket.consumedMl += deducted;
        bucket.demandedMl += demand;
        bucket.estimatedMl += demand;
      }
    }
    // Device records are pulses, not an assumed uniform rate. A calibration at the same instant wins.
    if (a > start) for (const coverage of r.executions) for (const record of coverage.records) {
      if (time(record.executedAt) !== a) continue;
      const bucket = bucketAt(a);
      const deducted = Math.min(remaining, record.amountMl);
      remaining -= deducted;
      bucket.consumedMl += deducted;
      bucket.demandedMl += record.amountMl;
      bucket.actualMl += record.amountMl;
    }
    for (const e of manual.filter((e) => time(e.at) === a)) {
      if (e.type === "refill") remaining += e.amountMl;
      if (e.type === "capacity") capacity = e.capacityMl;
      if (e.type === "tracking") tracking = e.active;
      if (remaining > capacity + 0.000001) {
        if (rejectOverflow) throw new Error("INVENTORY_CORRECTION_CONFLICT");
        if (!relevantGaps.some((g) => g.reason === "歷史補充與重新計算結果衝突，請校正")) relevantGaps.push({ start: e.at, end: at, reason: "歷史補充與重新計算結果衝突，請校正" });
        remaining = capacity;
      }
    }
  }
  for (const bucket of Object.values(r.dailyConsumption)) for (const key of Object.keys(bucket)) bucket[key] = inventoryRound(bucket[key]);
  const estimated = Object.values(r.dailyConsumption).some((b) => b.estimatedSeconds > 0);
  return { ...r, remainingMl: inventoryRound(Math.max(0, Math.min(capacity, remaining))), relevantGaps,
    quality: relevantGaps.length ? "data_gap" : estimated ? "estimated" : Object.values(r.dailyConsumption).some((b) => b.actualSeconds > 0) ? "actual" : "manually_confirmed" };
}

export function reservoirView(r, ledger = []) {
  const dose = r.observedDosing || {};
  const bottomReserveMl = r.bottomReserveMl ?? 0;
  const alertThresholds = r.alertThresholds ?? DEFAULT_RESERVOIR_ALERT_DAYS;
  const percentage = r.remainingMl === null ? null : inventoryRound(r.remainingMl / r.capacityMl * 100);
  const availability = evaluateReservoirAvailability({ remainingMl: r.remainingMl, bottomReserveMl, alertThresholds,
    effectiveMlPerDay: dose.effectiveMlPerDay, trackingActive: r.active, remainingIsUpperBound: r.quality === "data_gap" });
  const history = reservoirManualHistory(r, ledger);
  const refillHistory = history.filter((e) => e.type === "refill");
  return { id: r.id, tankId: r.tankId, name: r.name, doseKey: r.doseKey, capacityMl: r.capacityMl,
    remainingMl: r.remainingMl, percentage, bottomReserveMl, alertThresholds: { ...alertThresholds },
    ...dose, trackingActive: r.active, deletedAt: r.deletedAt,
    ...availability,
    lastManualConfirmedAt: r.lastManualConfirmedAt, lastCalculatedAt: r.lastCalculatedAt, lastRefilledAt: r.lastRefilledAt,
    lastRefill: refillHistory[0] || null, lastRefilledAmountMl: refillHistory[0]?.effectiveAmountMl ?? null,
    refillHistory, calibrationHistory: history.filter((e) => e.type === "calibrate"),
    quality: r.quality, isEstimate: r.quality === "estimated", remainingIsUpperBound: r.quality === "data_gap",
    dataGaps: r.relevantGaps || [], inventoryMeasurementType: "calculated_not_level_sensor",
    warning: ["normal", "not_dosing", "tracking_disabled"].includes(availability.alertStatus) ? null : `${r.name}：${availability.alertReason}` };
}

export function applyReservoirOperation(reservoir, operation, at) {
  let r = calculateReservoir(reservoir, at);
  const before = reservoirView(r);
  const e = { id: operation.idempotencyKey, type: operation.type, at, source: operation.source || "manual_app" };
  for (const key of ["notes", "reason"]) {
    if (operation[key] !== undefined && (typeof operation[key] !== "string" || operation[key].length > 1000)) throw new Error("INVALID_INVENTORY_INPUT");
    if (operation[key] !== undefined) e[key] = operation[key].trim();
  }
  e.beforeMl = before.remainingMl;
  e.beforeQuality = before.quality;
  const validMl = (v, allowZero = true) => typeof v === "number" && Number.isFinite(v) && v >= (allowZero ? 0 : 0.000001) && v <= MAX_RESERVOIR_CAPACITY_ML;
  if (r.deletedAt) throw new Error("RESERVOIR_NOT_FOUND");
  switch (operation.type) {
    case "calibrate":
      if (!validMl(operation.amountMl) || operation.amountMl > r.capacityMl) throw new Error("INVALID_INVENTORY_INPUT");
      e.amountMl = operation.amountMl;
      r.lastManualConfirmedAt = at;
      break;
    case "refill":
      if (r.remainingMl === null || r.quality === "data_gap") throw new Error("INVENTORY_CONFIRMATION_REQUIRED");
      if (!validMl(operation.amountMl, false) || operation.amountMl > r.capacityMl - r.remainingMl) throw new Error("INVENTORY_CAPACITY_EXCEEDED");
      e.amountMl = operation.amountMl;
      r.lastRefilledAt = at;
      break;
    case "correct": {
      const target = reservoirManualHistory(r).find((entry) => entry.id === operation.targetEventId && entry.type === operation.targetType);
      if (!target) throw new Error("INVENTORY_HISTORY_NOT_FOUND");
      if (operation.expectedRevisionId !== target.revisionId) throw new Error("INVENTORY_HISTORY_CONFLICT");
      if (!e.reason || !validMl(operation.amountMl, target.type !== "refill")) throw new Error("INVALID_INVENTORY_INPUT");
      e.targetEventId = target.id;
      e.targetType = target.type;
      e.previousAmountMl = target.effectiveAmountMl;
      e.previousNotes = target.effectiveNotes;
      e.previousRevisionId = target.revisionId;
      e.amountMl = operation.amountMl;
      e.notes = operation.notes === undefined ? target.effectiveNotes : operation.notes.trim();
      break;
    }
    case "capacity":
      if (!validMl(operation.capacityMl, false)) throw new Error("INVALID_INVENTORY_INPUT");
      if ((r.bottomReserveMl ?? 0) > operation.capacityMl) throw new Error("INVENTORY_RESERVE_EXCEEDS_CAPACITY");
      if (r.remainingMl !== null && operation.capacityMl < r.remainingMl && operation.correctedRemainingMl === undefined) throw new Error("INVENTORY_CONFIRMATION_REQUIRED");
      e.capacityMl = operation.capacityMl;
      r.capacityMl = operation.capacityMl;
      break;
    case "threshold":
      if (!validReservoirAlertDays(operation.alertThresholds)) throw new Error("INVALID_INVENTORY_ALERT_DAYS");
      e.alertThresholds = { ...operation.alertThresholds };
      r.alertThresholds = e.alertThresholds;
      break;
    case "reserve":
      if (!validMl(operation.bottomReserveMl) || operation.bottomReserveMl > r.capacityMl) throw new Error("INVALID_INVENTORY_INPUT");
      e.bottomReserveMl = operation.bottomReserveMl;
      r.bottomReserveMl = operation.bottomReserveMl;
      break;
    case "tracking":
      if (typeof operation.active !== "boolean") throw new Error("INVALID_INVENTORY_INPUT");
      e.active = operation.active;
      r.active = operation.active;
      break;
    case "delete":
      r.deletedAt = at;
      r.active = false;
      e.active = false;
      break;
    case "execution": {
      const { start, end, records } = operation;
      if (!(time(start) >= time(r.createdAt) && time(end) > time(start) && time(end) <= time(at)) || !Array.isArray(records) || records.length > 5000
        || !records.every((row) => typeof row.id === "string" && row.id.length <= 120 && row.id.length > 0 && validMl(row.amountMl)
          && time(row.executedAt) >= time(start) && time(row.executedAt) < time(end))
        || new Set(records.map((row) => row.id)).size !== records.length
        || r.executions.some((entry) => time(entry.start) < time(end) && time(entry.end) > time(start)
          || entry.records.some((old) => records.some((row) => row.id === old.id)))) throw new Error("INVALID_EXECUTION_COVERAGE");
      // A batch asserts complete device coverage, including zero executions. Partial logs must not replace estimates.
      r.executions.push({ id: e.id, start, end, records });
      e.coverageStart = start;
      e.coverageEnd = end;
      e.records = records;
      break;
    }
    default: throw new Error("INVALID_INVENTORY_INPUT");
  }
  r.manualEvents.push(e);
  if (operation.type === "capacity" && operation.correctedRemainingMl !== undefined) {
    if (!validMl(operation.correctedRemainingMl) || operation.correctedRemainingMl > r.capacityMl) throw new Error("INVALID_INVENTORY_INPUT");
    r.manualEvents.push({ ...e, type: "calibrate", amountMl: operation.correctedRemainingMl,
      reason: e.reason || "修改容量時確認實際剩餘量" });
    r.lastManualConfirmedAt = at;
  }
  if (operation.type === "correct") {
    const projected = effectiveManualEvents(r.manualEvents, time(at));
    const targetIndex = projected.findIndex((event) => event.id === e.targetEventId && event.type === e.targetType);
    // Validate the corrected timeline, including intervals superseded by a later calibration.
    for (let index = targetIndex; index < projected.length; index++) {
      calculateReservoir({ ...r, manualEvents: projected.slice(0, index + 1) }, projected[index].at, { rejectOverflow: true });
    }
  }
  r = calculateReservoir(r, at, { rejectOverflow: operation.type === "correct" });
  if (operation.type === "correct" && (r.remainingMl > r.capacityMl || r.relevantGaps.some((g) => g.reason === "歷史補充與重新計算結果衝突，請校正"))) {
    throw new Error("INVENTORY_CORRECTION_CONFLICT");
  }
  // The original event remains immutable; every edit is a separate append-only event.
  for (const event of r.manualEvents) if (event.id === e.id) event.afterMl = r.remainingMl;
  e.afterMl = r.remainingMl;
  return { reservoir: r, before, after: reservoirView(r), event: e };
}
