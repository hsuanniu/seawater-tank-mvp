import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTank } from "../engines/analysisEngine.js";
import { calculateDosingRecommendation, classify } from "../engines/safetyEngine.js";
import { buildStabilityContext } from "../engines/stabilityEngine.js";
import { createDoseApplicationEntry } from "../modules/dosingModule.js";
import { buildMeasurementRecord } from "../modules/measurementModule.js";
import { DEFAULT_TANK } from "../modules/tankModule.js";
import { parseBackupText, restoreBackupText } from "../services/backupService.js";
import { saveJson } from "../services/storageService.js";
import { createTankStore } from "../services/tankStore.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

class FailingStorage extends MemoryStorage {
  setItem() {
    throw new Error("quota exceeded");
  }
}

function useStorage(storage = new MemoryStorage()) {
  globalThis.localStorage = storage;
  return storage;
}

function createStore(storageKey = "stability-suite", options = {}) {
  const { seedTank = true, ...storeOptions } = options;
  const store = createTankStore({ storageKey, ...storeOptions });
  if (seedTank && store.getState().tanks.length === 0) store.addTank(DEFAULT_TANK.name);
  return store;
}

function completeMeasurement(overrides = {}) {
  return {
    date: "2026-05-08",
    kh: 8.4,
    ca: 405,
    mg: 1350,
    k: 400,
    no3: 1,
    po4: 0.05,
    salinity: 1.026,
    temperature: 25.5,
    ...overrides,
  };
}

function dosingInput(parameter, overrides = {}) {
  const targetRange = DEFAULT_TANK.targets[parameter];
  const currentValue = parameter === "kh" ? 8.2 : parameter === "ca" ? 400 : 1350;
  const previousValue = parameter === "kh" ? 8.4 : parameter === "ca" ? 410 : 1360;
  const statusCode = classify(currentValue, targetRange, parameter).code;
  return {
    parameter,
    currentValue,
    previousValue,
    targetRange,
    currentDoseMlPerDay: 6,
    tankVolumeLiters: 65,
    daysBetweenTests: 7,
    doseStatus: { enabled: true, pausedDays: 0 },
    statusCode,
    trendText: "下降",
    ...overrides,
  };
}

test("Safety Engine keeps zero-dose baselines observe-only", () => {
  const result = calculateDosingRecommendation(dosingInput("kh", { currentDoseMlPerDay: 0 }));

  assert.equal(result.reasonCode, "ZERO_CURRENT_DOSE");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
  assert.equal(result.suggestedDoseMlPerDay, 0);
});

test("Safety Engine refuses a new dose without a previous measurement", () => {
  const result = calculateDosingRecommendation(dosingInput("kh", {
    previousValue: null,
    daysBetweenTests: null,
  }));

  assert.equal(result.reasonCode, "NO_PREVIOUS_RECORD");
  assert.equal(result.canApply, false);
  assert.equal(result.suggestedDoseMlPerDay, 6);
});

test("Safety Engine refuses dose changes when tests are less than two days apart", () => {
  const result = calculateDosingRecommendation(dosingInput("kh", { daysBetweenTests: 1 }));

  assert.equal(result.reasonCode, "TEST_INTERVAL_TOO_SHORT");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
});

