import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createReservoir, calculateReservoir, applyReservoirOperation, reservoirView, ingestDosingHistory } from "../engines/reservoirEngine.js";
import { reservoirDose, dosingChanges } from "../modules/reservoirModule.js";
import { createCloudRepository } from "../server/cloudRepository.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";
import { createReefCloudHandler } from "../server/cloudHandler.js";
import { buildReefGptContext } from "../services/reefGptContextService.js";

const START = "2026-10-01T00:00:00+08:00";
const start = Date.parse(START);
const day = (n) => new Date(start + n * 86400000).toISOString();
const dose = (kh = 20, enabled = true) => ({ kh, status: { kh: { enabled, pausedDays: 0 } } });
function base(amount = 1000, capacityMl = 1000) {
  const r = createReservoir({ id: "kh-reservoir", tankId: "tank-1", name: "KH", doseKey: "kh", capacityMl }, dose(), day(0));
  return applyReservoirOperation(r, { type: "calibrate", amountMl: amount, idempotencyKey: "baseline" }, day(0)).reservoir;
}

test("Null baseline stays uninitialized; ten days consume 200mL, exactly 80% does not warn", () => {
  const empty = createReservoir({ id: "a", tankId: "t", name: "KH", doseKey: "kh", capacityMl: 1000 }, dose(), day(0));
  assert.equal(reservoirView(calculateReservoir(empty, day(10))).remainingMl, null);
  const r = calculateReservoir(base(), day(10));
  assert.equal(r.remainingMl, 800);
  assert.equal(reservoirView(r).percentage, 80);
  assert.equal(reservoirView(r).alertStatus, "normal");
  assert.equal(reservoirView(calculateReservoir(r, day(11))).alertStatus, "low");
  assert.equal(calculateReservoir(r, day(11)).remainingMl, 780);
  assert.deepEqual(calculateReservoir(r, day(10)), r);
});

test("Refill, calibration and consumption on the same Taipei day replay correctly", () => {
  let r = applyReservoirOperation(base(350), { type: "refill", amountMl: 500, idempotencyKey: "fill" }, day(0)).reservoir;
  assert.equal(r.remainingMl, 850);
  r = calculateReservoir(r, day(0.5));
  assert.equal(r.remainingMl, 840);
  r = applyReservoirOperation(r, { type: "calibrate", amountMl: 400, idempotencyKey: "reset" }, day(0.5)).reservoir;
  r = applyReservoirOperation(r, { type: "refill", amountMl: 100, idempotencyKey: "fill2" }, day(0.5)).reservoir;
  assert.equal(calculateReservoir(r, day(1)).remainingMl, 490);
});

test("Timestamped rate and enable changes are piecewise, including late offline history", () => {
  let r = calculateReservoir(base(), day(10));
  const history = [
    { id: "rate", key: "kh", effectiveAt: day(5), before: reservoirDose(dose(), "kh"), after: reservoirDose(dose(10), "kh") },
    { id: "off", key: "kh", effectiveAt: day(7), before: reservoirDose(dose(10), "kh"), after: reservoirDose(dose(10, false), "kh") },
  ];
  r = ingestDosingHistory(r, { dosing: dose(10, false), dosingHistory: history }, day(10), day(10));
  r = calculateReservoir(r, day(10));
  assert.equal(r.remainingMl, 880);
  assert.equal(reservoirView(r).effectiveMlPerDay, 0);
  assert.equal(reservoirView(r).estimatedDaysRemaining, null);
  assert.equal(calculateReservoir(r, day(11)).remainingMl, 880);
});

