import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createCloudRepository } from "../server/cloudRepository.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";
import { applyReservoirOperation, createReservoir, calculateReservoir, reservoirView, taipeiInventoryDate } from "../engines/reservoirEngine.js";
import { DEFAULT_RESERVOIRS, dosingChanges } from "../modules/reservoirModule.js";
import { reservoirManualHistory } from "../modules/reservoirHistoryModule.js";
import { migrateReservoirHistory } from "../migrations/004_reservoir_history.js";
import { buildReefGptContext, listReefGptTanks } from "../services/reefGptContextService.js";
import { createReefCloudHandler } from "../server/cloudHandler.js";
import { renderReservoirManualHistory } from "../components/reservoirComponent.js";

const start = Date.parse("2026-10-01T00:00:00+08:00");
const day = n => new Date(start + n * 86400000).toISOString();
const dosing = (kh = 20) => ({ kh, ca: 4, mg: 0.4, aplus: 0.4, kplus: 0, status: {} });
const fixture = () => ({ activeTankId: "reef", tanks: [{ id: "reef", tank: { name: "海水缸", volume: 75 }, dosing: dosing(),
  records: [{ id: "test", date: "2026-10-01", kh: 8.3, ca: 430, mg: 1350, no3: 1, po4: 0.03 }] }] });
let db, sql, cloud, inventory, clock;
before(async () => {
  db = new PGlite();
  sql = async (parts, ...values) => (await db.query(parts.reduce((text, part, i) => text + (i ? "$" + i : "") + part, ""), values)).rows;
  sql.query = async (query, values) => (await db.query(query, values)).rows;
});
after(async () => db.close());
beforeEach(async () => {
  await db.exec("DROP TABLE IF EXISTS reservoir_operations, reservoir_alerts, reservoir_transactions, dosing_reservoirs, reef_inventory_revision, reef_inventory_migrations, reef_controller_state, reef_controller_sessions CASCADE");
  clock = start;
  cloud = createCloudRepository(sql, { now: () => clock });
  await cloud.initialize(fixture());
  inventory = createReservoirRepository(sql, cloud, { now: () => clock });
});
const kh = async () => (await inventory.list("reef")).reservoirs.find(r => r.doseKey === "kh");
const operation = (id, type, values, key) => inventory.operate("reef", { reservoirId: id, type, ...values, idempotencyKey: key });
const correct = (r, entry, amountMl, key, reason = "修正誤輸") => operation(r.id, "correct", {
  targetEventId: entry.id, targetType: entry.type, expectedRevisionId: entry.revisionId, amountMl, reason,
}, key);

test("Refill 200 + 1000 = 1200 persists timestamp, amount, provenance and notes without changing dosing", async () => {
  const original = await cloud.load();
  let r = await kh();
  await assert.rejects(operation(r.id, "refill", { amountMl: 1000 }, "uninitialized"), /CONFIRMATION_REQUIRED/);
  await operation(r.id, "calibrate", { amountMl: 200, reason: "實際檢查" }, "baseline");
  const result = await operation(r.id, "refill", { amountMl: 1000, notes: "新瓶 <script>" }, "refill");
  r = result.reservoirs.find(x => x.id === r.id);
  assert.equal(r.remainingMl, 1200);
  assert.equal(r.lastRefilledAmountMl, 1000);
  assert.equal(r.refillHistory.length, 1);
  assert.equal(r.calibrationHistory.length, 1);
  assert.equal(r.refillHistory[0].occurredAt, day(0));
  assert.equal(r.refillHistory[0].beforeMl, 200);
  assert.equal(r.refillHistory[0].afterMl, 1200);
  assert.equal(r.refillHistory[0].beforeQuality, "manually_confirmed");
  assert.equal(r.refillHistory[0].notes, "新瓶 <script>");
  const fresh = createReservoirRepository(sql, createCloudRepository(sql), { now: () => clock });
  assert.deepEqual((await fresh.list("reef")).reservoirs.find(x => x.id === r.id).refillHistory, r.refillHistory);
  assert.deepEqual(await cloud.load(), original);
  const html = renderReservoirManualHistory(r);
  assert.ok(html.includes("&lt;script&gt;") && !html.includes("新瓶 <script>"));
});

