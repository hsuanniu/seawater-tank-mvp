// Additive, repeatable migration. No existing water records or dosing settings are rewritten.
export const reservoirMigration = [
  `CREATE TABLE IF NOT EXISTS reef_inventory_revision (
    id TEXT PRIMARY KEY CHECK (id = 'personal'), revision BIGINT NOT NULL DEFAULT 0)`,
  `INSERT INTO reef_inventory_revision (id) VALUES ('personal') ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS dosing_reservoirs (
    id TEXT PRIMARY KEY, tank_id TEXT NOT NULL, name TEXT NOT NULL, dose_key TEXT NOT NULL,
    capacity_ml NUMERIC NOT NULL CHECK (capacity_ml > 0), remaining_ml NUMERIC,
    warning_threshold NUMERIC NOT NULL CHECK (warning_threshold > 0 AND warning_threshold <= 100),
    active BOOLEAN NOT NULL, deleted_at TIMESTAMPTZ, data JSONB NOT NULL,
    CHECK (remaining_ml IS NULL OR (remaining_ml >= 0 AND remaining_ml <= capacity_ml)))`,
  `CREATE INDEX IF NOT EXISTS dosing_reservoirs_tank ON dosing_reservoirs(tank_id)`,
  `CREATE TABLE IF NOT EXISTS reservoir_transactions (
    sequence BIGSERIAL PRIMARY KEY, id TEXT UNIQUE NOT NULL, tank_id TEXT NOT NULL,
    reservoir_id TEXT NOT NULL REFERENCES dosing_reservoirs(id), type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL, local_date DATE NOT NULL, source TEXT NOT NULL,
    amount_ml NUMERIC, before_ml NUMERIC, after_ml NUMERIC, metadata JSONB NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reservoir_transactions_history ON reservoir_transactions(tank_id, reservoir_id, sequence DESC)`,
  `CREATE TABLE IF NOT EXISTS reservoir_alerts (
    id TEXT PRIMARY KEY, tank_id TEXT NOT NULL, reservoir_id TEXT NOT NULL REFERENCES dosing_reservoirs(id),
    opened_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ, data JSONB NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservoir_alerts_one_open ON reservoir_alerts(reservoir_id) WHERE resolved_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS reservoir_operations (
    id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

export async function migrateReservoirInventory(sql) {
  for (const statement of reservoirMigration) await sql.query(statement);
}
