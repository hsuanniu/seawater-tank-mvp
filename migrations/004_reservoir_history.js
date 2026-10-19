export const reservoirHistoryMigration = [
  `CREATE INDEX IF NOT EXISTS reservoir_manual_history
    ON reservoir_transactions(tank_id, reservoir_id, occurred_at DESC, sequence DESC)
    WHERE type IN ('refill', 'calibrate', 'correct')`,
];

export async function migrateReservoirHistory(sql) {
  for (const statement of reservoirHistoryMigration) await sql.query(statement);
}
