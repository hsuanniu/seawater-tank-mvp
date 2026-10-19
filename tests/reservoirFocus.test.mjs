import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { reservoirFocusMessages, renderReservoirFocus } from "../components/reservoirFocusModule.js";
import { evaluateReservoirAvailability } from "../engines/reservoirAlertEngine.js";
import { reservoirDose, dosingChanges } from "../modules/reservoirModule.js";
import { createCloudRepository } from "../server/cloudRepository.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";

const dosing = { kh: 10, ca: 4, mg: 0.4, aplus: 0.4, kplus: 0.2, status: {} };
const row = (key, remainingMl, options = {}, settings = dosing) => {
  const value = { id: key, tankId: "reef", name: key.toUpperCase(), doseKey: key, capacityMl: 1500, remainingMl,
    ...reservoirDose(settings, key), ...options };
  return { ...value, ...evaluateReservoirAvailability(value) };
};
const messages = (rows, options = {}) => reservoirFocusMessages({ tankId: "reef", dosing,
  snapshot: { tankId: "reef", connected: true, result: { reservoirs: rows } }, ...options });

test("Home hides normal inventory even at low percent and preserves the API's custom day thresholds", () => {
  assert.deepEqual(messages([row("mg", 100, { percentage: 6.67 })]), []);
  assert.equal(messages([row("kh", 250)])[0].level, "reminder");
  assert.equal(messages([row("kh", 140)])[0].level, "warning");
  assert.equal(messages([row("kh", 70)])[0].level, "urgent");
  assert.equal(messages([row("kh", 70.001)])[0].level, "warning");
  assert.equal(messages([row("kh", 140.001)])[0].level, "reminder");
  assert.deepEqual(messages([row("kh", 300.001)]), []);
  const custom = { alertThresholds: { reminderDays: 9, warningDays: 4, urgentDays: 1 } };
  assert.equal(messages([row("kh", 50, custom)])[0].level, "reminder");
  assert.deepEqual(messages([row("kh", 100, custom)]), []);
});

test("Urgent and exhausted inventories appear first, merge by severity and sort by unrounded days", () => {
  const result = messages([row("kh", 60), row("ca", 8), row("mg", 0), row("aplus", 4), row("kplus", 5)]);
  assert.deepEqual(result.map(e => e.level), ["urgent", "warning", "reminder"]);
  assert.ok(result[0].text.indexOf("MG") < result[0].text.indexOf("CA"));
  assert.ok(result[0].text.indexOf("CA") < result[0].text.indexOf("KH"));
  assert.match(result[0].text, /MG 滴定液預估耗盡/);
  assert.match(renderReservoirFocus(result, true), /is-urgent/);
  assert.doesNotMatch(renderReservoirFocus(result, false), /is-urgent/);
  assert.match(renderReservoirFocus(result, false), /href="#dosing"/);
  const reserve = messages([row("kh", 5, { bottomReserveMl: 5 })]);
  assert.match(reserve[0].text, /可用量預估耗盡/);
});

test("Zero daily use, disabled dosing and pauses do not produce impending depletion reminders", () => {
  const settings = { ...dosing, kh: 0, status: { ca: { enabled: false }, mg: { pausedDays: 2 } } };
  assert.deepEqual(messages([row("kh", 0, {}, settings), row("ca", 0, {}, settings), row("mg", 0, {}, settings)], { dosing: settings }), []);
});

test("Missing stock, invalid rate, gaps, failed fetches and unsynced rate changes never invent days", () => {
  for (const r of [row("kh", null), row("kh", 100, { remainingIsUpperBound: true }), row("kh", 100, { trackingActive: false })]) {
    const result = messages([r]);
    assert.equal(result[0].level, "needs_confirmation");
    assert.doesNotMatch(result[0].text, /預估耗盡|預估剩 \d/);
  }
  const invalidDose = { ...dosing, kh: "" };
  assert.equal(messages([row("kh", 100, {}, invalidDose)], { dosing: invalidDose })[0].level, "needs_confirmation");
  assert.equal(messages([row("kh", 100)], { dosing: { ...dosing, kh: 20 } })[0].level, "needs_confirmation");
  for (const patch of [{ error: "NETWORK" }, { pending: true }, { connected: false }, { result: null }, { result: {} }]) {
    const result = reservoirFocusMessages({ tankId: "reef", dosing, snapshot: { tankId: "reef", connected: true, result: { reservoirs: [row("kh", 10)] }, ...patch } });
    assert.equal(result[0].level, "needs_confirmation");
    assert.doesNotMatch(result[0].text, /正常|預估耗盡|預估剩 \d/);
  }
});

