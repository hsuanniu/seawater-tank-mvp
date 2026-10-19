import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpAuthRepository } from "../server/mcpAuthRepository.js";
import { createMcpAuthProvider } from "../server/mcpAuthProvider.js";
import { createReefMcpApp } from "../server/reefMcpServer.js";
import { createReefCloudHandler } from "../server/cloudHandler.js";
import { createCloudRepository } from "../server/cloudRepository.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";

const ADMIN = "mcp-test-admin-password-no-real-credentials";
const READ = "mcp-test-read-token-no-real-credentials-123";
const REDIRECT = "https://chatgpt.com/connector/oauth/reef-test";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
let db, sql, store, http, app, base, clock, loadCount;
const data = { version: 3, activeTankId: "reef-1", tanks: [{ id: "reef-1", tank: { name: "測試海水缸", volume: 75 },
  dosing: { kh: 12.4, ca: 4, mg: 0.6, aplus: 0.4, kplus: 0.3, status: { kplus: { enabled: false, pausedDays: 0 } } },
  records: [{ id: "before", date: "2026-10-05", kh: 8.45, ca: 435, mg: 1320, no3: 0.2, po4: 0.03 },
    { id: "latest", date: "2026-10-12", kh: 8.45, ca: 435, mg: 1320, no3: 0.2, po4: 0.03, measuredFields: { ca: false } }],
}] };
const snapshot = () => ({ data: structuredClone(data), revision: 3, updated_at: "2026-10-15T06:14:00.000Z" });

before(async () => {
  db = new PGlite();
  sql = async (parts, ...values) => (await db.query(parts.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""), values)).rows;
  sql.query = async (text, values) => (await db.query(text, values)).rows;
  store = createMcpAuthRepository(sql, { now: () => clock });
  await store.ensureSchema();
  http = createServer((req, res) => app(req, res));
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  if (http?.listening) await new Promise((resolve) => http.close(resolve));
  await db?.close();
});
beforeEach(async () => {
  clock = Date.now(); loadCount = 0;
  await db.exec("TRUNCATE reef_mcp_auth_records");
  app = createReefMcpApp({ authStore: store, repository: { load: async () => { loadCount++; return snapshot(); } },
    adminPassword: ADMIN, readToken: READ, publicUrl: base, now: () => clock });
});

async function post(path, body, extra = {}) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams(body), redirect: "manual" });
}
async function register(overrides = {}) {
  const response = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Reef test", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...overrides }) });
  return { response, body: await response.json() };
}
async function begin(clientId, overrides = {}) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", scope: "reef:read", state: "test-state", resource: `${base}/api/mcp`, ...overrides });
  const response = await fetch(`${base}/authorize?${params}`, { redirect: "manual" });
  const html = await response.text();
  const ticket = html.match(/name="consent_ticket" value="([A-Za-z0-9_-]+)"/)?.[1];
  return { response, params: Object.fromEntries(params), html, ticket, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
}
async function approve(flow, overrides = {}, headers = {}) {
  return post("/authorize", { ...flow.params, consent_ticket: flow.ticket, password: ADMIN, decision: "allow", ...overrides }, { Origin: base, Cookie: flow.cookie, ...headers });
}
async function authorize(clientId) {
  const flow = await begin(clientId);
  assert.ok(flow.ticket);
  const response = await approve(flow);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get("location"));
  assert.equal(url.searchParams.get("state"), "test-state");
  return url.searchParams.get("code");
}
async function exchange(clientId, code, overrides = {}) {
  const response = await post("/token", { client_id: clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${base}/api/mcp`, ...overrides });
  return { response, body: await response.json() };
}
async function tokens() {
  const client = (await register()).body;
  const result = await exchange(client.client_id, await authorize(client.client_id));
  assert.equal(result.response.status, 200);
  return { ...result.body, clientId: client.client_id };
}
const provider = (password = ADMIN) => createMcpAuthProvider({ store, adminPassword: password, readToken: READ, publicUrl: base, now: () => clock });

test("MCP advertises OAuth discovery, rejects anonymous/original credentials and never reads data before authentication", async () => {
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`)).json();
  assert.equal(metadata.resource, `${base}/api/mcp`);
  assert.deepEqual(metadata.scopes_supported, ["reef:read"]);
  const issuer = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(issuer.code_challenge_methods_supported, ["S256"]);
  for (const token of [null, READ, ADMIN, "unknown"]) {
    const response = await fetch(`${base}/api/mcp`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate").includes("resource_metadata="));
  }
  assert.equal(loadCount, 0);
});

