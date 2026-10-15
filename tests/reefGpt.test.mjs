import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTank } from "../engines/analysisEngine.js";
import { DEFAULT_TANK } from "../modules/tankModule.js";
import { buildReefGptContext } from "../services/reefGptContextService.js";
import { createReefGptHandler, createSupabaseStateReader, reefGptOpenApi } from "../services/reefGptApiService.js";

const now = new Date("2026-10-08T04:00:00Z");
const baseUrl = "https://example.supabase.co/functions/v1/reef-gpt";
const token = "test-read-only-token-with-more-than-32-characters";

function measurement(id, date, extra = {}) {
  return {
    id, date, kh: 7.7, ca: 440, mg: 1350, no3: 1, po4: 0.03, k: 410,
    measuredFields: { kh: true, ca: true, mg: true, no3: true, po4: true, k: true },
    ...extra,
  };
}

function fixture() {
  return {
    version: 3, activeTankId: "reef-1",
    tanks: [{
      id: "reef-1", tank: { ...DEFAULT_TANK, volume: 75 },
      records: [measurement("last-week", "2026-10-01"), measurement("today", "2026-10-08")],
      archivedRecords: [measurement("archive", "2025-01-01", { kh: 5 })],
      dosing: { kh: 11.7, ca: 4.2, mg: 0.4, aplus: 0.4, kplus: 0.2, status: { kplus: { enabled: false, pausedDays: 0 } } },
      doseApplications: [],
      events: [{ id: "repair", event_type: "CA_tube_air_leak_fixed", affected_element: "ca", start_date: "2026-10-05", recovery_days: 14 }],
      maintenance: [{ date: "2026-10-07", waterChangeCount: 1, waterChangeVolume: 10 }],
      feedings: [{ date: "2026-10-07", timesPerDay: 2, amountLevel: "medium" }],
      additives: [{ date: "2026-10-07", item: "ab-plus", doseMl: 2 }],
      uiState: { secretUiDraft: "not for GPT" },
    }],
  };
}

function context(state = fixture()) {
  return buildReefGptContext({ state, now, cloudUpdatedAt: "2026-10-08T03:30:00Z" });
}