test("Analysis Engine excludes inherited values from dosing fine-tuning", () => {
  const records = [
    completeMeasurement({ id: "measured", date: "2026-05-01" }),
    completeMeasurement({
      id: "inherited",
      date: "2026-05-08",
      measuredFields: { kh: false, ca: false, mg: false, k: false, no3: false, po4: false },
    }),
  ];
  const analysis = analyzeTank({
    tank: DEFAULT_TANK,
    records,
    dosing: { kh: 6, ca: 5, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.isMeasured, false);
  assert.equal(kh.reasonCode, "VALUE_CARRIED_FORWARD");
  assert.equal(kh.canApplyRecommendation, false);
  assert.equal(kh.doseChange, 0);
});

test("Safety Engine gives only conservative reminders outside KH, CA, and MG safe ranges", () => {
  const criticalValues = { kh: 10.2, ca: 481, mg: 1451 };

  for (const [parameter, currentValue] of Object.entries(criticalValues)) {
    const statusCode = classify(currentValue, DEFAULT_TANK.targets[parameter], parameter).code;
    const result = calculateDosingRecommendation(dosingInput(parameter, {
      currentValue,
      statusCode,
    }));

    assert.equal(statusCode, "CRITICAL_HIGH", `${parameter} should classify as critical`);
    assert.equal(
      ["OUTSIDE_SAFE_CALCULATION_RANGE", "MG_OBSERVATION_RANGE_EXCEEDED"].includes(result.reasonCode),
      true,
      parameter,
    );
    assert.equal(result.canApply, false, parameter);
    assert.equal(result.doseChangeMlPerDay, 0, parameter);
    assert.equal(result.autoCalculationPaused, true, parameter);
    assert.equal(result.suggestedDoseLabel, "暫不自動計算", parameter);
  }
});

test("MG above observation range pauses auto calculation and asks for manual confirmation", () => {
  const result = calculateDosingRecommendation(dosingInput("mg", {
    currentValue: 1455,
    previousValue: 1440,
    targetRange: DEFAULT_TANK.targets.mg,
    currentDoseMlPerDay: 0.8,
    statusCode: classify(1455, DEFAULT_TANK.targets.mg, "mg").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "MG_CRITICAL_HIGH_RISING_MANUAL_CONFIRM");
  assert.equal(result.action, "CONSIDER_REDUCE");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
  assert.equal(result.autoCalculationPaused, true);
  assert.equal(result.suggestedDoseLabel, "暫不自動計算");
  assert.match(result.reasonText, /請考慮手動降低或暫停 Mg 滴定/);
});

test("Single high values observe without presenting the current dose as a recommendation", () => {
  const result = calculateDosingRecommendation(dosingInput("ca", {
    currentValue: 455,
    previousValue: 430,
    targetRange: DEFAULT_TANK.targets.ca,
    currentDoseMlPerDay: 4,
    statusCode: classify(455, DEFAULT_TANK.targets.ca, "ca").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "SINGLE_HIGH_OBSERVE");
  assert.equal(result.action, "OBSERVE");
  assert.equal(result.canApply, false);
  assert.equal(result.autoCalculationPaused, true);
  assert.equal(result.suggestedDoseLabel, "暫不自動計算");
  assert.match(result.reasonText, /單次偏高/);
});

test("Consecutive high and rising values ask the user to consider reducing manually", () => {
  const result = calculateDosingRecommendation(dosingInput("ca", {
    currentValue: 462,
    previousValue: 455,
    targetRange: DEFAULT_TANK.targets.ca,
    currentDoseMlPerDay: 4,
    statusCode: classify(462, DEFAULT_TANK.targets.ca, "ca").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "CONSECUTIVE_HIGH_RISING_MANUAL_CONFIRM");
  assert.equal(result.action, "CONSIDER_REDUCE");
  assert.equal(result.canApply, false);
  assert.equal(result.autoCalculationPaused, true);
  assert.equal(result.suggestedDoseLabel, "暫不自動計算");
  assert.match(result.reasonText, /連續偏高且上升/);
});

test("Event recovery mode keeps CA tube repair rises observe-only and below high confidence", () => {
  const analysis = analyzeTank({
    tank: DEFAULT_TANK,
    records: [
      completeMeasurement({ id: "before", date: "2026-05-16", ca: 395 }),
      completeMeasurement({ id: "after", date: "2026-05-23", ca: 440 }),
    ],
    dosing: { kh: 6, ca: 5.5, mg: 20, status: {} },
    events: [{
      id: "event-ca-fixed",
      event_type: "CA_tube_air_leak_fixed",
      affected_element: "CA",
      start_date: "2026-05-23",
      recovery_days: 14,
    }],
  });
  const ca = analysis.rows.find((row) => row.key === "ca");

  assert.equal(ca.event_recovery_mode, true);
  assert.equal(ca.affected_element, "ca");
  assert.equal(ca.confidence_score === "low" || ca.confidence_score === "medium", true);
  assert.notEqual(ca.confidence_score, "high");
  assert.equal(ca.reasonCode, "CONSERVATIVE_LIMIT_BELOW_MINIMUM_STEP");
  assert.equal(ca.doseChange, 0);
  assert.equal(ca.canApplyRecommendation, false);
  assert.equal(Math.abs(ca.adjustment_percentage) <= 2, true);
  assert.match(ca.warning_message, /長期消耗趨勢/);
});

test("KH low but already rising observes instead of increasing aggressively", () => {
  const result = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.4,
    previousValue: 7.1,
    statusCode: classify(7.4, DEFAULT_TANK.targets.kh, "kh").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "KH_PRIORITY_LOW_HISTORY_INSUFFICIENT");
  assert.equal(result.action, "KH_PRIORITY");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
});

test("KH low values wait for confirmed trend and observation period before increasing", () => {
  const kh77 = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 7.7,
    targetRange: { min: 8, max: 9 },
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 65,
    statusCode: classify(7.7, { min: 8, max: 9 }, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 2 },
  }));

  assert.equal(kh77.reasonCode, "KH_LOW_STABLE_OBSERVE");
  assert.equal(kh77.action, "OBSERVE");
  assert.equal(kh77.doseChangeMlPerDay, 0);
  assert.equal(kh77.suggestedDoseMlPerDay, 10.9);
  assert.match(kh77.nextAdjustmentCondition, /連續第 3 次低於 8/);
});

test("KH consecutive low count resets after returning to target range", () => {
  const tank = {
    ...DEFAULT_TANK,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
    },
  };
  const analysis = analyzeTank({
    tank,
    records: [
      completeMeasurement({ id: "kh-low-before", date: "2026-06-01", kh: 7.7 }),
      completeMeasurement({ id: "kh-in-target", date: "2026-06-08", kh: 8.1 }),
      completeMeasurement({ id: "kh-low-current", date: "2026-06-15", kh: 7.7 }),
    ],
    dosing: { kh: 10.9, ca: 4, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.khConsecutiveLowCount, 1);
  assert.equal(kh.reasonCode, "KH_DOSE_HISTORY_INSUFFICIENT");
  assert.equal(kh.doseChange, 0);
  assert.equal(kh.newDose, 10.9);
  assert.equal(kh.recommendationMode, "OBSERVE");
});

test("Stability context exposes consecutiveLowCount for formal KH analysis flow", () => {
  const targetRange = { min: 8, max: 9 };
  const records = [
    completeMeasurement({ id: "kh-low-before", date: "2026-06-01", kh: 7.7 }),
    completeMeasurement({ id: "kh-in-target", date: "2026-06-08", kh: 8.1 }),
    completeMeasurement({ id: "kh-low-current", date: "2026-06-15", kh: 7.7 }),
  ];
  const context = buildStabilityContext({
    parameter: "kh",
    currentValue: 7.7,
    previousValue: 8.1,
    targetRange,
    daysBetweenTests: 7,
    records,
  });

  assert.equal(Object.hasOwn(context, "consecutiveLowCount"), true);
  assert.equal(context.consecutiveLowCount, 1);
  assert.equal(context.currentSide, "low");
});

test("KH consecutive low stability rules cover observation period, significant drops, and target return", () => {
  const targetRange = { min: 8, max: 9 };
  const stableTwo = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 7.7,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.7, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 2 },
  }));
  const stableThreeAfterObservation = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 7.7,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.7, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 3 },
    daysSinceLastDoseAdjustment: 7,
  }));
  const firstLow = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.9,
    previousValue: 8.1,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.9, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 1 },
  }));
  const significantDrop = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.6,
    previousValue: 8,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.6, targetRange, "kh").code,
    trendText: "下降",
    stabilityContext: { consecutiveLowCount: 1 },
    daysSinceLastDoseAdjustment: 7,
  }));
  const inObservationPeriod = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 7.7,
    targetRange,
    currentDoseMlPerDay: 11.2,
    tankVolumeLiters: 200,
    statusCode: classify(7.7, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 3 },
    daysSinceLastDoseAdjustment: 3,
  }));
  const backInTarget = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 8,
    previousValue: 7.7,
    targetRange,
    currentDoseMlPerDay: 11.2,
    tankVolumeLiters: 200,
    statusCode: classify(8, targetRange, "kh").code,
    trendText: "上升",
    stabilityContext: { consecutiveLowCount: 0 },
    daysSinceLastDoseAdjustment: 7,
  }));

  assert.equal(stableTwo.suggestedDoseMlPerDay, 10.9);
  assert.equal(stableTwo.doseChangeMlPerDay, 0);
  assert.equal(stableTwo.action, "OBSERVE");
  assert.equal(stableThreeAfterObservation.suggestedDoseMlPerDay, 11.2);
  assert.equal(stableThreeAfterObservation.doseChangeMlPerDay, 0.3);
  assert.equal(stableThreeAfterObservation.action, "INCREASE_SMALL");
  assert.equal(firstLow.suggestedDoseMlPerDay, 10.9);
  assert.equal(firstLow.doseChangeMlPerDay, 0);
  assert.equal(firstLow.action, "OBSERVE");
  assert.equal(significantDrop.suggestedDoseMlPerDay, 11.2);
  assert.equal(significantDrop.doseChangeMlPerDay <= 0.3, true);
  assert.equal(significantDrop.action, "INCREASE_SMALL");
  assert.equal(inObservationPeriod.suggestedDoseMlPerDay, 11.2);
  assert.equal(inObservationPeriod.doseChangeMlPerDay, 0);
  assert.equal(inObservationPeriod.action, "OBSERVE");
  assert.equal(inObservationPeriod.observationDaysRemaining, 4);
  assert.equal(backInTarget.suggestedDoseMlPerDay, 11.2);
  assert.equal(backInTarget.doseChangeMlPerDay, 0);
  assert.equal(backInTarget.action, "MAINTAIN");
  assert.equal(backInTarget.khConsecutiveLowCount, 0);
});

