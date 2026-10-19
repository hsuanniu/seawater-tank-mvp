import { createHash, timingSafeEqual } from "node:crypto";
import { createReefGptHandler, reefGptOpenApi } from "../services/reefGptApiService.js";
import { hashToken } from "./cloudRepository.js";

export const MAX_BODY_BYTES = 6 * 1024 * 1024;

function json(data, status = 200) {
  return Response.json(data, { status });
}

function matchesPassword(input, expected) {
  if (typeof input !== "string" || input.length > 1024) return false;
  const hash = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(input), hash(expected));
}

function bearer(request) {
  return (request.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/i)?.[1] || "";
}

export function cloudServerConfig(env) {
  const adminPassword = (env.REEF_ADMIN_TOKEN || "").trim();
  const readToken = (env.REEF_GPT_READ_TOKEN || "").trim();
  if (adminPassword && (adminPassword.length < 32 || adminPassword.length > 1024)) throw new Error("REEF_ADMIN_TOKEN must contain 32-1024 characters");
  if (readToken && (readToken.length < 32 || readToken === adminPassword)) throw new Error("REEF_GPT_READ_TOKEN must be distinct from the admin password and at least 32 characters");
  const appOrigin = (env.REEF_APP_ORIGIN || "").replace(/\/$/, "");
  const publicUrl = (env.REEF_API_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "http://localhost:10000").replace(/\/$/, "");
  for (const value of [appOrigin, publicUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Cloud origins must be HTTPS origins without paths or credentials");
  }
  return { adminPassword, readToken, appOrigin, publicUrl };
}

export function createReefCloudHandler({ repository, inventory = null, cronSecret = "", adminPassword = "", readToken = "", appOrigin, publicUrl, now = () => Date.now() }) {
  if (adminPassword && (adminPassword.length < 32 || adminPassword.length > 1024)) throw new Error("INVALID_ADMIN_TOKEN");
  if (readToken && (readToken.length < 32 || readToken === adminPassword)) throw new Error("INVALID_READ_TOKEN");
  const authVersion = hashToken(adminPassword);
  const allowedOrigins = new Set([appOrigin, new URL(publicUrl).origin].filter(Boolean));
  const gptBase = `${publicUrl}/api/gpt`;
  const gpt = createReefGptHandler({ token: readToken, ownerUserId: repository ? "personal" : "", loadOwnedState: () => inventory ? inventory.contextState() : repository.load(), baseUrl: gptBase, now: () => new Date(now()) });
  let attempts = 0;
  let attemptWindow = now();

  async function route(request) {
    const url = new URL(request.url);
    if (url.search) return json({ error: "QUERY_PARAMETERS_NOT_SUPPORTED" }, 400);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ status: "ok" });
    if (url.pathname === "/api/openapi" && request.method === "GET") return json(reefGptOpenApi(gptBase));
    if (url.pathname.startsWith("/api/gpt/")) return gpt(request);
    if (url.pathname === "/api/internal/reservoirs/reconcile") {
      if (request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      if (!cronSecret || !matchesPassword(request.headers.get("authorization"), `Bearer ${cronSecret}`)) return json({ error: "UNAUTHORIZED" }, 401);
      if (!inventory) return json({ error: "CONNECTION_NOT_CONFIGURED" }, 503);
      return json(await inventory.reconcile());
    }
    const inventoryPath = url.pathname.match(/^\/api\/internal\/reservoirs\/([^/]+)(?:\/(operations)|\/([^/]+)\/history(?:\/(\d+))?)?$/);
    const sessionPath = url.pathname === "/api/internal/session";
    const statePath = url.pathname === "/api/internal/state";
    const initializePath = url.pathname === "/api/internal/initialize";
    if (!sessionPath && !statePath && !initializePath && !inventoryPath) return json({ error: "NOT_FOUND" }, 404);
    const methods = inventoryPath ? [inventoryPath[2] ? "POST" : "GET"] : sessionPath ? ["GET", "POST", "DELETE"] : statePath ? ["GET", "PUT"] : ["POST"];
    if (!methods.includes(request.method)) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    const ready = Boolean(repository && adminPassword);
    if (sessionPath && request.method === "GET") {
      const authenticated = ready && await repository.hasSession(bearer(request), authVersion);
      return json({ authenticated, databaseConfigured: Boolean(repository), adminAuthConfigured: Boolean(adminPassword), libraryId: authenticated ? await repository.libraryId() : null });
    }
    if (!ready) return json({ error: "CONNECTION_NOT_CONFIGURED" }, 503);
    if (sessionPath && request.method === "POST") {
      if (now() - attemptWindow >= 15 * 60 * 1000) { attemptWindow = now(); attempts = 0; }
      // This is one personal library: a process-wide bound also covers proxy/IP changes.
      if (++attempts > 20) return json({ error: "TOO_MANY_ATTEMPTS" }, 429);
      const { password } = await readJson(request);
      if (!matchesPassword(password, adminPassword)) return json({ error: "INVALID_ADMIN_PASSWORD" }, 401);
      return json(await repository.createSession(authVersion));
    }
    const sessionToken = bearer(request);
    if (!await repository.hasSession(sessionToken, authVersion)) return json({ error: "SESSION_EXPIRED" }, 401);
    if (inventoryPath) {
      if (!inventory) return json({ error: "CONNECTION_NOT_CONFIGURED" }, 503);
      const tankId = decodeURIComponent(inventoryPath[1]);
      if (inventoryPath[2]) return json(await inventory.operate(tankId, await readJson(request)));
      if (inventoryPath[3]) return json(await inventory.history(tankId, decodeURIComponent(inventoryPath[3]), inventoryPath[4]));
      return json(await inventory.list(tankId));
    }
    if (sessionPath) {
      await repository.revokeSession(sessionToken);
      return json({ signedOut: true });
    }
    if (request.method === "GET") return json(await repository.load());
    const body = await readJson(request);
    return json(initializePath ? await repository.initialize(body.data) : await repository.save(body.data, body.expectedRevision));
  }

  return async (request) => {
    const origin = request.headers.get("origin");
    let response;
    try {
      if (origin && !allowedOrigins.has(origin)) response = json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
      else if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
      else response = await route(request);
    } catch (error) {
      const code = error.message;
      const status = ({ INVALID_JSON: 400, INVALID_CLOUD_STATE: 400, UNSUPPORTED_MEDIA_TYPE: 415, PAYLOAD_TOO_LARGE: 413, CLOUD_ALREADY_INITIALIZED: 409, CLOUD_REVISION_CONFLICT: 409,
        INVALID_INVENTORY_INPUT: 400, INVALID_INVENTORY_TIME: 400, INVALID_EXECUTION_COVERAGE: 400, INVENTORY_CAPACITY_EXCEEDED: 400,
        INVALID_INVENTORY_ALERT_DAYS: 400, INVENTORY_RESERVE_EXCEEDS_CAPACITY: 400,
        INVENTORY_CONFIRMATION_REQUIRED: 409, DOSE_LINK_ALREADY_EXISTS: 409, INVENTORY_LIMIT_REACHED: 409,
        INVENTORY_HISTORY_NOT_FOUND: 404, INVENTORY_HISTORY_CONFLICT: 409, INVENTORY_CORRECTION_CONFLICT: 409,
        IDEMPOTENCY_KEY_REUSED: 409, INVENTORY_CONFLICT_RETRY: 409, TANK_NOT_FOUND: 404, RESERVOIR_NOT_FOUND: 404, NO_SYNCED_DATA: 404 })[code] || 503;
      response = json({ error: status === 503 ? "CLOUD_UNAVAILABLE" : code }, status);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, private");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Vary", "Origin");
    if (origin && allowedOrigins.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    return new Response(response.body, { status: response.status, headers });
  };
}

async function readJson(request) {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new Error("UNSUPPORTED_MEDIA_TYPE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error("INVALID_JSON"); }
}
