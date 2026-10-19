export const reservoirDayAlertMigration = [
  `CREATE TABLE IF NOT EXISTS reef_inventory_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `ALTER TABLE dosing_reservoirs
    ALTER COLUMN warning_threshold DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS bottom_reserve_ml NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reminder_days NUMERIC NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS warning_days NUMERIC NOT NULL DEFAULT 14,
    ADD COLUMN IF NOT EXISTS urgent_days NUMERIC NOT NULL DEFAULT 7`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservoir_usable_volume_check' AND conrelid = 'dosing_reservoirs'::regclass) THEN
      ALTER TABLE dosing_reservoirs ADD CONSTRAINT reservoir_usable_volume_check CHECK (bottom_reserve_ml >= 0 AND bottom_reserve_ml <= capacity_ml);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservoir_day_threshold_order' AND conrelid = 'dosing_reservoirs'::regclass) THEN
      ALTER TABLE dosing_reservoirs ADD CONSTRAINT reservoir_day_threshold_order CHECK (reminder_days > warning_days AND warning_days > urgent_days AND urgent_days > 0);
    END IF;
  END $$`,
  `WITH version AS (
    INSERT INTO reef_inventory_migrations(id) VALUES ('002_reservoir_day_alerts') ON CONFLICT DO NOTHING RETURNING id
  ), guard AS (
    UPDATE reef_inventory_revision SET revision = revision + 1 FROM version WHERE reef_inventory_revision.id = 'personal' RETURNING revision
  ), targets AS MATERIALIZED (
    SELECT r.*, CASE WHEN deleted_at IS NULL AND dose_key IN ('kh','ca','mg') AND capacity_ml = 1000 THEN 1500
      WHEN deleted_at IS NULL AND dose_key IN ('aplus','kplus') AND capacity_ml = 500 THEN 800 ELSE capacity_ml END AS new_capacity,
      GREATEST(NOW(), (data->>'lastCalculatedAt')::timestamptz) AS migrated_at
    FROM dosing_reservoirs r CROSS JOIN guard FOR UPDATE OF r
  ), changed AS (
    UPDATE dosing_reservoirs r SET capacity_ml = t.new_capacity,
      data = (t.data - 'warningThreshold') || jsonb_build_object(
        'capacityMl', t.new_capacity, 'bottomReserveMl', t.bottom_reserve_ml,
        'alertThresholds', jsonb_build_object('reminderDays', t.reminder_days, 'warningDays', t.warning_days, 'urgentDays', t.urgent_days),
        'manualEvents', COALESCE(t.data->'manualEvents', '[]'::jsonb) || CASE WHEN t.new_capacity <> t.capacity_ml
          THEN jsonb_build_array(jsonb_build_object('id', '002_capacity:' || t.id, 'type', 'capacity', 'at', t.migrated_at,
            'source', 'migration_002', 'capacityMl', t.new_capacity)) ELSE '[]'::jsonb END)
    FROM targets t WHERE r.id = t.id
    RETURNING r.id, t.tank_id, t.capacity_ml AS old_capacity, t.new_capacity, t.remaining_ml, t.migrated_at
  ), resolved AS (
    UPDATE reservoir_alerts a SET resolved_at = NOW(), data = a.data || jsonb_build_object('resolvedAt', NOW(), 'resolutionReason', 'replaced_percentage_policy')
    FROM guard WHERE a.resolved_at IS NULL AND a.data->>'policyVersion' IS DISTINCT FROM '2' RETURNING a.id
  )
  INSERT INTO reservoir_transactions(id, tank_id, reservoir_id, type, occurred_at, local_date, source, amount_ml, before_ml, after_ml, metadata)
  SELECT '002_capacity:' || id, tank_id, id, 'capacity', migrated_at, (migrated_at AT TIME ZONE 'Asia/Taipei')::date,
    'migration_002', NULL, remaining_ml, remaining_ml,
    jsonb_build_object('migration', '002_reservoir_day_alerts', 'oldCapacityMl', old_capacity, 'newCapacityMl', new_capacity,
      'note', 'Capacity correction only; remaining stock, past consumption and dosing unchanged')
  FROM changed WHERE old_capacity <> new_capacity`,
];

export async function migrateReservoirDayAlerts(sql) {
  for (const statement of reservoirDayAlertMigration) await sql.query(statement);
}