test("All defaults use corrected capacity, additions must be positive and overflow is atomic", async () => {
  const rows = (await inventory.list("reef")).reservoirs;
  assert.deepEqual(rows.map(r => r.capacityMl), DEFAULT_RESERVOIRS.map(r => r.capacityMl));
  for (const r of rows) {
    await operation(r.id, "calibrate", { amountMl: 0 }, "init-" + r.doseKey);
    await assert.rejects(operation(r.id, "refill", { amountMl: 0 }, "zero-" + r.doseKey), /CAPACITY_EXCEEDED/);
    await operation(r.id, "refill", { amountMl: r.capacityMl }, "full-" + r.doseKey);
    const before = (await db.query("SELECT count(*)::int AS n FROM reservoir_transactions")).rows[0].n;
    await assert.rejects(operation(r.id, "refill", { amountMl: 1 }, "overflow-" + r.doseKey), /CAPACITY_EXCEEDED/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM reservoir_transactions")).rows[0].n, before);
  }
});

test("Duplicate and simultaneous refill requests persist exactly one addition", async () => {
  const r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  const input = { amountMl: 1000, notes: "same request" };
  const results = await Promise.all([operation(r.id, "refill", input, "same"), operation(r.id, "refill", input, "same")]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await kh()).remainingMl, 1200);
  assert.equal((await kh()).refillHistory.length, 1);
  await assert.rejects(operation(r.id, "refill", { amountMl: 500 }, "same"), /IDEMPOTENCY_KEY_REUSED/);
});

test("Taipei midnight is automatic, time overrides are ignored and the newest refill is first", async () => {
  const r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  clock = Date.parse("2026-10-01T15:59:59Z");
  await operation(r.id, "refill", { amountMl: 10, at: "2000-01-01", date: "2000-01-01" }, "before-midnight");
  clock += 2000;
  await operation(r.id, "refill", { amountMl: 20 }, "after-midnight");
  const history = (await kh()).refillHistory;
  assert.equal(history[0].id, "after-midnight");
  assert.equal(taipeiInventoryDate(Date.parse(history[0].occurredAt)), "2026-10-02");
  const rows = (await db.query("SELECT local_date::text FROM reservoir_transactions WHERE type = 'refill' ORDER BY sequence")).rows;
  assert.deepEqual(rows.map(x => x.local_date), ["2026-10-01", "2026-10-02"]);
});

test("Correction appends immutable history and replays consumption instead of overwriting a balance", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  await operation(r.id, "refill", { amountMl: 1000, notes: "原始" }, "refill");
  clock += 86400000;
  r = await kh();
  assert.equal(r.remainingMl, 1180);
  const result = await correct(r, r.refillHistory[0], 800, "edit");
  r = result.reservoirs.find(x => x.id === r.id);
  assert.equal(r.remainingMl, 980);
  assert.equal(r.refillHistory[0].amountMl, 1000);
  assert.equal(r.refillHistory[0].afterMl, 1200);
  assert.equal(r.refillHistory[0].effectiveAmountMl, 800);
  assert.equal(r.lastRefilledAmountMl, 800);
  assert.equal(r.refillHistory[0].corrections.length, 1);
  assert.equal(r.refillHistory[0].corrections[0].recordedAt, day(1));
  await correct(r, { ...r.refillHistory[0], revisionId: "refill" }, 800, "edit");
  assert.equal((await kh()).refillHistory[0].corrections.length, 1);
  await assert.rejects(correct(r, { ...r.refillHistory[0], revisionId: "refill" }, 700, "stale"), /HISTORY_CONFLICT/);
  await assert.rejects(correct(r, r.refillHistory[0], 1499, "too-much"), /CORRECTION_CONFLICT/);
  assert.equal((await kh()).remainingMl, 980);
});

