import { randomBytes, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { preserveDosingHistory } from "../services/dosingHistoryService.js";

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
    async createSession(authVersion) {
      await ensureSchema();
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await sql`DELETE FROM reef_controller_sessions WHERE expires_at <= ${new Date(now()).toISOString()}::timestamptz OR auth_version <> ${authVersion}`;
      await sql`INSERT INTO reef_controller_sessions (token_hash, auth_version, expires_at)
        VALUES (${hashToken(token)}, ${authVersion}, ${expiresAt}::timestamptz)`;
      return { token, expiresAt, libraryId: await this.libraryId() };
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
