import { randomBytes, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { preserveDosingHistory } from "../services/dosingHistoryService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const STANDARD_SESSION_MS = 7 * DAY_MS;
const REMEMBERED_SESSION_MS = 365 * DAY_MS;

export function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validCloudState(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.tanks)) return false;
  const ids = new Set();
  return state.tanks.every((tank) => {
    if (!tank || typeof tank.id !== "string" || !tank.id.trim() || ids.has(tank.id)
      || !tank.tank || typeof tank.tank !== "object" || Array.isArray(tank.tank)
      || !Array.isArray(tank.records) || !tank.records.every((row) => row && typeof row === "object" && !Array.isArray(row))) return false;
    ids.add(tank.id);
    return ["archivedRecords", "maintenance", "doseApplications", "livestock", "additives", "additiveSchedules", "feedings", "events", "dosingHistory"]
      .every((key) => tank[key] === undefined || Array.isArray(tank[key]));
  });
}

function snapshot(row) {
  if (!row?.data) return null;
  return { data: row.data, revision: Number(row.revision), updated_at: new Date(row.updated_at).toISOString() };
}

export function createCloudRepository(sql, { now = () => Date.now() } = {}) {
  let ready;
  let sessionOptionsReady;
  function ensureSchema() {
    if (!ready) ready = (async () => {
      // Separate statements work with Neon's parameterized HTTP driver.
      await sql`CREATE TABLE IF NOT EXISTS reef_controller_state (
        id TEXT PRIMARY KEY CHECK (id = 'personal'), library_id UUID NOT NULL DEFAULT gen_random_uuid(),
        data JSONB, revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), updated_at TIMESTAMPTZ)`;
      await sql`INSERT INTO reef_controller_state (id) VALUES ('personal') ON CONFLICT (id) DO NOTHING`;
      await sql`CREATE TABLE IF NOT EXISTS reef_controller_sessions (
        token_hash TEXT PRIMARY KEY, auth_version TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`;
    })().catch((error) => { ready = null; throw error; });
    return ready;
  }

  async function ensureSessionOptions() {
    await ensureSchema();
    if (!sessionOptionsReady) sessionOptionsReady = sql`ALTER TABLE reef_controller_sessions
      ADD COLUMN IF NOT EXISTS remember_device BOOLEAN`.catch((error) => { sessionOptionsReady = null; throw error; });
    return sessionOptionsReady;
  }

  return {
    async libraryId() {
      await ensureSchema();
      const rows = await sql`SELECT library_id FROM reef_controller_state WHERE id = 'personal'`;
      return rows[0].library_id;
    },
    async load() {
      await ensureSchema();
      const rows = await sql`SELECT data, revision, updated_at FROM reef_controller_state WHERE id = 'personal'`;
      return snapshot(rows[0]);
    },
    async initialize(data) {
      if (!validCloudState(data) || !data.tanks.length) throw new Error("INVALID_CLOUD_STATE");
      await ensureSchema();
      const rows = await sql`UPDATE reef_controller_state SET data = ${JSON.stringify(data)}::jsonb,
        revision = revision + 1, updated_at = NOW()
        WHERE id = 'personal' AND data IS NULL AND revision = 0 RETURNING data, revision, updated_at`;
      if (!rows.length) throw new Error("CLOUD_ALREADY_INITIALIZED");
      return snapshot(rows[0]);
    },
    async save(data, revision) {
      if (!validCloudState(data) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("INVALID_CLOUD_STATE");
      await ensureSchema();
      const previous = await this.load();
      if (!previous || previous.revision !== revision) throw new Error("CLOUD_REVISION_CONFLICT");
      const saved = preserveDosingHistory(previous.data, data, { at: new Date(now()).toISOString(), createId: randomUUID });
      const rows = await sql`UPDATE reef_controller_state SET data = ${JSON.stringify(saved)}::jsonb,
        revision = revision + 1, updated_at = NOW()
        WHERE id = 'personal' AND data IS NOT NULL AND revision = ${revision}
        RETURNING data, revision, updated_at`;
      if (!rows.length) throw new Error("CLOUD_REVISION_CONFLICT");
      return snapshot(rows[0]);
    },
    async createSession(authVersion, { rememberDevice = false } = {}) {
      await ensureSessionOptions();
      const token = randomBytes(32).toString("hex");
      const remembered = rememberDevice === true;
      const issuedAt = now();
      const expiresAt = new Date(issuedAt + (remembered ? REMEMBERED_SESSION_MS : STANDARD_SESSION_MS)).toISOString();
      await sql`DELETE FROM reef_controller_sessions WHERE expires_at <= ${new Date(issuedAt).toISOString()}::timestamptz OR auth_version <> ${authVersion}`;
      await sql`INSERT INTO reef_controller_sessions (token_hash, auth_version, expires_at, remember_device)
        VALUES (${hashToken(token)}, ${authVersion}, ${expiresAt}::timestamptz, ${remembered})`;
      return { token, expiresAt, libraryId: await this.libraryId() };
    },
    async renewSession(token, authVersion) {
      if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
      await ensureSessionOptions();
      const checkedAt = now();
      const expiresAt = new Date(checkedAt + REMEMBERED_SESSION_MS).toISOString();
      // Older rows have no opt-in flag. Require more than a standard lifetime plus clock-skew margin.
      const legacyCutoff = new Date(checkedAt + STANDARD_SESSION_MS + DAY_MS).toISOString();
      const rows = await sql`UPDATE reef_controller_sessions
        SET expires_at = GREATEST(expires_at, ${expiresAt}::timestamptz), remember_device = TRUE
        WHERE token_hash = ${hashToken(token)} AND auth_version = ${authVersion}
        AND expires_at > ${new Date(checkedAt).toISOString()}::timestamptz
        AND (remember_device = TRUE OR (remember_device IS NULL AND expires_at > ${legacyCutoff}::timestamptz))
        AND (remember_device IS NULL OR expires_at < ${expiresAt}::timestamptz)
        RETURNING expires_at`;
      return rows.length ? new Date(rows[0].expires_at).toISOString() : null;
    },
    async hasSession(token, authVersion) {
      if (!/^[a-f0-9]{64}$/.test(token || "")) return false;
      await ensureSchema();
      const rows = await sql`SELECT token_hash FROM reef_controller_sessions
        WHERE token_hash = ${hashToken(token)} AND auth_version = ${authVersion}
        AND expires_at > ${new Date(now()).toISOString()}::timestamptz`;
      return rows.length === 1;
    },
    async revokeSession(token) {
      await ensureSchema();
      await sql`DELETE FROM reef_controller_sessions WHERE token_hash = ${hashToken(token)}`;
    },
  };
}