test("Concurrent corrections cannot overwrite one another and original audit rows remain", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  await operation(r.id, "refill", { amountMl: 1000 }, "refill");
  r = await kh();
  const attempts = await Promise.allSettled([correct(r, r.refillHistory[0], 800, "edit-a"), correct(r, r.refillHistory[0], 700, "edit-b")]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await kh()).refillHistory[0].corrections.length, 1);
  const rows = (await db.query("SELECT type, amount_ml::float FROM reservoir_transactions WHERE type IN ('refill','correct') ORDER BY sequence")).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount_ml, 1000);
});

test("Correcting a depleted baseline recomputes actual historical consumption and preserves later calibration", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 5 }, "baseline");
  clock += 86400000;
  await operation(r.id, "refill", { amountMl: 200 }, "refill");
  clock += 86400000;
  r = await kh();
  await correct(r, r.calibrationHistory[0], 100, "edit-baseline");
  assert.equal((await kh()).remainingMl, 260);
  const rows = (await db.query("SELECT * FROM reservoir_transactions WHERE type = 'consumption_correction'")).rows;
  assert.ok(rows.some(row => row.metadata.source === "manual_history_correction"));
  await operation(r.id, "calibrate", { amountMl: 400, reason: "實際檢查" }, "new-baseline");
  r = await kh();
  await correct(r, r.calibrationHistory.find(e => e.id === "baseline"), 90, "older-edit");
  assert.equal((await kh()).remainingMl, 400);
  assert.equal((await kh()).refillHistory.length, 1);
});

test("Corrections validate superseded historical capacity and roll back on conflict", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  await operation(r.id, "refill", { amountMl: 1000 }, "refill");
  clock += 86400000;
  await operation(r.id, "calibrate", { amountMl: 300 }, "later");
  r = await kh();
  await assert.rejects(correct(r, r.calibrationHistory.find(e => e.id === "baseline"), 1000, "invalid-old-calibration"), /CORRECTION_CONFLICT/);
  assert.equal((await kh()).remainingMl, 300);
  assert.equal((await kh()).calibrationHistory.find(e => e.id === "baseline").corrections.length, 0);
});

test("Rate changes persist once, retain old history and use settings timestamps rather than claiming pump synchronization", async () => {
  let state = await cloud.load();
  state.data.tanks[0].dosing.ca = 4.2;
  clock += 86400000;
  state = await cloud.save(state.data, state.revision);
  const event = state.data.tanks[0].dosingHistory[0];
  assert.equal(event.before.configuredMlPerDay, 4);
  assert.equal(event.after.configuredMlPerDay, 4.2);
  assert.equal(event.changeMlPerDay, 0.2);
  assert.equal(event.recordedAt, day(1));
  assert.equal(event.deviceSynchronizedAt, null);
  assert.equal(event.timingUncertain, true);
  state = await cloud.save(state.data, state.revision);
  assert.equal(state.data.tanks[0].dosingHistory.length, 1);
  delete state.data.tanks[0].dosingHistory;
  state = await cloud.save(state.data, state.revision);
  assert.equal(state.data.tanks[0].dosingHistory.length, 1);
});

test("Timestamped client changes are not duplicated and consumption remains piecewise after restart", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 1000 }, "baseline");
  let state = await cloud.load();
  state.data.tanks[0].dosingHistory = dosingChanges(dosing(20), dosing(10), { at: day(2), createId: () => "change", source: "form" });
  state.data.tanks[0].dosing = dosing(10);
  clock = start + 5 * 86400000;
  state = await cloud.save(state.data, state.revision);
  assert.equal(state.data.tanks[0].dosingHistory.length, 1);
  const restarted = createReservoirRepository(sql, cloud, { now: () => clock });
  r = (await restarted.list("reef")).reservoirs.find(e => e.doseKey === "kh");
  assert.equal(r.remainingMl, 930);
  assert.equal(r.estimatedDaysRemaining, 93);
});

