import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createCloudRepository } from "../server/cloudRepository.js";
import { cloudServerConfig, createReefCloudHandler, MAX_BODY_BYTES } from "../server/cloudHandler.js";
import { createAdminCloudClient } from "../services/adminCloudService.js";
import { deploymentCloudConfig, normalizeAdminCloudConfig } from "../services/cloudConfigService.js";

const ADMIN = "test-admin-password-for-reef-123456789";
const READ = "b".repeat(64);
const API = "https://reef-api.example.com";
const APP = "https://reef.example.com";
let db;
let repository;
let clock;
const sql = async (strings, ...values) => (await db.query(strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""), values)).rows;

function fixture() {
  return { version: 3, activeTankId: "reef-1", tanks: [{
    id: "reef-1", tank: { name: "海水缸", volume: 75 }, dosing: { kh: 11.7, ca: 4, mg: 0.4 },
    records: [{ id: "new", date: "2026-10-14", kh: 7.7, ca: 440, mg: 1350, no3: 1, po4: 0.03 }],
    archivedRecords: [{ id: "old", date: "2025-01-01", kh: 8.2 }], maintenance: [{ id: "water" }],
    doseApplications: [{ id: "dose", oldDose: 11.5, newDose: 11.7 }],
    livestock: [{ id: "fish" }], additives: [{ id: "ab" }], additiveSchedules: [{ id: "weekly" }],
    feedings: [{ id: "food" }], events: [{ id: "repair" }], uiState: { selected: "history" },
  }] };
}

function handler(extra = {}) {
  return createReefCloudHandler({ repository, adminPassword: ADMIN, readToken: READ, appOrigin: APP, publicUrl: API, now: () => clock, ...extra });
}