function request(path, options = {}) {
  return new Request(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` }, ...options });
}

test("GPT context uses the existing engine and exposes explicit dates and disabled K+", () => {
  const state = fixture();
  const source = structuredClone(state);
  const result = context(state);
  const data = state.tanks[0];
  const engine = analyzeTank({ ...data });
  assert.equal(result.cloudUpdatedAt, "2026-10-08T03:30:00Z");
  assert.equal(result.latestMeasurement.date, "2026-10-08");
  assert.equal(result.policy.requiresManualConfirmation, true);
  assert.equal(result.policy.readOnly, true);
  assert.equal(result.dosing.kplus.configuredMlPerDay, 0.2);
  assert.equal(result.dosing.kplus.effectiveMlPerDay, 0);
  for (const row of result.recommendations.filter((item) => item.canAdjust)) {
    const expected = engine.rows.find((item) => item.key === row.parameter);
    assert.equal(row.suggestedDoseMlPerDay, expected.newDose);
    assert.equal(row.doseChangeMlPerDay, expected.doseChange);
  }
  assert.deepEqual(state, source, "reading context must not change stored data");
  assert.equal(JSON.stringify(result).includes("secretUiDraft"), false);
  assert.equal(result.referenceFactors.events[0].event_type, "CA_tube_air_leak_fixed");
  assert.equal(result.referenceFactors.maintenance[0].waterChangeVolume, 10);
});

test("GPT excludes archived, expired and future measurements", () => {
  const state = fixture();
  state.tanks[0].records.push(measurement("expired", "2025-01-01"), measurement("future", "2026-12-01"));
  const result = context(state);
  assert.deepEqual(result.recentMeasurements.map((record) => record.id), ["today", "last-week"]);
});

test("Taiwan morning measurements remain current before the UTC date changes", () => {
  const state = fixture();
  state.tanks[0].records[1].date = "2026-10-12";
  state.tanks[0].additives = [{ date: "2026-10-12", item: "ab-plus", doseMl: 2 }];
  const result = buildReefGptContext({ state, now: new Date("2026-10-11T23:00:00Z") });
  assert.equal(result.latestMeasurement.date, "2026-10-12");
  assert.equal(result.freshness.measurementAgeDays, 0);
  assert.equal(result.referenceFactors.additives[0].date, "2026-10-12");
});

test("Inherited values never become a GPT dosing suggestion even when values changed", () => {
  const state = fixture();
  state.tanks[0].records[0].kh = 8.75;
  state.tanks[0].records[1].kh = 8.3;
  state.tanks[0].records[1].measuredFields.kh = false;
  const row = context(state).recommendations.find((item) => item.parameter === "kh");
  assert.equal(row.measured, false);
  assert.equal(row.canAdjust, false);
  assert.equal(row.suggestedDoseMlPerDay, null);
  assert.equal(row.doseChangeMlPerDay, 0);
});

test("An inherited previous value cannot establish a new dosing baseline", () => {
  const state = fixture();
  state.tanks[0].records[0].measuredFields.kh = false;
  const row = context(state).recommendations.find((item) => item.parameter === "kh");
  assert.equal(row.canAdjust, false);
  assert.equal(row.suggestedDoseMlPerDay, null);
});

test("GPT preserves zero-dose, absent baseline, short-interval and critical safety guards", () => {
  for (const scenario of ["zero", "first", "short", "critical", "missing", "stale"]) {
    const state = fixture();
    const data = state.tanks[0];
    if (scenario === "zero") data.dosing.kh = 0;
    if (scenario === "first") data.records.shift();
    if (scenario === "short") data.records[0].date = "2026-10-07";
    if (scenario === "critical") data.records[1].kh = 11;
    if (scenario === "missing") delete data.records[1].kh;
    if (scenario === "stale") {
      data.records[0].date = "2026-08-01";
      data.records[1].date = "2026-08-08";
    }
    const row = context(state).recommendations.find((item) => item.parameter === "kh");
    assert.equal(row.canAdjust, false, scenario);
    assert.equal(row.suggestedDoseMlPerDay, null, scenario);
  }
});

test("GPT never offers nutrient dosing or repeats a recommendation already applied", () => {
  const state = fixture();
  state.tanks[0].doseApplications = [{ parameter: "kh", relatedMeasurementId: "today", appliedAt: now.toISOString() }];
  for (const parameter of ["kh", "k", "no3", "po4"]) {
    const row = context(state).recommendations.find((item) => item.parameter === parameter);
    assert.equal(row.canAdjust, false);
    assert.equal(row.suggestedDoseMlPerDay, null);
  }
});

test("GPT reads only the selected tank and supports legacy state without modifying it", () => {
  const state = fixture();
  state.tanks.push({ ...structuredClone(state.tanks[0]), id: "reef-2", tank: { ...DEFAULT_TANK, name: "第二缸" } });
  const selected = buildReefGptContext({ state, tankId: "reef-2", now });
  assert.equal(selected.tank.name, "第二缸");
  assert.equal(buildReefGptContext({ state, tankId: "missing", now }), null);
  const legacy = context({ ...state.tanks[0], activeTankId: "legacy" });
  assert.equal(legacy.tank.id, "legacy");
});

test("Read-only API authenticates before touching private data and refuses all writes", async () => {
  let reads = 0;
  const handler = createReefGptHandler({ token, ownerUserId: "owner", baseUrl, now: () => now,
    loadOwnedState: async (owner) => { reads += 1; assert.equal(owner, "owner"); return { data: fixture(), updated_at: now.toISOString() }; },
  });
  assert.equal((await handler(request("/context", { headers: {} }))).status, 401);
  assert.equal((await handler(request("/context", { headers: { Authorization: "Bearer wrong" } }))).status, 401);
  assert.equal(reads, 0);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await handler(request("/context", { method }))).status, 405);
  assert.equal((await handler(request("/context?user_id=another-owner"))).status, 400);
  assert.equal(reads, 0);
  const response = await handler(request("/context"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).tank.id, "reef-1");
  assert.equal(reads, 1);
});

test("GPT Actions schema includes an object schemas section and valid production action URLs", () => {
  const apiUrl = "https://reef-tank-cloud.vercel.app/api/gpt";
  const schema = reefGptOpenApi(`${apiUrl}/`);
  assert.equal(schema.servers[0].url, apiUrl);
  assert.ok(schema.components.schemas && typeof schema.components.schemas === "object");
  assert.equal(Array.isArray(schema.components.schemas), false);
  assert.deepEqual(schema.components.securitySchemes.reefReadToken, { type: "http", scheme: "bearer" });
  for (const path of Object.keys(schema.paths)) {
    const url = new URL(`${schema.servers[0].url}${path}`);
    assert.equal(url.origin, "https://reef-tank-cloud.vercel.app");
    assert.ok(url.pathname.startsWith("/api/gpt/"));
  }
});

test("OpenAPI is public but all data operations are authenticated GET requests", async () => {
  const schema = reefGptOpenApi(baseUrl);
  assert.equal(schema.servers[0].url, baseUrl);
  for (const operation of Object.values(schema.paths)) assert.deepEqual(Object.keys(operation), ["get"]);
  assert.deepEqual(schema.security, [{ reefReadToken: [] }]);
  const handler = createReefGptHandler({ token: "", ownerUserId: "", baseUrl, loadOwnedState: () => { throw new Error("must not load"); } });
  assert.equal((await handler(request("/openapi", { headers: {} }))).status, 200);
  assert.equal((await handler(request("/context"))).status, 503);
});

test("API reports absent data and unknown tanks without exposing backend errors", async () => {
  const options = { token, ownerUserId: "owner", baseUrl, now: () => now };
  const empty = createReefGptHandler({ ...options, loadOwnedState: async () => null });
  assert.equal((await empty(request("/context"))).status, 404);
  const normal = createReefGptHandler({ ...options, loadOwnedState: async () => ({ data: fixture() }) });
  assert.equal((await normal(request("/tanks/unknown/context"))).status, 404);
  assert.equal((await normal(request("/tanks"))).status, 200);
  const broken = createReefGptHandler({ ...options, loadOwnedState: () => { throw new Error("secret-backend-value"); } });
  const failure = await broken(request("/context"));
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes("secret-backend-value"), false);
});

test("Supabase reader uses only GET, fixes the owner filter and does not cache", async () => {
  const reader = createSupabaseStateReader({ url: "https://example.supabase.co", serviceKey: "server-only-key",
    fetchImpl: async (url, options) => {
      assert.equal(url.searchParams.get("user_id"), "eq.owner");
      assert.equal(url.searchParams.get("select"), "data,updated_at");
      assert.equal(options.method, "GET");
      assert.equal(options.cache, "no-store");
      return Response.json([{ data: fixture(), updated_at: now.toISOString() }]);
    },
  });
  assert.equal((await reader("owner")).data.activeTankId, "reef-1");
});