test("GPT includes full manual and dosing histories, measurement time stays separate, and freshwater never leaks", async () => {
  const r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200 }, "baseline");
  await operation(r.id, "refill", { amountMl: 100 }, "refill");
  const data = (await cloud.load()).data;
  data.tanks[0].dosingHistory = Array.from({ length: 150 }, (_, i) => ({ id: String(i), key: "ca", recordedAt: day(-150 + i),
    effectiveAt: day(-150 + i), before: { configuredMlPerDay: 4 }, after: { configuredMlPerDay: 4.2 } }));
  data.tanks.push({ id: "fresh", aquariumType: "freshwater", tank: { name: "不可混入" }, dosing: {}, records: [] });
  const context = buildReefGptContext({ state: data, reservoirs: (await inventory.list("reef")).reservoirs, now: new Date(day(1)) });
  assert.equal(context.dosingHistory.length, 150);
  assert.equal(context.dosingAdjustmentHistory.length, 150);
  assert.equal(context.reservoirInventory.reservoirs[0].refillHistory.length, 1);
  assert.equal(context.reservoirInventory.reservoirs[0].calibrationHistory.length, 1);
  assert.equal(context.latestMeasurement.date, "2026-10-01");
  assert.ok(context.dosingTimingPolicy.includes("不可推定"));
  assert.equal(listReefGptTanks(data).length, 1);
  assert.equal(buildReefGptContext({ state: data, tankId: "fresh" }), null);
  assert.equal(buildReefGptContext({ state: { ...data, activeTankId: "fresh" } }), null);
  const legacyFreshwater = { tank: { waterType: "freshwater" }, dosing: {}, records: [] };
  assert.deepEqual(listReefGptTanks(legacyFreshwater), []);
  assert.equal(buildReefGptContext({ state: legacyFreshwater }), null);
  let state = await cloud.load();
  state.data.tanks.push(data.tanks[1]);
  await cloud.save(state.data, state.revision);
  await assert.rejects(inventory.list("fresh"), /TANK_NOT_FOUND/);
  assert.equal((await inventory.list("reef")).reservoirs.length, 5);
});

test("Zero dosing, missing stock and old ledgers are not fabricated; migration only adds an index", async () => {
  let r = (await inventory.list("reef")).reservoirs.find(e => e.doseKey === "kplus");
  assert.equal(r.remainingMl, null);
  assert.equal(r.refillHistory.length, 0);
  assert.ok(renderReservoirManualHistory(r).includes("尚無添加紀錄"));
  await operation(r.id, "calibrate", { amountMl: 100 }, "zero-dose");
  r = (await inventory.list("reef")).reservoirs.find(e => e.id === r.id);
  assert.equal(r.alertStatus, "not_dosing");
  assert.equal(r.estimatedDaysRemaining, null);
  const before = (await db.query("SELECT * FROM reservoir_transactions ORDER BY sequence")).rows;
  await migrateReservoirHistory(sql);
  await migrateReservoirHistory(sql);
  assert.deepEqual((await db.query("SELECT * FROM reservoir_transactions ORDER BY sequence")).rows, before);
  const legacy = { id: "legacy", tankId: "reef", manualEvents: [{ id: "old", type: "refill", amountMl: 100, at: day(0) }] };
  const history = reservoirManualHistory(legacy, [{ reservoir_id: "legacy", type: "refill", metadata: { id: "old", before: { quality: "estimated" } }, before_ml: 200, after_ml: 300 }]);
  assert.equal(history[0].beforeMl, 200);
  assert.equal(history[0].afterMl, 300);
  assert.equal(history[0].beforeQuality, "estimated");
});