function request(path, { method = "GET", token, body, origin = APP } = {}) {
  return new Request(`${API}${path}`, { method, headers: {
    ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

async function login(app) {
  const response = await app(request("/api/internal/session", { method: "POST", body: { password: ADMIN } }));
  assert.equal(response.status, 200);
  return response.json();
}

before(async () => { db = new PGlite(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  clock = Date.parse("2026-10-14T02:00:00Z");
  await db.exec("DROP TABLE IF EXISTS reef_controller_sessions; DROP TABLE IF EXISTS reef_controller_state;");
  repository = createCloudRepository(sql, { now: () => clock });
});

test("Admin deployment exposes only the API URL, never passwords or database secrets", () => {
  assert.deepEqual(deploymentCloudConfig({ REEF_CLOUD_API_URL: API, DATABASE_URL: "private-db", REEF_ADMIN_TOKEN: ADMIN, REEF_GPT_READ_TOKEN: READ }), { configured: true, mode: "admin", apiUrl: API });
  assert.deepEqual(deploymentCloudConfig({}, { apiUrl: API, adminPassword: ADMIN }), { configured: true, mode: "admin", apiUrl: API });
  assert.equal(deploymentCloudConfig({ REEF_CLOUD_API_URL: "https://other.example.com" }, { apiUrl: API }).apiUrl, "https://other.example.com");
  for (const apiUrl of ["https://user:secret@api.example.com", "https://api.example.com/?token=secret", "https://api.example.com/api", "http://public.example.com"]) assert.equal(normalizeAdminCloudConfig({ apiUrl }), null);
  assert.throws(() => cloudServerConfig({ REEF_ADMIN_TOKEN: "1234" }));
  assert.throws(() => cloudServerConfig({ REEF_ADMIN_TOKEN: ADMIN, REEF_GPT_READ_TOKEN: ADMIN }));
});

test("A single admin password creates an expiring session; no Email account is needed", async () => {
  const app = handler();
  const status = await (await app(request("/api/internal/session"))).json();
  assert.equal(status.authenticated, false);
  assert.equal(status.libraryId, null);
  assert.equal((await app(request("/api/internal/session", { method: "POST", body: { password: "wrong" } }))).status, 401);
  const session = await login(app);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(session.expiresAt, "2026-10-21T02:00:00.000Z");
  const stored = await db.query("SELECT token_hash FROM reef_controller_sessions");
  assert.notEqual(stored.rows[0].token_hash, session.token);
  assert.equal((await (await app(request("/api/internal/session", { token: session.token }))).json()).authenticated, true);
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await app(request("/api/internal/state", { token: session.token }))).status, 401);
});

test("Admin sessions can be revoked and rotating the management password invalidates old sessions", async () => {
  const app = handler();
  const first = await login(app);
  const second = await login(app);
  assert.equal((await app(request("/api/internal/session", { method: "DELETE", token: first.token }))).status, 200);
  assert.equal((await app(request("/api/internal/state", { token: first.token }))).status, 401);
  assert.equal((await handler({ adminPassword: `${ADMIN}-rotated` })(request("/api/internal/state", { token: second.token }))).status, 401);
});

test("Cloud SQL preserves the entire TankStore and initializes only once, including racing imports", async () => {
  const data = fixture();
  assert.equal(await repository.load(), null);
  await assert.rejects(() => repository.initialize({ tanks: [] }), /INVALID_CLOUD_STATE/);
  const attempts = await Promise.allSettled([repository.initialize(data), repository.initialize(data)]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.match(attempts.find((attempt) => attempt.status === "rejected").reason.message, /CLOUD_ALREADY_INITIALIZED/);
  assert.deepEqual((await repository.load()).data, data);
  const secondRepository = createCloudRepository(sql);
  assert.equal(await secondRepository.libraryId(), await repository.libraryId());
  assert.deepEqual((await secondRepository.load()).data, data);
});

test("Cloud SQL rejects stale revisions and malformed snapshots without changing any records", async () => {
  const original = fixture();
  await repository.initialize(original);
  const changed = structuredClone(original);
  changed.tanks[0].dosing.kh = 12.1;
  const saved = await repository.save(changed, 1);
  assert.equal(saved.revision, 2);
  await assert.rejects(() => repository.save(original, 1), /CLOUD_REVISION_CONFLICT/);
  await assert.rejects(() => repository.save({ tanks: [{ id: "bad", records: "broken" }] }, 2), /INVALID_CLOUD_STATE/);
  await assert.rejects(() => repository.save({ tanks: [changed.tanks[0], changed.tanks[0]] }, 2), /INVALID_CLOUD_STATE/);
  assert.deepEqual((await repository.load()).data, saved.data);
  assert.equal(saved.data.tanks[0].dosingHistory.length, 1);
  assert.equal(saved.data.tanks[0].dosingHistory[0].changeMlPerDay, 0.4);
});

test("Admin API requires management authorization for all writes and returns explicit revision conflicts", async () => {
  const app = handler();
  const data = fixture();
  assert.equal((await app(request("/api/internal/state"))).status, 401);
  assert.equal((await app(request("/api/internal/initialize", { method: "POST", token: READ, body: { data } }))).status, 401);
  const { token } = await login(app);
  assert.equal((await app(request("/api/internal/initialize", { method: "POST", token, body: { data } }))).status, 200);
  assert.equal((await app(request("/api/internal/initialize", { method: "POST", token, body: { data } }))).status, 409);
  assert.equal((await app(request("/api/internal/state", { method: "PUT", token, body: { data, expectedRevision: 1 } }))).status, 200);
  assert.equal((await app(request("/api/internal/state", { method: "PUT", token, body: { data, expectedRevision: 1 } }))).status, 409);
  assert.equal((await app(request("/api/internal/state", { method: "DELETE", token }))).status, 405);
});

test("GPT reads the same cloud snapshot but never receives management permission", async () => {
  const app = handler();
  await repository.initialize(fixture());
  const { token } = await login(app);
  assert.equal((await app(request("/api/gpt/context", { token }))).status, 401);
  const response = await app(request("/api/gpt/context", { token: READ, origin: null }));
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.tank.name, "海水缸");
  assert.equal(context.dosing.kh.configuredMlPerDay, 11.7);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await app(request("/api/gpt/context", { method, token: READ }))).status, 405);
  const schema = await (await app(request("/api/openapi", { origin: null }))).json();
  assert.equal(schema.servers[0].url, `${API}/api/gpt`);
  assert.ok(Object.values(schema.paths).every((path) => Object.keys(path).every((method) => method === "get")));
  assert.equal(JSON.stringify(schema).includes(ADMIN), false);
});

test("Cross-origin access is restricted and API responses cannot be cached", async () => {
  const app = handler();
  assert.equal((await app(request("/api/internal/session", { origin: "https://untrusted.example" }))).status, 403);
  const preflight = await app(request("/api/internal/state", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), APP);
  const response = await app(request("/api/internal/session"));
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
});

test("Invalid JSON, oversized bodies, unavailable configuration and excessive login attempts fail safely", async () => {
  const app = handler();
  assert.equal((await app(request("/api/internal/session", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await app(request("/api/internal/session", { method: "POST", body: " ".repeat(MAX_BODY_BYTES + 1) }))).status, 413);
  assert.equal((await handler({ repository: null })(request("/api/internal/session", { method: "POST", body: { password: ADMIN } }))).status, 503);
  for (let index = 0; index < 21; index += 1) await app(request("/api/internal/session", { method: "POST", body: { password: "wrong" } }));
  assert.equal((await app(request("/api/internal/session", { method: "POST", body: { password: ADMIN } }))).status, 429);
  clock += 16 * 60 * 1000;
  assert.equal((await app(request("/api/internal/session", { method: "POST", body: { password: ADMIN } }))).status, 200);
});

test("Browser stores only an expiring session, survives refresh and signs out without clearing tank data", async () => {
  const app = handler();
  const values = new Map([["seawaterTankMvp.v4", JSON.stringify(fixture())]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const fetchImpl = (url, options) => app(new Request(url, { ...options, headers: { ...options.headers, Origin: APP } }));
  const client = createAdminCloudClient({ apiUrl: API, storage, fetchImpl, now: () => clock });
  assert.equal((await client.getSession()).authenticated, false);
  await assert.rejects(() => client.signIn("wrong"), /INVALID_ADMIN_PASSWORD/);
  await client.signIn(ADMIN);
  assert.equal([...values.values()].join("").includes(ADMIN), false);
  await client.repository.initialize(fixture());
  const reopened = createAdminCloudClient({ apiUrl: API, storage, fetchImpl, now: () => clock });
  assert.equal((await reopened.getSession()).authenticated, true);
  assert.deepEqual((await reopened.repository.load()).data, fixture());
  await reopened.signOut();
  assert.equal((await client.getSession()).authenticated, false);
  assert.ok(values.has("seawaterTankMvp.v4"));
  assert.deepEqual((await repository.load()).data, fixture());
});

test("API failure or expired session never removes the phone's TankStore", async () => {
  const values = new Map([["seawaterTankMvp.v4", JSON.stringify(fixture())]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  let unauthorized = false;
  const app = handler();
  const fetchImpl = (url, options) => app(new Request(url, options));
  const client = createAdminCloudClient({ apiUrl: API, storage, fetchImpl, now: () => clock, onUnauthorized: () => { unauthorized = true; } });
  await client.signIn(ADMIN);
  clock += 8 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => client.repository.load(), /SESSION_EXPIRED/);
  assert.equal(unauthorized, true);
  assert.ok(values.has("seawaterTankMvp.v4"));
});