test("Consent requires the original password, same-origin CSRF cookie and unchanged request binding", async () => {
  const client = (await register()).body;
  const flow = await begin(client.client_id);
  assert.equal(flow.response.status, 200);
  assert.ok(flow.html.includes("不能修改滴定設定"));
  assert.ok(!flow.html.includes(ADMIN) && !flow.html.includes(READ));
  assert.ok(flow.response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  const wrong = await approve(flow, { password: "incorrect" });
  assert.equal(wrong.status, 200);
  assert.ok((await wrong.text()).includes("管理密碼不正確"));
  for (const [changes, headers] of [[{}, { Cookie: "" }], [{ state: "changed" }, {}], [{}, { Origin: "https://attacker.example" }]]) {
    const denied = await approve(flow, changes, headers);
    assert.equal(new URL(denied.headers.get("location")).searchParams.get("error"), "invalid_grant");
  }
  const accepted = await approve(flow);
  assert.equal(accepted.status, 302);
  const duplicate = await approve(flow);
  assert.equal(new URL(duplicate.headers.get("location")).searchParams.get("error"), "invalid_grant");
  assert.equal(loadCount, 0);
});

test("Authorization cancellation returns no code and DCR rejects unsafe redirects or write scopes", async () => {
  const client = (await register()).body;
  const cancelled = await approve(await begin(client.client_id), { decision: "deny", password: "" });
  const url = new URL(cancelled.headers.get("location"));
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.has("code"), false);
  for (const redirect of ["javascript:alert(1)", "http://attacker.example/callback", "https://attacker.example/callback", "https://user:password@example.com/callback"]) assert.equal((await register({ redirect_uris: [redirect] })).response.status, 400);
  assert.equal((await register({ scope: "reef:write" })).response.status, 400);
  const scope = await begin(client.client_id, { scope: "reef:write" });
  assert.equal(new URL(scope.response.headers.get("location")).searchParams.get("error"), "invalid_scope");
  const target = await begin(client.client_id, { resource: "https://attacker.example/mcp" });
  assert.equal(new URL(target.response.headers.get("location")).searchParams.get("error"), "invalid_target");
});

test("PKCE, exact redirect, resource binding and single-use authorization codes are enforced", async () => {
  const client = (await register()).body;
  const code = await authorize(client.client_id);
  for (const override of [{ code_verifier: "wrong" }, { redirect_uri: "https://attacker.example" }, { resource: "https://attacker.example/mcp" }]) assert.equal((await exchange(client.client_id, code, override)).response.status, 400);
  const result = await exchange(client.client_id, code);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.scope, "reef:read");
  assert.equal((await exchange(client.client_id, code)).response.status, 400);
  const saved = JSON.stringify((await db.query("SELECT * FROM reef_mcp_auth_records")).rows);
  assert.ok(!saved.includes(result.body.access_token) && !saved.includes(result.body.refresh_token));
  assert.ok(!saved.includes(ADMIN) && !saved.includes(READ));
  const raw = await fetch(`${base}/api/internal/state`, { headers: { Authorization: `Bearer ${result.body.access_token}` } });
  assert.equal(raw.status, 404);
  const rest = createReefCloudHandler({ repository: { hasSession: async () => false }, adminPassword: ADMIN, readToken: READ, publicUrl: base });
  assert.equal((await rest(new Request(`${base}/api/internal/state`, { headers: { Authorization: `Bearer ${result.body.access_token}` } }))).status, 401);
});

test("Concurrent code exchanges issue credentials once across repository instances", async () => {
  const client = (await register()).body;
  const code = await authorize(client.client_id);
  const attempts = await Promise.all([exchange(client.client_id, code), exchange(client.client_id, code)]);
  assert.deepEqual(attempts.map((r) => r.response.status).sort(), [200, 400]);
});

test("Confidential OAuth clients use encrypted storage and must supply their own client secret", async () => {
  const { response, body: client } = await register({ token_endpoint_auth_method: "client_secret_post" });
  assert.equal(response.status, 201);
  assert.ok(client.client_secret);
  assert.ok(!JSON.stringify((await db.query("SELECT data FROM reef_mcp_auth_records")).rows).includes(client.client_secret));
  const code = await authorize(client.client_id);
  for (const changes of [{}, { client_secret: "wrong" }]) {
    const rejected = await exchange(client.client_id, code, changes);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, "invalid_client");
  }
  assert.equal((await exchange(client.client_id, code, { client_secret: client.client_secret })).response.status, 200);
});

test("Refresh rotates once, cannot change client/resource/scope, and family revocation invalidates access", async () => {
  const first = await tokens();
  const other = (await register()).body;
  for (const changes of [{ client_id: other.client_id }, { scope: "reef:write" }, { resource: "https://other.example/mcp" }]) {
    const bad = await post("/token", { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refresh_token, resource: `${base}/api/mcp`, ...changes });
    assert.equal(bad.status, 400);
  }
  const renewed = await post("/token", { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refresh_token, resource: `${base}/api/mcp` });
  assert.equal(renewed.status, 200);
  const next = await renewed.json();
  assert.notEqual(next.refresh_token, first.refresh_token);
  assert.equal((await post("/token", { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refresh_token })).status, 400);
  await provider().revokeToken(other, { token: next.access_token });
  assert.ok(await provider().verifyAccessToken(next.access_token));
  await provider().revokeToken({ client_id: first.clientId }, { token: next.refresh_token });
  await assert.rejects(provider().verifyAccessToken(next.access_token));
  await assert.rejects(provider().verifyAccessToken(first.access_token));
});