test("Home uses only the selected tank and safely escapes names in compact links", () => {
  assert.deepEqual(messages([row("kh", 500), row("ca", 0, { tankId: "other", name: "別缸" })]), []);
  assert.doesNotMatch(messages([row("kh", 0)], { tankId: "other" })[0].text, /KH|耗盡/);
  assert.deepEqual(reservoirFocusMessages({ tankId: null }), []);
  const html = renderReservoirFocus(messages([row("kh", 0, { name: "<img onerror=x>" })]), true);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test("Shared repository updates home after refill, calibration and dose changes without re-deducting stock", async () => {
  const db = new PGlite();
  try {
    const sql = async (parts, ...values) => (await db.query(parts.reduce((text, part, i) => text + (i ? "$" + i : "") + part, ""), values)).rows;
    sql.query = async (query, values) => (await db.query(query, values)).rows;
    let clock = Date.parse("2026-10-20T00:00:00+08:00");
    const cloud = createCloudRepository(sql, { now: () => clock });
    const current = { kh: 10, ca: 0, mg: 0, aplus: 0, kplus: 0, status: {} };
    await cloud.initialize({ activeTankId: "reef", tanks: [{ id: "reef", tank: { name: "測試海水缸" }, dosing: current, records: [] }] });
    const inventory = createReservoirRepository(sql, cloud, { now: () => clock });
    const id = (await inventory.list("reef")).reservoirs.find(r => r.doseKey === "kh").id;
    const operation = (type, amountMl, key) => inventory.operate("reef", { reservoirId: id, type, amountMl, idempotencyKey: key });
    const home = result => messages(result.reservoirs, { dosing: current });
    let result = await operation("calibrate", 100, "init");
    assert.equal(home(result)[0].level, result.reservoirs[0].alertStatus);
    assert.equal(home(result)[0].level, "warning");
    result = await operation("refill", 300, "refill");
    assert.deepEqual(home(result), []);
    result = await operation("calibrate", 60, "confirm");
    assert.equal(home(result)[0].level, "urgent");
    clock += 86400000;
    result = await inventory.list("reef");
    assert.equal(result.reservoirs[0].remainingMl, 50);
    const snapshot = await cloud.load();
    const next = { ...current, kh: 20 };
    snapshot.data.tanks[0].dosing = next;
    snapshot.data.tanks[0].dosingHistory = dosingChanges(current, next, { at: new Date(clock).toISOString(), createId: () => "rate-change", source: "test" });
    await cloud.save(snapshot.data, snapshot.revision);
    current.kh = 20;
    result = await inventory.list("reef");
    assert.equal(result.reservoirs[0].remainingMl, 50);
    assert.equal(result.reservoirs[0].estimatedDaysRemaining, 2.5);
    assert.match(home(result)[0].text, /2.5 天/);
    clock += 86400000;
    result = await inventory.list("reef");
    assert.equal(result.reservoirs[0].remainingMl, 30);
    assert.equal(result.reservoirs[0].estimatedDaysRemaining, 1.5);
    const consumption = async () => (await db.query("SELECT COALESCE(SUM(amount_ml),0)::numeric AS total FROM reservoir_transactions WHERE type IN ('consumption','consumption_correction','execution_reconciliation')")).rows[0].total;
    const before = await consumption();
    assert.equal((await inventory.list("reef")).reservoirs[0].remainingMl, 30);
    assert.equal(await consumption(), before);
    assert.equal((await cloud.load()).data.tanks[0].dosing.kh, 20);
  } finally { await db.close(); }
});
