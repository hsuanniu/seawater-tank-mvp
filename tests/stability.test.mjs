import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTank } from "../engines/analysisEngine.js";
import { calculateDosingRecommendation, classify } from "../engines/safetyEngine.js";
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
  return createTankStore({ storageKey, ...options });
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
  const criticalValues = { kh: 10.2, ca: 451, mg: 1451 };

  for (const [parameter, currentValue] of Object.entries(criticalValues)) {
    const statusCode = classify(currentValue, DEFAULT_TANK.targets[parameter], parameter).code;
    const result = calculateDosingRecommendation(dosingInput(parameter, {
      currentValue,
      statusCode,
    }));

    assert.equal(statusCode, "CRITICAL_HIGH", `${parameter} should classify as critical`);
    assert.equal(result.reasonCode, "OUTSIDE_SAFE_CALCULATION_RANGE", parameter);
    assert.equal(result.canApply, false, parameter);
    assert.equal(result.doseChangeMlPerDay, 0, parameter);
  }
});

test("Event recovery mode keeps CA tube repair rises conservative and below high confidence", () => {
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
  assert.equal(ca.reasonCode, "CA_RECOVERY_RISE_SMALL_REDUCE");
  assert.equal(ca.doseChange, -0.1);
  assert.equal(Math.abs(ca.adjustment_percentage) <= 2, true);
  assert.match(ca.warning_message, /長期消耗趨勢/);
});

test("KH low but already rising observes instead of increasing aggressively", () => {
  const result = calculateDosingRecommendation(dosingInput("kh", {
    currentValue: 7.8,
    previousValue: 7.5,
    statusCode: classify(7.8, DEFAULT_TANK.targets.kh, "kh").code,
    trendText: "上升",
  }));

  assert.equal(result.reasonCode, "KH_LOW_BUT_RISING_OBSERVE");
  assert.equal(result.canApply, false);
  assert.equal(result.doseChangeMlPerDay, 0);
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
  assert.equal(result.doseChangeMlPerDay, -0.2);
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
