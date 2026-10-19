import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const bundle = new URL("../.vercel/output/functions/api/index.func/", import.meta.url);
for (const file of ["analysisEngine.js", "stabilityEngine.js", "safetyEngine.js", "eventRecoveryEngine.js", "reservoirEngine.js", "reservoirAlertEngine.js"]) {
  await access(new URL(`engines/${file}`, bundle));
}
const { default: api } = await import(new URL("api/index.js", bundle));
const response = await api.fetch(new Request("http://localhost:10000/healthz"));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: "ok" });
const output = JSON.parse(await readFile(new URL("../.vercel/output/config.json", import.meta.url), "utf8"));
for (const path of ["/healthz", "/api/openapi", "/api/internal/session", "/api/gpt/tanks/tank-id/context", "/api/internal/reservoirs/reconcile", "/api/internal/reservoirs/tank-id/operations"]) {
  const route = output.routes.find((entry) => entry.src && new RegExp(entry.src).test(path));
  assert.equal(route?.dest, "/api", `${path} must reach the API without injected query parameters`);
}
const schema = await api.fetch(new Request("http://localhost:10000/api/openapi"));
assert.equal(schema.status, 200);
const document = await schema.json();
assert.equal(document.openapi, "3.1.0");
assert.deepEqual(document.components.schemas, {}, "GPT Actions requires an object schemas section");
assert.ok(document.paths["/context"].get.responses["200"].content["application/json"].schema.properties.reservoirInventory);
const context = document.paths["/context"].get.responses["200"].content["application/json"].schema.properties;
assert.ok(context.dosingAdjustmentHistory);
assert.ok(context.reservoirInventory.properties.reservoirs.items.properties.refillHistory);
await access(new URL("migrations/001_reservoir_inventory.js", bundle));
await access(new URL("migrations/002_reservoir_day_alerts.js", bundle));
for (const file of ["migrations/004_reservoir_history.js", "modules/reservoirHistoryModule.js", "services/dosingHistoryService.js"]) await access(new URL(file, bundle));
const query = await api.fetch(new Request("http://localhost:10000/api/openapi?owner=someone-else"));
assert.equal(query.status, 400);
const mcpBundle = new URL("../.vercel/output/functions/api/mcp.func/", import.meta.url);
for (const file of ["server/reefMcpServer.js", "server/mcpAuthProvider.js", "server/mcpAuthRepository.js", "migrations/003_mcp_authorization.js", "engines/safetyEngine.js"]) await access(new URL(file, mcpBundle));
for (const file of ["migrations/004_reservoir_history.js", "modules/reservoirHistoryModule.js", "services/dosingHistoryService.js"]) await access(new URL(file, mcpBundle));
const mcp = await import(new URL("api/mcp.js", mcpBundle));
assert.equal(typeof mcp.default, "function");
for (const path of ["/api/mcp", "/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/mcp"]) {
  const route = output.routes.find((entry) => entry.src && new RegExp(entry.src).test(path));
  assert.equal(route?.dest, "/api/mcp", `${path} must reach MCP without changing its original path`);
}
await access(new URL("../.vercel/output/static/reef-clownfish.png", import.meta.url));
console.log("Cloud bundles verified: original REST routes preserved, authenticated MCP and OAuth routes included, and engines load without reading tank data.");