test("Unknown rate timestamps create explicit gaps and never retroactively deduct at the latest rate", () => {
  const r = calculateReservoir(ingestDosingHistory(base(), { dosing: dose(50) }, day(3), day(3)), day(3));
  assert.equal(r.remainingMl, 1000);
  assert.equal(reservoirView(r).remainingIsUpperBound, true);
  assert.equal(reservoirView(r).estimatedDaysRemaining, null);
  const reset = applyReservoirOperation(r, { type: "calibrate", amountMl: 500, idempotencyKey: "reset" }, day(3)).reservoir;
  assert.equal(calculateReservoir(reset, day(4)).remainingMl, 450);
  assert.notEqual(calculateReservoir(reset, day(4)).quality, "data_gap");
});

test("Capacity never fills a reservoir and reducing below remaining requires explicit correction", () => {
  const r = applyReservoirOperation(base(350), { type: "capacity", capacityMl: 2000, idempotencyKey: "bigger" }, day(0)).reservoir;
  assert.equal(r.remainingMl, 350);
  assert.throws(() => applyReservoirOperation(r, { type: "capacity", capacityMl: 200, idempotencyKey: "smaller" }, day(0)), /CONFIRMATION_REQUIRED/);
  const corrected = applyReservoirOperation(r, { type: "capacity", capacityMl: 200, correctedRemainingMl: 150, idempotencyKey: "confirm" }, day(0)).reservoir;
  assert.equal(corrected.remainingMl, 150);
  assert.equal(corrected.capacityMl, 200);
  assert.throws(() => applyReservoirOperation(r, { type: "refill", amountMl: 2000, idempotencyKey: "overflow" }, day(0)), /CAPACITY_EXCEEDED/);
});

test("A+ and K+ 500mL warn strictly below 400mL; tracking pause and depletion are bounded", () => {
  assert.equal(reservoirView(base(400, 500)).alertStatus, "normal");
  assert.equal(reservoirView(base(399, 500)).alertStatus, "low");
  const paused = applyReservoirOperation(base(50), { type: "tracking", active: false, idempotencyKey: "pause" }, day(1)).reservoir;
  assert.equal(calculateReservoir(paused, day(10)).remainingMl, 30);
  assert.equal(calculateReservoir(base(50), day(10)).remainingMl, 0);
});

test("Complete device execution coverage replaces, not adds to, estimated consumption", () => {
  const estimated = calculateReservoir(base(), day(2));
  const applied = applyReservoirOperation(estimated, { type: "execution", idempotencyKey: "device",
    start: day(0), end: day(2), records: [{ id: "pulse", executedAt: day(1), amountMl: 15 }] }, day(2));
  assert.equal(applied.reservoir.remainingMl, 985);
  assert.equal(applied.after.quality, "actual");
  assert.throws(() => applyReservoirOperation(applied.reservoir, { type: "execution", idempotencyKey: "again", start: day(1), end: day(2), records: [] }, day(2)), /EXECUTION_COVERAGE/);
});

test("Verified device coverage can resolve an unknown schedule interval without inventing rates", () => {
  const gap = calculateReservoir(ingestDosingHistory(base(), { dosing: dose(50) }, day(2), day(2)), day(2));
  assert.equal(gap.quality, "data_gap");
  const actual = applyReservoirOperation(gap, { type: "execution", idempotencyKey: "verified-device",
    start: day(0), end: day(2), records: [{ id: "pulse", executedAt: day(1), amountMl: 35 }] }, day(2)).reservoir;
  assert.equal(actual.quality, "actual");
  assert.equal(actual.remainingMl, 965);
});

let db, sql, cloud, inventory, clock;
before(async () => {
  db = new PGlite();
  sql = async (strings, ...values) => (await db.query(strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""), values)).rows;
  sql.query = async (statement, values = []) => (await db.query(statement, values)).rows;
});
after(async () => { await db.close(); });
beforeEach(async () => {
  clock = start;
  await db.exec("DROP TABLE IF EXISTS reservoir_operations, reservoir_alerts, reservoir_transactions, dosing_reservoirs, reef_inventory_revision, reef_controller_sessions, reef_controller_state CASCADE");
  cloud = createCloudRepository(sql, { now: () => clock });
  inventory = createReservoirRepository(sql, cloud, { now: () => clock });
  await cloud.initialize({ activeTankId: "tank-1", tanks: [{ id: "tank-1", tank: { name: "Reef", volume: 75 }, dosing: dose(), records: [
    { id: "old", date: "2026-09-24", kh: 8.3, ca: 430, mg: 1350 },
    { id: "new", date: "2026-10-01", kh: 8.3, ca: 430, mg: 1350 },
  ] }] });
});