test("KH boundary cases stay conservative and avoid floating point dose artifacts", () => {
  const targetRange = { min: 8, max: 9 };
  const exactThresholdDrop = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 8,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.7, targetRange, "kh").code,
    trendText: "下降",
    stabilityContext: { consecutiveLowCount: 1 },
    daysSinceLastDoseAdjustment: 7,
  }));
  const priorityLow = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.4,
    previousValue: 7.6,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.4, targetRange, "kh").code,
    trendText: "下降",
    stabilityContext: { consecutiveLowCount: 3 },
    daysSinceLastDoseAdjustment: 7,
  }));
  const priorityLowInObservation = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.4,
    previousValue: 7.4,
    targetRange,
    currentDoseMlPerDay: 11.2,
    tankVolumeLiters: 200,
    statusCode: classify(7.4, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 3 },
    daysSinceLastDoseAdjustment: 2,
  }));
  const missingDoseAdjustmentDate = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.7,
    previousValue: 7.7,
    targetRange,
    currentDoseMlPerDay: 10.9,
    tankVolumeLiters: 200,
    statusCode: classify(7.7, targetRange, "kh").code,
    trendText: "持平",
    stabilityContext: { consecutiveLowCount: 3 },
  }));

  assert.equal(exactThresholdDrop.reasonCode, "KH_LOW_STABLE_OBSERVE");
  assert.equal(exactThresholdDrop.doseChangeMlPerDay, 0);
  assert.equal(priorityLow.action, "KH_PRIORITY");
  assert.equal(priorityLow.khDosingStatus, "優先處理");
  assert.equal(priorityLow.suggestedDoseMlPerDay, 11.2);
  assert.equal(priorityLow.doseChangeMlPerDay, 0.3);
  assert.equal(priorityLowInObservation.action, "KH_PRIORITY");
  assert.equal(priorityLowInObservation.suggestedDoseMlPerDay, 11.2);
  assert.equal(priorityLowInObservation.doseChangeMlPerDay, 0);
  assert.equal(missingDoseAdjustmentDate.reasonCode, "KH_DOSE_HISTORY_INSUFFICIENT");
  assert.equal(missingDoseAdjustmentDate.doseChangeMlPerDay, 0);
});

