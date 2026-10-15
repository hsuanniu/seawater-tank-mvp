import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const bundle = new URL("../.vercel/output/functions/api/index.func/", import.meta.url);
for (const file of ["analysisEngine.js", "stabilityEngine.js", "safetyEngine.js", "eventRecoveryEngine.js"]) {
  await access(new URL(`engines/${file}`, bundle));
}
const { default: api } = await import(new URL("api/index.js", bundle));
const response = await api.fetch(new Request("http://localhost:10000/healthz"));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: "ok" });
const output = JSON.parse(await readFile(new URL("../.vercel/output/config.json", import.meta.url), "utf8"));
for (const path of ["/healthz", "/api/openapi", "/api/internal/session", "/api/gpt/tanks/tank-id/context"]) {
  const route = output.routes.find((entry) => entry.src && new RegExp(entry.src).test(path));
  assert.equal(route?.dest, "/api", `${path} must reach the API without injected query parameters`);
}
const schema = await api.fetch(new Request("http://localhost:10000/api/openapi"));
assert.equal(schema.status, 200);
assert.equal((await schema.json()).openapi, "3.1.0");
const query = await api.fetch(new Request("http://localhost:10000/api/openapi?owner=someone-else"));
assert.equal(query.status, 400);
console.log("Cloud bundle verified: engines included, routes preserve paths without query injection, and API starts without reading tank data.");