async function kh() { return (await inventory.list("tank-1")).reservoirs.find((r) => r.doseKey === "kh"); }
async function op(id, type, values = {}, key = crypto.randomUUID()) {
  return inventory.operate("tank-1", { reservoirId: id, type, ...values, idempotencyKey: key });
}

test("Migration is additive and repeatable; all five buckets remain null until manually confirmed", async () => {
  const before = await cloud.load();
  const list = await inventory.list("tank-1");
  assert.equal(list.reservoirs.length, 5);
  assert.ok(list.reservoirs.every((r) => r.remainingMl === null && r.alertStatus === "pending_initialization"));
  await inventory.ensureSchema();
  assert.deepEqual(await cloud.load(), before);
});

test("SQL replay is idempotent, concurrent refills are serialized, alert episodes resolve and retrigger", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 1000 });
  clock += 10 * 86400000;
  assert.equal((await kh()).remainingMl, 800);
  await inventory.reconcile();
  assert.equal((await kh()).remainingMl, 800);
  clock += 86400000;
  assert.equal((await kh()).remainingMl, 780);
  assert.equal((await db.query("SELECT * FROM reservoir_alerts WHERE resolved_at IS NULL")).rows.length, 1);
  await inventory.reconcile();
  assert.equal((await db.query("SELECT * FROM reservoir_alerts")).rows.length, 1);
  const refillKey = "stable-refill-key";
  await op(r.id, "refill", { amountMl: 50 }, refillKey);
  await op(r.id, "refill", { amountMl: 50 }, refillKey);
  assert.equal((await kh()).remainingMl, 830);
  await assert.rejects(() => op(r.id, "refill", { amountMl: 20 }, refillKey), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal((await db.query("SELECT * FROM reservoir_alerts WHERE resolved_at IS NULL")).rows.length, 0);
  // Concurrent callers both start from the same revision; one must reload after losing the CAS.
  const a = op(r.id, "refill", { amountMl: 10 });
  const b = op(r.id, "refill", { amountMl: 10 });
  await a;
  await b;
  assert.equal((await kh()).remainingMl, 850);
  clock += 3 * 86400000;
  assert.equal((await kh()).remainingMl, 790);
  assert.equal((await db.query("SELECT * FROM reservoir_alerts")).rows.length, 2);
});

test("Refill 350+500=850, separate water sync leaves manual confirmation timestamp unchanged", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 350 });
  await op(r.id, "refill", { amountMl: 500 });
  const updated = await kh();
  assert.equal(updated.remainingMl, 850);
  const snapshot = await cloud.load();
  snapshot.data.tanks[0].records.push({ id: "water", date: "2026-10-02", kh: 8.2 });
  await cloud.save(snapshot.data, snapshot.revision);
  const reloaded = await kh();
  assert.equal(reloaded.lastManualConfirmedAt, day(0));
  assert.equal(reloaded.remainingMl, 850);
  const history = await inventory.history("tank-1", r.id);
  const refill = history.entries.find((e) => e.type === "refill");
  assert.equal(Number(refill.before_ml), 350);
  assert.equal(Number(refill.after_ml), 850);
  assert.equal(refill.source, "manual_app");
});