test("MG recovery mode limits changes to one percent and stays below high confidence", () => {
  const result = calculateDosingRecommendation(dosingInput("mg", {
    currentValue: 1400,
    previousValue: 1370,
    currentDoseMlPerDay: 20,
    statusCode: classify(1400, DEFAULT_TANK.targets.mg, "mg").code,
    trendText: "上升",
    recoveryContext: {
      event_recovery_mode: true,
      affected_element: "mg",
      event_type: "MG_tube_replaced",
    },
  }));

  assert.equal(result.event_recovery_mode, true);
  assert.equal(result.confidence_score === "low" || result.confidence_score === "medium", true);
  assert.notEqual(result.confidence_score, "high");
  assert.equal(result.doseChangeMlPerDay, -0.1);
  assert.equal(Math.abs(result.adjustment_percentage) <= 1, true);
});

test("NO3 recovering inside target range stays observe-only and avoids aggressive nutrient advice", () => {
  const result = calculateDosingRecommendation(dosingInput("no3", {
    currentValue: 0.5,
    previousValue: 0.01,
    targetRange: DEFAULT_TANK.targets.no3,
    currentDoseMlPerDay: 0,
    statusCode: classify(0.5, DEFAULT_TANK.targets.no3, "no3").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "NO3_RECOVERING_IN_SAFE_RANGE");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
  assert.match(result.reasonText, /優先觀察/);
});

test("Stable Lock keeps the real-world stable case unchanged", () => {
  const records = [
    completeMeasurement({
      id: "stable-before",
      date: "2026-06-01",
      kh: 7.7,
      ca: 440,
      mg: 1395,
      k: 410,
      no3: 1,
      po4: 0.03,
    }),
    completeMeasurement({
      id: "stable-current",
      date: "2026-06-08",
      kh: 7.7,
      ca: 440,
      mg: 1395,
      k: 410,
      no3: 1,
      po4: 0.03,
      measuredFields: { kh: true, ca: true, mg: true, k: false, no3: true, po4: true },
    }),
  ];
  const analysis = analyzeTank({
    tank: { ...DEFAULT_TANK, volume: 65 },
    records,
    dosing: {
      kh: 10.3,
      ca: 4,
      mg: 0.8,
      aplus: 0.4,
      kplus: 0,
      status: {
        kh: { enabled: true, pausedDays: 0 },
        ca: { enabled: true, pausedDays: 0 },
        mg: { enabled: true, pausedDays: 0 },
        aplus: { enabled: true, pausedDays: 0 },
        kplus: { enabled: false, pausedDays: 0 },
      },
    },
  });

  for (const parameter of ["ca", "mg"]) {
    const row = analysis.rows.find((item) => item.key === parameter);
    assert.equal(row.reasonCode, "STABLE_LOCK_MAINTAIN", parameter);
    assert.equal(row.doseChange, 0, parameter);
    assert.equal(row.newDose, row.currentDose, parameter);
    assert.equal(row.canApplyRecommendation, false, parameter);
  }

  assert.equal(analysis.rows.find((row) => row.key === "kh").reasonCode, "KH_IN_TARGET_MAINTAIN");
  assert.equal(analysis.rows.find((row) => row.key === "kh").doseChange, 0);
  assert.equal(analysis.rows.find((row) => row.key === "kh").newDose, 10.3);
  assert.equal(analysis.rows.find((row) => row.key === "ca").newDose, 4);
  assert.equal(analysis.rows.find((row) => row.key === "mg").newDose, 0.8);
  assert.equal(analysis.rows.find((row) => row.key === "no3").reasonCode, "STABLE_IN_RANGE");
  assert.equal(analysis.rows.find((row) => row.key === "po4").reasonCode, "STABLE_IN_RANGE");
  assert.equal(analysis.rows.find((row) => row.key === "k").reasonCode, "VALUE_CARRIED_FORWARD");
});

test("KH inside target range maintains even when the weekly trend is downward", () => {
  const tank = {
    ...DEFAULT_TANK,
    volume: 200,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
    },
  };
  const analysis = analyzeTank({
    tank,
    records: [
      completeMeasurement({ id: "kh-before", date: "2026-06-01", kh: 8.75 }),
      completeMeasurement({ id: "kh-current", date: "2026-06-08", kh: 8.3 }),
    ],
    dosing: { kh: 10.2, ca: 4, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.reasonCode, "KH_IN_TARGET_MAINTAIN");
  assert.equal(kh.recommendationMode, "MAINTAIN");
  assert.equal(kh.doseChange, 0);
  assert.equal(kh.newDose, 10.2);
  assert.equal(kh.canApplyRecommendation, false);
  assert.match(kh.recommendationReason, /位於目標區間/);
});

test("KH remains unchanged after two consecutive drops inside target range", () => {
  const tank = {
    ...DEFAULT_TANK,
    volume: 200,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
    },
  };
  const analysis = analyzeTank({
    tank,
    records: [
      completeMeasurement({ id: "kh-first", date: "2026-06-01", kh: 8.75 }),
      completeMeasurement({ id: "kh-second", date: "2026-06-08", kh: 8.55 }),
      completeMeasurement({ id: "kh-third", date: "2026-06-15", kh: 8.3 }),
    ],
    dosing: { kh: 10.2, ca: 4, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.reasonCode, "KH_IN_TARGET_MAINTAIN");
  assert.equal(kh.doseChange, 0);
  assert.equal(kh.newDose, 10.2);
});

test("KH in-range trend keeps nano tanks unchanged", () => {
  const tank = {
    ...DEFAULT_TANK,
    volume: 65,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
    },
  };
  const analysis = analyzeTank({
    tank,
    records: [
      completeMeasurement({ id: "nano-kh-before", date: "2026-06-01", kh: 8.75 }),
      completeMeasurement({ id: "nano-kh-current", date: "2026-06-08", kh: 8.3 }),
    ],
    dosing: { kh: 10.2, ca: 4, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.reasonCode, "KH_IN_TARGET_MAINTAIN");
  assert.equal(kh.doseChange, 0);
  assert.equal(kh.newDose, 10.2);
});

test("KH inside target range maintains when movement is small and not a confirmed trend", () => {
  const tank = {
    ...DEFAULT_TANK,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
    },
  };
  const analysis = analyzeTank({
    tank,
    records: [
      completeMeasurement({ id: "kh-before-small", date: "2026-06-01", kh: 8.75 }),
      completeMeasurement({ id: "kh-current-small", date: "2026-06-08", kh: 8.5 }),
    ],
    dosing: { kh: 10.2, ca: 4, mg: 1, status: {} },
  });
  const kh = analysis.rows.find((row) => row.key === "kh");

  assert.equal(kh.reasonCode, "KH_IN_TARGET_MAINTAIN");
  assert.equal(kh.doseChange, 0);
  assert.equal(kh.canApplyRecommendation, false);
});

test("Stable Lock also protects stable values when an older saved target range remains", () => {
  const legacyTank = {
    ...DEFAULT_TANK,
    volume: 65,
    targets: {
      ...DEFAULT_TANK.targets,
      kh: { min: 8, max: 9 },
      ca: { min: 380, max: 420 },
      mg: { min: 1320, max: 1380 },
    },
  };
  const analysis = analyzeTank({
    tank: legacyTank,
    records: [
      completeMeasurement({ id: "legacy-before", date: "2026-06-01", kh: 7.7, ca: 440, mg: 1395 }),
      completeMeasurement({ id: "legacy-current", date: "2026-06-08", kh: 7.7, ca: 440, mg: 1395 }),
    ],
    dosing: { kh: 10.3, ca: 4, mg: 0.8, status: {} },
  });

  const kh = analysis.rows.find((item) => item.key === "kh");
  assert.equal(kh.reasonCode, "KH_LOW_STABLE_OBSERVE");
  assert.equal(kh.doseChange, 0);

  for (const parameter of ["ca", "mg"]) {
    const row = analysis.rows.find((item) => item.key === parameter);
    assert.equal(row.reasonCode, "STABLE_LOCK_MAINTAIN", parameter);
    assert.equal(row.doseChange, 0, parameter);
  }
});

test("CA high readings avoid automatic dose changes and escalate by trend", () => {
  const firstAnalysis = analyzeTank({
    tank: DEFAULT_TANK,
    records: [
      completeMeasurement({ id: "ca-normal", date: "2026-06-01", ca: 440 }),
      completeMeasurement({ id: "ca-first-high", date: "2026-06-08", ca: 460 }),
    ],
    dosing: { kh: 6, ca: 4, mg: 1, status: {} },
  });
  const firstHigh = firstAnalysis.rows.find((row) => row.key === "ca");

  assert.equal(firstHigh.reasonCode, "SINGLE_HIGH_OBSERVE");
  assert.equal(firstHigh.doseChange, 0);
  assert.equal(firstHigh.autoCalculationPaused, true);

  const confirmedAnalysis = analyzeTank({
    tank: DEFAULT_TANK,
    records: [
      completeMeasurement({ id: "ca-normal", date: "2026-05-25", ca: 440 }),
      completeMeasurement({ id: "ca-first-high", date: "2026-06-01", ca: 460 }),
      completeMeasurement({ id: "ca-second-high", date: "2026-06-08", ca: 461 }),
    ],
    dosing: { kh: 6, ca: 4, mg: 1, status: {} },
  });
  const confirmedHigh = confirmedAnalysis.rows.find((row) => row.key === "ca");

  assert.equal(confirmedHigh.reasonCode, "CONSECUTIVE_HIGH_RISING_MANUAL_CONFIRM");
  assert.equal(confirmedHigh.doseChange, 0);
  assert.equal(confirmedHigh.autoCalculationPaused, true);
});

test("KH low analysis does not auto-increase without a confirmed dose observation age", () => {
  const records = [
    completeMeasurement({ id: "kh-before", date: "2026-06-01", kh: 7.8 }),
    completeMeasurement({ id: "kh-current", date: "2026-06-08", kh: 7.3 }),
  ];
  const largeTank = analyzeTank({
    tank: { ...DEFAULT_TANK, volume: 200 },
    records,
    dosing: { kh: 10, ca: 4, mg: 1, status: {} },
  }).rows.find((row) => row.key === "kh");
  const nanoTank = analyzeTank({
    tank: { ...DEFAULT_TANK, volume: 65 },
    records,
    dosing: { kh: 10, ca: 4, mg: 1, status: {} },
  }).rows.find((row) => row.key === "kh");
  const recentLargeWaterChange = analyzeTank({
    tank: { ...DEFAULT_TANK, volume: 200 },
    records,
    dosing: { kh: 10, ca: 4, mg: 1, status: {} },
    maintenance: [{
      date: "2026-06-06",
      waterChangeCount: 1,
      waterChangeVolume: 50,
    }],
  }).rows.find((row) => row.key === "kh");

  assert.equal(largeTank.reasonCode, "KH_PRIORITY_LOW_HISTORY_INSUFFICIENT");
  assert.equal(largeTank.doseChange, 0);
  assert.equal(nanoTank.reasonCode, "KH_PRIORITY_LOW_HISTORY_INSUFFICIENT");
  assert.equal(nanoTank.doseChange, 0);
  assert.equal(recentLargeWaterChange.observe_mode, true);
  assert.equal(recentLargeWaterChange.doseChange, 0);
});

test("Tank Store records recovery events without breaking existing tank data", () => {
  useStorage();
  const store = createStore("recovery-event");
  store.addEvent({
    event_type: "CA_tube_air_leak_fixed",
    affected_element: "CA",
    start_date: "2026-05-23",
    recovery_days: 14,
  });
  const event = store.serializeState().tanks[0].events[0];

  assert.equal(event.event_type, "CA_tube_air_leak_fixed");
  assert.equal(event.affected_element, "CA");
  assert.equal(event.recovery_days, 14);
  assert.equal(store.serializeState().tanks[0].records.length, 0);
});

test("Tank Store starts empty and persists the last selected tank", () => {
  useStorage();
  const store = createStore("empty-first-run", { seedTank: false });

  assert.equal(store.getState().tanks.length, 0);
  assert.equal(store.getState().activeTankId, null);

  const first = store.addTank("Nano 海水缸");
  const second = store.addTank("SPS 主缸");
  store.setActiveTank(first.id);

  const reloaded = createTankStore({ storageKey: "empty-first-run" });
  assert.equal(reloaded.getState().tanks.length, 2);
  assert.equal(reloaded.getState().activeTankId, first.id);
  assert.equal(reloaded.getActiveTank().tank.name, "Nano 海水缸");
  assert.equal(second.tank.name, "SPS 主缸");
});

test("Measurement Store updates same-date records instead of creating duplicates", () => {
  useStorage();
  const store = createStore("same-date");
  const first = store.upsertMeasurementByDate(completeMeasurement({ kh: 8.1 }));
  const second = store.upsertMeasurementByDate(completeMeasurement({ kh: 8.6 }));

  assert.equal(first.mode, "created");
  assert.equal(second.mode, "updated");
  assert.equal(store.getMeasurements().length, 1);
  assert.equal(store.getMeasurements()[0].id, first.record.id);
  assert.equal(store.getMeasurements()[0].kh, 8.6);
});

test("Retention cleanup moves records older than six months into archive", () => {
  useStorage();
  const store = createStore("retention-six-months");
  store.upsertMeasurementByDate(completeMeasurement({ date: "2025-11-20", kh: 7.9 }));
  store.upsertMeasurementByDate(completeMeasurement({ date: "2026-05-21", kh: 8.4 }));

  assert.equal(store.getMeasurements().length, 1);
  assert.equal(store.getMeasurements()[0].date, "2026-05-21");
  assert.equal(store.getArchivedMeasurements().length, 1);
  assert.equal(store.getArchivedMeasurements()[0].date, "2025-11-20");
});

test("Retention cleanup keeps at most fifty active records and archives the older overflow", () => {
  useStorage();
  const store = createStore("retention-fifty");
  for (let index = 1; index <= 55; index += 1) {
    const date = new Date(Date.UTC(2026, 3, index)).toISOString().slice(0, 10);
    store.upsertMeasurementByDate(completeMeasurement({ date, kh: 8 + index / 100 }));
  }

  assert.equal(store.getMeasurements().length, 50);
  assert.equal(store.getArchivedMeasurements().length, 5);
  assert.equal(store.getMeasurements()[0].date, "2026-04-06");
  assert.equal(store.getArchivedMeasurements()[0].date, "2026-04-01");
});

test("Archived records do not participate in dosing analysis", () => {
  useStorage();
  const store = createStore("archive-not-analysis");
  store.replaceState({
    version: 3,
    activeTankId: "tank-1",
    tanks: [{
      id: "tank-1",
      tank: DEFAULT_TANK,
      dosing: { kh: 6, ca: 5, mg: 1, status: {} },
      records: [
        completeMeasurement({ id: "active-1", date: "2026-05-01", kh: 8.2 }),
        completeMeasurement({ id: "active-2", date: "2026-05-08", kh: 8.3 }),
      ],
      archivedRecords: [
        completeMeasurement({ id: "archived-future", date: "2026-06-01", kh: 10.5 }),
      ],
      maintenance: [],
    }],
  });
  const analysis = analyzeTank({
    tank: store.getTank(),
    records: store.getMeasurements(),
    dosing: store.getDosing(),
  });

  assert.equal(analysis.latest.id, "active-2");
  assert.equal(analysis.latest.kh, 8.3);
});

test("Archived records remain until the user explicitly clears archive", () => {
  useStorage();
  const store = createStore("clear-archive");
  store.upsertMeasurementByDate(completeMeasurement({ date: "2025-11-20" }));
  assert.equal(store.getArchivedMeasurements().length, 1);

  const result = store.clearArchivedMeasurements();

  assert.equal(result.deletedCount, 1);
  assert.equal(store.getArchivedMeasurements().length, 0);
});

test("Tank Store keeps the final tank and refuses destructive deletion", () => {
  useStorage();
  const store = createStore("last-tank");
  const onlyTankId = store.getState().activeTankId;
  const result = store.deleteTank(onlyTankId);

  assert.equal(result.deleted, false);
  assert.equal(result.reason, "LAST_TANK");
  assert.equal(store.getState().tanks.length, 1);
  assert.equal(store.getState().activeTankId, onlyTankId);
});

test("Tank Store deletes the active tank data and switches to another tank", () => {
  useStorage();
  const store = createStore("delete-active-tank");
  const firstTankId = store.getState().activeTankId;
  const secondTank = store.addTank("刪除測試缸");
  store.upsertMeasurementByDate(completeMeasurement({ date: "2026-05-21" }));
  store.updateDosing({ kh: 6.6 });
  store.addFeeding({ date: "2026-05-21", amountLevel: "中" });
  store.addAdditive({ date: "2026-05-21", item: "red-sea-ab-plus" });
  store.addEvent({ date: "2026-05-21", type: "manual" });
  const result = store.deleteTank(secondTank.id);
  const snapshot = store.serializeState();

  assert.equal(result.deleted, true);
  assert.equal(snapshot.activeTankId, firstTankId);
  assert.equal(snapshot.tanks.length, 1);
  assert.equal(snapshot.tanks.some((tank) => tank.id === secondTank.id), false);
  assert.equal(store.getMeasurements().length, 0);
  assert.equal(store.getDosing().kh, 0);
});

test("Backdated blank measurements cannot inherit from a future record", () => {
  const result = buildMeasurementRecord(
    { date: "2026-05-01" },
    [completeMeasurement({ date: "2026-05-08" })],
    { fallbackDate: "2026-05-01" },
  );

  assert.equal(result.error, "找不到這個日期可沿用的上一筆水質資料，請補上本次測量值。");
});

test("Later blank measurements inherit the prior record and mark inherited fields", () => {
  const result = buildMeasurementRecord(
    { date: "2026-05-15" },
    [completeMeasurement({ date: "2026-05-08", kh: 8.3 })],
    { fallbackDate: "2026-05-15", labels: { kh: "KH" } },
  );

  assert.equal(result.record.kh, 8.3);
  assert.equal(result.record.measuredFields.kh, false);
  assert.equal(result.record.measuredFields.po4, false);
  assert.ok(result.carriedFields.includes("KH"));
});

test("Backup parser rejects invalid JSON and invalid backup structure", () => {
  assert.equal(parseBackupText("{not-json").status, "INVALID_JSON");
  assert.equal(parseBackupText(JSON.stringify({ tanks: [{ id: "tank" }] })).status, "INVALID_STRUCTURE");
});

test("Backup restore asks for confirmation before replacing state", () => {
  const backup = JSON.stringify({
    version: 3,
    activeTankId: "tank-1",
    tanks: [{ id: "tank-1", tank: { name: "Backup" }, records: [], maintenance: [] }],
  });
  let confirmations = 0;
  let replacements = 0;
  const result = restoreBackupText(backup, {
    confirmRestore: () => {
      confirmations += 1;
      return false;
    },
    replaceState: () => {
      replacements += 1;
    },
  });

  assert.equal(result.status, "CANCELLED");
  assert.equal(confirmations, 1);
  assert.equal(replacements, 0);
});

test("Backup restore does not replace state for invalid input", () => {
  let confirmations = 0;
  let replacements = 0;
  const options = {
    confirmRestore: () => {
      confirmations += 1;
      return true;
    },
    replaceState: () => {
      replacements += 1;
    },
  };

  assert.equal(restoreBackupText("invalid", options).status, "INVALID_JSON");
  assert.equal(restoreBackupText(JSON.stringify({ tanks: [] }), options).status, "INVALID_STRUCTURE");
  assert.equal(confirmations, 0);
  assert.equal(replacements, 0);
});

test("Backup restore hydrates a complete TankStore snapshot", () => {
  useStorage();
  const source = createStore("backup-source");
  source.updateDosing({ kh: 6.6 });
  source.upsertMeasurementByDate(completeMeasurement({ id: "stored-record" }));
  source.addTank("第二缸");
  const backupText = JSON.stringify(source.serializeState());

  useStorage();
  const restored = createStore("backup-target");
  const result = restoreBackupText(backupText, {
    confirmRestore: () => true,
    replaceState: (state) => restored.replaceState(state),
  });
  const snapshot = restored.serializeState();

  assert.equal(result.status, "RESTORED");
  assert.equal(snapshot.tanks.length, 2);
  assert.equal(snapshot.tanks[0].records.length, 1);
  assert.equal(snapshot.tanks[0].dosing.kh, 6.6);
  assert.equal(snapshot.activeTankId, source.serializeState().activeTankId);
});

test("Applied dosing logs keep traceability fields in TankStore", () => {
  useStorage();
  const store = createStore("dose-apply");
  store.addDoseApplication(createDoseApplicationEntry({
    appliedAt: "2026/5/21 12:00:00",
    relatedMeasurementId: "measurement-1",
    parameter: "kh",
    label: "KH",
    oldDose: 6.6,
    newDose: 6.8,
    changeAmount: 0.2,
    reasonCode: "NORMAL_NEAR_LOW_TREND_DOWN",
    reason: "KH 小幅下降",
  }));
  const application = store.serializeState().tanks[0].doseApplications[0];

  assert.equal(application.parameter, "kh");
  assert.equal(application.oldDose, 6.6);
  assert.equal(application.newDose, 6.8);
  assert.equal(application.changeAmount, 0.2);
  assert.equal(application.appliedAt, "2026/5/21 12:00:00");
  assert.equal(application.relatedMeasurementId, "measurement-1");
  assert.equal(application.reason, "KH 小幅下降");
});

test("Storage failures return false and trigger the TankStore UI warning hook", () => {
  useStorage(new FailingStorage());
  let uiWarning = "";
  const store = createStore("write-failure", {
    onPersistError: () => {
      uiWarning = "本機儲存失敗";
    },
  });

  assert.equal(saveJson("direct-write", { ok: true }), false);
  assert.equal(store.persist(), false);
  assert.equal(uiWarning, "本機儲存失敗");
});
