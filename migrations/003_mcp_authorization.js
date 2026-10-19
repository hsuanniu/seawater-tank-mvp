export const mcpAuthorizationMigration = [
  `CREATE TABLE IF NOT EXISTS reef_mcp_auth_records (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('client','consent','code','access','refresh')),
    client_id TEXT NOT NULL, data JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reef_mcp_auth_expiry ON reef_mcp_auth_records(expires_at)`,
  `CREATE INDEX IF NOT EXISTS reef_mcp_auth_client ON reef_mcp_auth_records(client_id, kind)`,
];

export async function migrateMcpAuthorization(sql) {
  for (const statement of mcpAuthorizationMigration) await sql.query(statement);
}
