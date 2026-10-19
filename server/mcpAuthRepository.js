import { createHash } from "node:crypto";
import { migrateMcpAuthorization } from "../migrations/003_mcp_authorization.js";

const recordId = (kind, token) => `${kind}:${createHash("sha256").update(token).digest("hex")}`;

export function createMcpAuthRepository(sql, { now = () => Date.now() } = {}) {
  let ready;
  const ensureSchema = () => ready ||= migrateMcpAuthorization(sql).catch((error) => { ready = null; throw error; });
  const row = (kind, token, clientId, data, expiresAt) => ({
    id: recordId(kind, token), kind, client_id: clientId, data, expires_at: new Date(expiresAt).toISOString(),
  });
  return {
    ensureSchema,
    async put(kind, token, clientId, data, expiresAt) {
      await ensureSchema();
      await sql`DELETE FROM reef_mcp_auth_records WHERE expires_at <= ${new Date(now()).toISOString()}::timestamptz`;
      const limit = kind === "client" ? 200 : kind === "consent" ? 20 : 2000;
      const result = await sql`INSERT INTO reef_mcp_auth_records(id, kind, client_id, data, expires_at)
        SELECT ${recordId(kind, token)}, ${kind}, ${clientId}, ${JSON.stringify(data)}::jsonb, ${new Date(expiresAt).toISOString()}::timestamptz
        WHERE (SELECT COUNT(*) FROM reef_mcp_auth_records WHERE kind = ${kind} AND (${kind === "client"} OR client_id = ${clientId})) < ${limit}
        RETURNING id`;
      if (!result.length) throw new Error("MCP_AUTH_LIMIT_REACHED");
    },
    async get(kind, token) {
      if (typeof token !== "string" || token.length > 4096) return null;
      await ensureSchema();
      const result = await sql`SELECT data FROM reef_mcp_auth_records
        WHERE id = ${recordId(kind, token)} AND expires_at > ${new Date(now()).toISOString()}::timestamptz`;
      return result[0]?.data || null;
    },
    async exchange(kind, token, expected, records) {
      await ensureSchema();
      // Single-use consent, code and refresh exchanges remain atomic across serverless instances.
      const payload = records.map(({ kind, token, clientId, data, expiresAt }) => row(kind, token, clientId, data, expiresAt));
      const result = await sql`WITH consumed AS (
        DELETE FROM reef_mcp_auth_records WHERE id = ${recordId(kind, token)}
          AND data = ${JSON.stringify(expected)}::jsonb AND expires_at > ${new Date(now()).toISOString()}::timestamptz RETURNING id
      ), issued AS (
        INSERT INTO reef_mcp_auth_records(id, kind, client_id, data, expires_at)
        SELECT r.* FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS r(id text, kind text, client_id text, data jsonb, expires_at timestamptz), consumed RETURNING id
      ) SELECT id FROM consumed`;
      return result.length === 1;
    },
    async revokeFamily(clientId, familyId) {
      await ensureSchema();
      await sql`DELETE FROM reef_mcp_auth_records WHERE client_id = ${clientId} AND data->>'familyId' = ${familyId}`;
    },
  };
}
