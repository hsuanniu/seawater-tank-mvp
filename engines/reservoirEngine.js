import { DOSE_KEYS, reservoirDose, sameReservoirDose } from "../modules/reservoirModule.js";

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const time = (value) => Date.parse(value);
export const inventoryRound = (value) => Math.round(value * 1e6) / 1e6;
export const taipeiInventoryDate = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();

export function createReservoir({ id, tankId, name, doseKey, capacityMl, warningThreshold = 80 }, dosing, at) {
  if (!id || !tankId || !String(name || "").trim() || String(name).length > 80 || !DOSE_KEYS.includes(doseKey)
    || !Number.isFinite(capacityMl) || capacityMl <= 0 || capacityMl > 1000000
    || !Number.isFinite(warningThreshold) || warningThreshold <= 0 || warningThreshold > 100) throw new Error("INVALID_INVENTORY_INPUT");
  const setting = reservoirDose(dosing, doseKey);
  return { id, tankId, name: name.trim(), doseKey, capacityMl, initialCapacityMl: capacityMl, warningThreshold,
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
  return s && Number.isFinite(s.configuredMlPerDay) && s.configuredMlPerDay >= 0 && typeof s.enabled === "boolean"
    && Number.isFinite(s.pausedDays) && s.pausedDays >= 0 && s.effectiveMlPerDay === (s.enabled && !s.pausedDays ? s.configuredMlPerDay : 0);
}

function addGap(r, start, end, reason) {
  if (!r.dataGaps.some((g) => g.start === start && g.end === end && g.reason === reason)) r.dataGaps.push({ start, end, reason });
}

// Replay from the latest manual baseline. Late, timestamped offline settings correct estimates, not historical rates.
export function calculateReservoir(reservoir, at) {
  const r = structuredClone(reservoir);
  const end = time(at);
  const baselineIndex = r.manualEvents.findLastIndex((e) => e.type === "calibrate");
  r.lastCalculatedAt = at;
  r.dailyConsumption = {};
  if (baselineIndex < 0) return { ...r, remainingMl: null, quality: "uninitialized", relevantGaps: [] };
  const baseline = r.manualEvents[baselineIndex];
  const start = time(baseline.at);
  if (end < start) throw new Error("INVALID_INVENTORY_TIME");
  let remaining = baseline.amountMl;
  let capacity = r.initialCapacityMl;
  let tracking = true;
  for (const e of r.manualEvents.slice(0, baselineIndex + 1)) {
    if (e.type === "capacity") capacity = e.capacityMl;
    if (e.type === "tracking") tracking = e.active;
  }
  const manual = r.manualEvents.slice(baselineIndex + 1).filter((e) => time(e.at) <= end);
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
      if (!coverage && !gap && tracking && setting) {
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

export function reservoirView(r) {
  const dose = r.observedDosing;
  const percentage = r.remainingMl === null ? null : inventoryRound(r.remainingMl / r.capacityMl * 100);
  const low = r.remainingMl !== null && r.remainingMl < r.capacityMl * r.warningThreshold / 100;
  return { id: r.id, tankId: r.tankId, name: r.name, doseKey: r.doseKey, capacityMl: r.capacityMl,
    remainingMl: r.remainingMl, percentage, warningThreshold: r.warningThreshold,
    ...dose, trackingActive: r.active, deletedAt: r.deletedAt,
    estimatedDaysRemaining: r.remainingMl === null || r.quality === "data_gap" || !r.active || !dose.effectiveMlPerDay
      ? null : inventoryRound(r.remainingMl / dose.effectiveMlPerDay),
    lastManualConfirmedAt: r.lastManualConfirmedAt, lastCalculatedAt: r.lastCalculatedAt, lastRefilledAt: r.lastRefilledAt,
    quality: r.quality, isEstimate: r.quality === "estimated", remainingIsUpperBound: r.quality === "data_gap",
    dataGaps: r.relevantGaps || [], alertStatus: r.remainingMl === null ? "pending_initialization" : low ? "low" : r.quality === "data_gap" ? "needs_confirmation" : "normal",
    warning: r.remainingMl === null ? "待初始化：請手動輸入實際剩餘量" : r.quality === "data_gap" ? `${r.name}${low ? ` 庫存上限已低於 ${r.warningThreshold}%；` : "："}有滴定時間資料缺口，剩餘量僅為上限，請人工確認庫存`
      : low ? `${r.name} ${r.quality === "estimated" ? "估算" : "紀錄計算"}庫存低於 ${r.warningThreshold}%，建議補充或確認庫存` : null };
}

export function applyReservoirOperation(reservoir, operation, at) {
  let r = calculateReservoir(reservoir, at);
  const before = reservoirView(r);
  const e = { id: operation.idempotencyKey, type: operation.type, at, source: operation.source || "manual_app" };
  const validMl = (v, allowZero = true) => typeof v === "number" && Number.isFinite(v) && v >= (allowZero ? 0 : 0.000001) && v <= 1000000;
  if (r.deletedAt) throw new Error("RESERVOIR_NOT_FOUND");
  switch (operation.type) {
    case "calibrate":
      if (!validMl(operation.amountMl) || operation.amountMl > r.capacityMl) throw new Error("INVALID_INVENTORY_INPUT");
      e.amountMl = operation.amountMl;
      r.lastManualConfirmedAt = at;
      break;
    case "refill":
      if (r.remainingMl === null || r.quality === "data_gap") throw new Error("INVENTORY_CONFIRMATION_REQUIRED");
      if (!validMl(operation.amountMl, false) || r.remainingMl + operation.amountMl > r.capacityMl + 0.000001) throw new Error("INVENTORY_CAPACITY_EXCEEDED");
      e.amountMl = operation.amountMl;
      r.lastRefilledAt = at;
      break;
    case "capacity":
      if (!validMl(operation.capacityMl, false)) throw new Error("INVALID_INVENTORY_INPUT");
      if (r.remainingMl !== null && operation.capacityMl < r.remainingMl && operation.correctedRemainingMl === undefined) throw new Error("INVENTORY_CONFIRMATION_REQUIRED");
      e.capacityMl = operation.capacityMl;
      r.capacityMl = operation.capacityMl;
      break;
    case "threshold":
      if (!Number.isFinite(operation.warningThreshold) || operation.warningThreshold <= 0 || operation.warningThreshold > 100) throw new Error("INVALID_INVENTORY_INPUT");
      e.warningThreshold = operation.warningThreshold;
      r.warningThreshold = operation.warningThreshold;
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
    r.manualEvents.push({ ...e, type: "calibrate", amountMl: operation.correctedRemainingMl });
    r.lastManualConfirmedAt = at;
  }
  r = calculateReservoir(r, at);
  return { reservoir: r, before, after: reservoirView(r), event: e };
}