test("Capacity reduction with explicit stock confirmation remains a separate calibration", async () => {
  let r = await kh();
  await operation(r.id, "calibrate", { amountMl: 1200 }, "initial");
  await operation(r.id, "capacity", { capacityMl: 1000, correctedRemainingMl: 900 }, "resize");
  r = await kh();
  assert.equal(r.remainingMl, 900);
  assert.equal(r.refillHistory.length, 0);
  assert.equal(r.calibrationHistory.length, 2);
  assert.equal(r.calibrationHistory[0].beforeMl, 1200);
  assert.equal(r.calibrationHistory[0].afterMl, 900);
  assert.equal(r.calibrationHistory[0].reason, "修改容量時確認實際剩餘量");
});

test("JSONB key order never creates duplicate zero audits, but meaningful zero-stock changes and old records remain", async () => {
  const r = await kh();
  await operation(r.id, "calibrate", { amountMl: 0 }, "empty-baseline");
  clock += 12 * 3600000;
  await inventory.list("reef");
  await db.query(`INSERT INTO reservoir_transactions(id,tank_id,reservoir_id,type,occurred_at,local_date,source,amount_ml,before_ml,after_ml,metadata)
    SELECT 'legacy-zero',tank_id,reservoir_id,'consumption_correction',occurred_at,local_date,source,0,before_ml,after_ml,metadata
    FROM reservoir_transactions WHERE type='consumption' LIMIT 1`);
  const original = (await db.query("SELECT * FROM reservoir_transactions ORDER BY sequence")).rows;
  for (let i = 0; i < 3; i++) assert.equal((await kh()).remainingMl, 0);
  assert.deepEqual((await db.query("SELECT * FROM reservoir_transactions ORDER BY sequence")).rows, original);
  assert.ok((await inventory.history("reef", r.id)).entries.some(entry => entry.id === "legacy-zero"));
  clock += 6 * 3600000;
  await inventory.list("reef");
  const additions = (await db.query("SELECT amount_ml,metadata FROM reservoir_transactions WHERE sequence > $1", [original.at(-1).sequence])).rows;
  assert.equal(additions.length, 1);
  assert.equal(Number(additions[0].amount_ml), 0);
  assert.equal(additions[0].metadata.dailyTotal.demandedMl, 15);
});

test("Existing authenticated API exposes full histories without granting GPT write permissions", async () => {
  const r = await kh();
  await operation(r.id, "calibrate", { amountMl: 200, reason: "量筒確認" }, "initial");
  await operation(r.id, "refill", { amountMl: 1000, notes: "新瓶" }, "add");
  const snapshot = await cloud.load();
  snapshot.data.tanks[0].dosing.ca = 4.2;
  await cloud.save(snapshot.data, snapshot.revision);
  const token = "b".repeat(64), origin = "https://reef.example.com";
  const app = createReefCloudHandler({ repository: cloud, inventory, readToken: token, adminPassword: "a".repeat(32),
    appOrigin: origin, publicUrl: origin, now: () => clock });
  const request = (path, method = "GET", auth = token, body) => new Request(origin + path, {
    method, headers: { Origin: origin, Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await app(request("/api/gpt/context", "GET", "wrong"))).status, 401);
  const response = await app(request("/api/gpt/context"));
  assert.equal(response.status, 200);
  const context = await response.json();
  const bucket = context.reservoirInventory.reservoirs.find(e => e.id === r.id);
  assert.equal(bucket.refillHistory[0].notes, "新瓶");
  assert.equal(bucket.calibrationHistory[0].reason, "量筒確認");
  assert.equal(context.dosingAdjustmentHistory[0].changeMlPerDay, 0.2);
  assert.equal(context.dosingAdjustmentHistory[0].deviceSynchronizedAt, null);
  assert.equal((await app(request("/api/internal/reservoirs/reef/operations", "POST", token,
    { type: "refill", reservoirId: r.id, amountMl: 1, idempotencyKey: "forbidden" }))).status, 401);
  assert.equal((await kh()).refillHistory.length, 1);
});