test("Inventory operations do not alter dosing; multi-tank scope and deleted defaults stay isolated", async () => {
  const r = await kh();
  const snapshot = await cloud.load();
  snapshot.data.tanks.push({ id: "other", tank: { name: "Other" }, dosing: dose(40), records: [] });
  await cloud.save(snapshot.data, snapshot.revision);
  assert.equal((await inventory.list("other")).reservoirs.length, 5);
  await assert.rejects(() => inventory.operate("other", { reservoirId: r.id, type: "calibrate", amountMl: 300, idempotencyKey: "wrong-tank" }), /RESERVOIR_NOT_FOUND/);
  await op(r.id, "delete");
  assert.equal((await inventory.list("tank-1")).reservoirs.length, 4);
  assert.equal((await inventory.list("other")).reservoirs.length, 5);
  assert.deepEqual((await cloud.load()).data, snapshot.data);
  await op("ignored", "create", { name: "KH new", doseKey: "kh", capacityMl: 2000 }, "create-new");
  await op("ignored", "create", { name: "KH new", doseKey: "kh", capacityMl: 2000 }, "create-new");
  assert.equal((await inventory.list("tank-1")).reservoirs.length, 5);
});

test("GPT context includes all five buckets and warnings without inventing any disallowed dose", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 750 });
  const app = createReefCloudHandler({ repository: cloud, inventory, readToken: "b".repeat(64), adminPassword: "a".repeat(32),
    appOrigin: "https://app.example.com", publicUrl: "https://api.example.com", cronSecret: "cron-private", now: () => clock });
  const req = (path, token) => new Request(`https://api.example.com${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await app(req("/api/internal/reservoirs/tank-1", "b".repeat(64)))).status, 401);
  assert.equal((await app(req("/api/internal/reservoirs/reconcile"))).status, 401);
  assert.equal((await app(req("/api/internal/reservoirs/reconcile", "cron-private"))).status, 200);
  const response = await app(req("/api/gpt/context", "b".repeat(64)));
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.reservoirInventory.reservoirs.length, 5);
  assert.ok(context.reservoirInventory.warnings.some((s) => s.includes("KH")));
  assert.ok(context.recommendations.filter((row) => !row.canAdjust).every((row) => row.suggestedDoseMlPerDay === null));
  assert.equal(context.policy.inventoryCanChangeDosing, false);
  assert.equal(context.latestMeasurement.date, "2026-10-01");
});

test("Dosing change records include explicit previous/new state and enable timestamps", () => {
  const entries = dosingChanges(dose(20), dose(30, false), { at: day(1), createId: () => "event", source: "test" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].before.effectiveMlPerDay, 20);
  assert.equal(entries[0].after.effectiveMlPerDay, 0);
  assert.equal(entries[0].effectiveAt, day(1));
});

test("Persisted rate changes, pause/resume and a process restart use the timestamped timeline", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 1000 });
  let snapshot = await cloud.load();
  clock += 5 * 86400000;
  snapshot.data.tanks[0].dosingHistory = dosingChanges(dose(20), dose(10), { at: day(5), createId: () => "reduce", source: "test" });
  snapshot.data.tanks[0].dosing = dose(10);
  await cloud.save(snapshot.data, snapshot.revision);
  clock += 2 * 86400000;
  assert.equal((await kh()).remainingMl, 880);
  snapshot = await cloud.load();
  snapshot.data.tanks[0].dosingHistory.push(...dosingChanges(dose(10), dose(10, false), { at: day(7), createId: () => "stop", source: "test" }));
  snapshot.data.tanks[0].dosing = dose(10, false);
  await cloud.save(snapshot.data, snapshot.revision);
  clock += 3 * 86400000;
  inventory = createReservoirRepository(sql, cloud, { now: () => clock });
  assert.equal((await kh()).remainingMl, 880);
  assert.equal((await kh()).effectiveMlPerDay, 0);
});

test("Invalid operations roll back all inventory/audit changes and correct capacity preserves traceability", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 350 });
  const before = (await db.query("SELECT * FROM dosing_reservoirs ORDER BY id")).rows;
  const count = (await db.query("SELECT count(*)::integer AS n FROM reservoir_transactions")).rows[0].n;
  await assert.rejects(() => op(r.id, "refill", { amountMl: -5 }), /CAPACITY_EXCEEDED/);
  assert.deepEqual((await db.query("SELECT * FROM dosing_reservoirs ORDER BY id")).rows, before);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM reservoir_transactions")).rows[0].n, count);
  await op(r.id, "capacity", { capacityMl: 200, correctedRemainingMl: 180 });
  assert.equal((await kh()).remainingMl, 180);
  const events = (await inventory.history("tank-1", r.id)).entries;
  assert.equal(events.find((e) => e.type === "capacity").metadata.after.lastManualConfirmedAt, day(0));
});

test("Concurrent duplicate operation returns once, and a revised threshold can resolve an alert", async () => {
  const r = await kh();
  await op(r.id, "calibrate", { amountMl: 350 });
  const a = op(r.id, "refill", { amountMl: 100 }, "same-request");
  const b = op(r.id, "refill", { amountMl: 100 }, "same-request");
  await a; await b;
  assert.equal((await kh()).remainingMl, 450);
  await op(r.id, "threshold", { warningThreshold: 40 });
  assert.equal((await kh()).alertStatus, "normal");
  assert.equal((await db.query("SELECT * FROM reservoir_alerts WHERE resolved_at IS NULL")).rows.length, 0);
});

test("Taipei midnight splits daily usage, and pausedDays never implies an automatic resume", () => {
  const r = calculateReservoir(base(), day(1.5));
  assert.equal(r.dailyConsumption["2026-10-01"].consumedMl, 20);
  assert.equal(r.dailyConsumption["2026-10-02"].consumedMl, 10);
  const paused = { kh: 20, status: { kh: { enabled: true, pausedDays: 2 } } };
  const initial = createReservoir({ id: "paused", tankId: "tank-1", name: "KH", doseKey: "kh", capacityMl: 1000 }, paused, day(0));
  const confirmed = applyReservoirOperation(initial, { type: "calibrate", amountMl: 1000, idempotencyKey: "init" }, day(0)).reservoir;
  assert.equal(calculateReservoir(confirmed, day(10)).remainingMl, 1000);
});

test("GPT reports supply risk only for an actual engine-approved suggestion and never changes that suggestion", () => {
  const records = [{ id: "p", date: "2026-09-24", kh: 8.75, ca: 430, mg: 1350 }, { id: "c", date: "2026-10-01", kh: 8.3, ca: 430, mg: 1350 }];
  const state = { activeTankId: "tank-1", tanks: [{ id: "tank-1", tank: { name: "Reef", volume: 75, targets: { kh: { min: 8, max: 9 } } }, records,
    dosing: { kh: 10.2, ca: 4, mg: 0.4 }, doseApplications: [{ parameter: "kh", appliedAt: "2026-09-20T00:00:00Z", relatedMeasurementId: "older" }] }] };
  const before = buildReefGptContext({ state, now: new Date(day(1)) });
  const r = reservoirView(base(5));
  const after = buildReefGptContext({ state, now: new Date(day(1)), reservoirs: [r] });
  assert.deepEqual(after.recommendations, before.recommendations);
  const approved = after.recommendations.find((row) => row.parameter === "kh");
  assert.equal(approved.canAdjust, true);
  assert.ok(after.reservoirInventory.reservoirs[0].approvedSuggestionInventoryWarning);
  records[1].measuredFields = { kh: false };
  const inherited = buildReefGptContext({ state, now: new Date(day(1)), reservoirs: [r] });
  assert.equal(inherited.reservoirInventory.reservoirs[0].daysAtApprovedSuggestedDose, null);
  assert.equal(inherited.reservoirInventory.reservoirs[0].approvedSuggestionInventoryWarning, null);
});