test("Expiration and password rotation invalidate MCP credentials without changing tank records", async () => {
  const token = await tokens();
  const original = structuredClone(data);
  await assert.rejects(provider(`${ADMIN}-rotated`).verifyAccessToken(token.access_token));
  clock += 31 * 60000;
  await assert.rejects(provider().verifyAccessToken(token.access_token));
  clock += 31 * 86400000;
  await assert.rejects(provider().exchangeRefreshToken({ client_id: token.clientId }, token.refresh_token));
  assert.deepEqual(data, original);
  assert.equal(loadCount, 0);
});

test("Official MCP client discovers exactly three tools and receives unchanged safety/provenance fields", async () => {
  const token = await tokens();
  const client = new Client({ name: "reef-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }));
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["getActiveReefContext", "getReefTankContext", "listReefTanks"]);
    assert.ok(result.tools.every((tool) => tool.annotations.readOnlyHint === false && tool.annotations.destructiveHint === false));
    const list = await client.callTool({ name: "listReefTanks", arguments: {} });
    assert.equal(list.structuredContent.tanks[0].id, "reef-1");
    const context = await client.callTool({ name: "getActiveReefContext", arguments: {} });
    assert.equal(context.structuredContent.latestMeasurement.date, "2026-10-12");
    assert.equal(context.structuredContent.latestMeasurement.measuredFields.ca, false);
    assert.equal(context.structuredContent.cloudUpdatedAt, "2026-10-15T06:14:00.000Z");
    assert.equal(context.structuredContent.dosing.kplus.effectiveMlPerDay, 0);
    for (const recommendation of context.structuredContent.recommendations) if (!recommendation.canAdjust) assert.equal(recommendation.suggestedDoseMlPerDay, null);
    const specific = await client.callTool({ name: "getReefTankContext", arguments: { tankId: "reef-1" } });
    assert.equal(specific.structuredContent.tank.id, "reef-1");
    const missing = await client.callTool({ name: "getReefTankContext", arguments: { tankId: "other" } });
    assert.equal(missing.isError, true);
    const count = loadCount;
    const unknown = await client.callTool({ name: "changeDosing", arguments: { amount: 99 } });
    assert.equal(unknown.isError, true);
    const injected = await client.callTool({ name: "getActiveReefContext", arguments: { newDose: 99 } });
    assert.equal(injected.isError, true);
    assert.equal(loadCount, count);
  } finally { await client.close(); }
});

test("Authenticated MCP rejects query tokens, browser-origin abuse, bad JSON and non-POST methods", async () => {
  const token = await tokens();
  const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/api/mcp?token=ignored`, { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal((await fetch(`${base}/api/mcp`, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/mcp`, { method: "POST", headers, body: "{" })).status, 400);
  for (const method of ["GET", "DELETE"]) assert.equal((await fetch(`${base}/api/mcp`, { method, headers })).status, 405);
  assert.equal(loadCount, 0);
});

test("Real inventory integration returns five buckets while water, dosing and cloud sync revision remain unchanged", async () => {
  const repository = createCloudRepository(sql, { now: () => clock });
  await repository.initialize(structuredClone(data));
  const before = await repository.load();
  const inventory = createReservoirRepository(sql, repository, { now: () => clock });
  app = createReefMcpApp({ authStore: store, repository, inventory, adminPassword: ADMIN, readToken: READ, publicUrl: base, now: () => clock });
  const token = await tokens();
  const client = new Client({ name: "reef-inventory-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }));
    const first = (await client.callTool({ name: "getActiveReefContext", arguments: {} })).structuredContent;
    assert.equal(first.reservoirInventory.alertPolicy, "estimated_usable_days");
    assert.deepEqual(first.reservoirInventory.reservoirs.map((r) => r.capacityMl), [1500, 1500, 1500, 800, 800]);
    assert.ok(first.reservoirInventory.reservoirs.every((r) => r.remainingMl === null));
    const second = (await client.callTool({ name: "getActiveReefContext", arguments: {} })).structuredContent;
    assert.deepEqual(second.reservoirInventory.reservoirs.map((r) => r.remainingMl), [null, null, null, null, null]);
    assert.deepEqual(await repository.load(), before);
    assert.deepEqual(second.dosing, first.dosing);
  } finally { await client.close(); }
});
