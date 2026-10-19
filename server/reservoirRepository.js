import { randomUUID, createHash } from "node:crypto";
import { migrateReservoirInventory } from "../migrations/001_reservoir_inventory.js";
import { migrateReservoirDayAlerts } from "../migrations/002_reservoir_day_alerts.js";
import { migrateReservoirHistory } from "../migrations/004_reservoir_history.js";
import { isReefTank, MANUAL_HISTORY_TYPES } from "../modules/reservoirHistoryModule.js";
import { DEFAULT_RESERVOIRS } from "../modules/reservoirModule.js";
import { applyReservoirOperation, calculateReservoir, createReservoir, ingestDosingHistory, inventoryRound, reservoirView, taipeiInventoryDate } from "../engines/reservoirEngine.js";

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value) => new Date(value).toISOString();
const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function auditSnapshot(view) {
  const { refillHistory, calibrationHistory, lastRefill, ...snapshot } = view;
  return snapshot;
}

export function createReservoirRepository(sql, cloudRepository, { now = () => Date.now() } = {}) {
  let ready;
  const ensureSchema = () => ready ||= (async () => {
    await migrateReservoirInventory(sql);
    await migrateReservoirDayAlerts(sql);
    await migrateReservoirHistory(sql);
  })().catch((error) => { ready = null; throw error; });

  async function load() {
    await cloudRepository.libraryId();
    await ensureSchema();
    // One statement gives a consistent snapshot across the water state and inventory revisions.
    const rows = await sql`SELECT c.data, c.revision AS cloud_revision, c.updated_at, i.revision,
      COALESCE((SELECT jsonb_agg(r.data) FROM dosing_reservoirs r), '[]'::jsonb) AS reservoirs,
      COALESCE((SELECT jsonb_agg(a.data) FROM reservoir_alerts a WHERE a.resolved_at IS NULL), '[]'::jsonb) AS alerts
      , COALESCE((SELECT jsonb_agg(jsonb_build_object('reservoir_id', t.reservoir_id, 'type', t.type,
        'before_ml', t.before_ml, 'after_ml', t.after_ml,
        'metadata', jsonb_build_object('id', t.metadata->'id', 'before', jsonb_build_object('quality', t.metadata#>'{before,quality}'))))
        FROM reservoir_transactions t WHERE type IN ('refill', 'calibrate', 'correct')), '[]'::jsonb) AS manual_ledger
      FROM reef_controller_state c CROSS JOIN reef_inventory_revision i WHERE c.id = 'personal' AND i.id = 'personal'`;
    return rows[0];
  }

  function transaction(r, type, at, extra = {}) {
    return { id: randomUUID(), tank_id: r.tankId, reservoir_id: r.id, type, occurred_at: at,
      local_date: taipeiInventoryDate(Date.parse(at)), source: "inventory_engine", amount_ml: null,
      before_ml: null, after_ml: r.remainingMl, metadata: {}, ...extra };
  }

  async function run(input = null, tankId = null) {
    let at = iso(now());
    const requestHash = input ? fingerprint({ tankId, operation: input }) : null;
    if (input && (!safeId(input.idempotencyKey) || !safeId(input.reservoirId) && input.type !== "create")) throw new Error("INVALID_INVENTORY_INPUT");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let operation = input;
      const current = await load();
      if (!current?.data) throw new Error("NO_SYNCED_DATA");
      at = iso(Math.max(now(), ...current.reservoirs.map((r) => Date.parse(r.lastCalculatedAt || r.createdAt))));
      if (operation) {
        const saved = await sql`SELECT request_hash, response FROM reservoir_operations WHERE id = ${operation.idempotencyKey}`;
        if (saved.length) {
          if (saved[0].request_hash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
          return saved[0].response;
        }
      }
      const tanks = (current.data.tanks || []).filter(isReefTank);
      if (tankId && !tanks.some((tank) => tank.id === tankId)) throw new Error("TANK_NOT_FOUND");
      const all = current.reservoirs;
      const ledger = [];
      const alerts = current.alerts;
      const changedAlerts = [];
      for (const tank of tanks) {
        // Deleted defaults stay tombstoned; reading the page never recreates a deliberately removed bucket.
        if (!all.some((r) => r.tankId === tank.id)) for (const defaults of DEFAULT_RESERVOIRS) {
          const r = createReservoir({ ...defaults, id: randomUUID(), tankId: tank.id }, tank.dosing, at);
          all.push(r);
          ledger.push(transaction(r, "create", at, { source: "migration_defaults", metadata: { initialRemainingMl: null } }));
        }
      }
      if (operation?.type === "create") {
        if (all.filter((r) => r.tankId === tankId && !r.deletedAt).length >= 30) throw new Error("INVENTORY_LIMIT_REACHED");
        if (all.some((r) => r.tankId === tankId && !r.deletedAt && r.doseKey === operation.doseKey)) throw new Error("DOSE_LINK_ALREADY_EXISTS");
        const tank = tanks.find((t) => t.id === tankId);
        const created = createReservoir({ ...operation, id: randomUUID(), tankId }, tank.dosing, at);
        all.push(created);
        operation = { ...operation, reservoirId: created.id };
        ledger.push(transaction(created, "create", at, { source: "manual_app", metadata: { name: created.name, doseKey: created.doseKey, capacityMl: created.capacityMl } }));
      }
      let found = operation?.type === "create";
      for (let index = 0; index < all.length; index += 1) {
        const old = all[index];
        const tank = tanks.find((t) => t.id === old.tankId);
        if (!tank || old.deletedAt) continue;
        let r = calculateReservoir(ingestDosingHistory(old, tank, current.updated_at, at), at);
        const baselineId = r.manualEvents.findLast((e) => e.type === "calibrate")?.id;
        const previousBaselineId = old.manualEvents.findLast((e) => e.type === "calibrate")?.id;
        for (const [date, bucket] of Object.entries(r.dailyConsumption)) {
          const before = baselineId === previousBaselineId ? old.dailyConsumption?.[date] : null;
          if (JSON.stringify(bucket) !== JSON.stringify(before || { consumedMl: 0, demandedMl: 0, estimatedMl: 0, actualMl: 0, gapSeconds: 0, estimatedSeconds: 0, actualSeconds: 0 })) {
            ledger.push(transaction(r, before ? "consumption_correction" : "consumption", at, {
              local_date: date, amount_ml: inventoryRound(bucket.consumedMl - (before?.consumedMl || 0)),
              metadata: { baselineId, dailyTotal: bucket, previousDailyTotal: before || null, note: "Asia/Taipei；按生效時間分段；估算以已同步設定為準" },
            }));
          }
        }
        if (operation && operation.type !== "create" && old.id === operation.reservoirId && old.tankId === tankId) {
          found = true;
          const beforeDaily = r.dailyConsumption;
          const applied = applyReservoirOperation(r, operation, at);
          r = applied.reservoir;
          ledger.push(transaction(r, operation.type, at, { source: operation.type === "execution" ? "device_import" : "manual_app",
            amount_ml: operation.amountMl ?? null, before_ml: applied.before.remainingMl, after_ml: applied.after.remainingMl,
            metadata: { ...applied.event, before: auditSnapshot(applied.before), after: auditSnapshot(applied.after) } }));
          // A late device batch can correct prior estimates without changing any dosing setting.
          if (["execution", "correct"].includes(operation.type)) for (const [date, bucket] of Object.entries(r.dailyConsumption)) {
            const before = beforeDaily[date];
            if (JSON.stringify(before) !== JSON.stringify(bucket)) ledger.push(transaction(r, operation.type === "execution" ? "execution_reconciliation" : "consumption_correction", at, { local_date: date,
              amount_ml: inventoryRound(bucket.consumedMl - (before?.consumedMl || 0)), metadata: { baselineId, dailyTotal: bucket, previousDailyTotal: before || null,
                source: operation.type === "execution" ? "device_complete_coverage" : "manual_history_correction", correctionId: operation.type === "correct" ? operation.idempotencyKey : null } }));
          }
        }
        const view = reservoirView(r);
        const open = alerts.find((a) => a.reservoirId === r.id);
        const shouldAlert = r.active && !r.deletedAt && view.requiresAlert;
        if (shouldAlert && !open) {
          const alert = { id: randomUUID(), tankId: r.tankId, reservoirId: r.id, openedAt: at, resolvedAt: null,
            policyVersion: 2, level: view.alertStatus, alertThresholds: view.alertThresholds,
            triggeringInventory: view, source: "estimated_days_remaining", severityChanges: [] };
          changedAlerts.push(alert);
          r.activeAlertId = alert.id;
        } else if (shouldAlert && open && open.level !== view.alertStatus) {
          changedAlerts.push({ ...open, level: view.alertStatus, updatedAt: at, triggeringInventory: view,
            severityChanges: [...(open.severityChanges || []), { at, from: open.level, to: view.alertStatus }] });
          r.activeAlertId = open.id;
        } else if (!shouldAlert && open) {
          changedAlerts.push({ ...open, resolvedAt: at });
          r.activeAlertId = null;
        } else r.activeAlertId = open?.id || null;
        all[index] = r;
      }
      if (operation && !found) throw new Error("RESERVOIR_NOT_FOUND");
      const doseOrder = ["kh", "ca", "mg", "aplus", "kplus", "custom"];
      const manualLedger = [...(current.manual_ledger || []), ...ledger.filter((row) => MANUAL_HISTORY_TYPES.includes(row.type))];
      const views = all.filter((r) => tanks.some((t) => t.id === r.tankId) && !r.deletedAt).map((r) => reservoirView(r, manualLedger))
        .sort((a, b) => a.tankId.localeCompare(b.tankId) || doseOrder.indexOf(a.doseKey) - doseOrder.indexOf(b.doseKey) || a.id.localeCompare(b.id));
      const response = { inventoryRevision: Number(current.revision) + 1, calculatedAt: at,
        cloudUpdatedAt: iso(current.updated_at), reservoirs: tankId ? views.filter((r) => r.tankId === tankId) : views };
      const payload = all.map((r) => ({ id: r.id, tank_id: r.tankId, name: r.name, dose_key: r.doseKey,
        capacity_ml: r.capacityMl, remaining_ml: r.remainingMl, bottom_reserve_ml: r.bottomReserveMl ?? 0,
        reminder_days: r.alertThresholds?.reminderDays ?? 30, warning_days: r.alertThresholds?.warningDays ?? 14, urgent_days: r.alertThresholds?.urgentDays ?? 7,
        active: r.active, deleted_at: r.deletedAt, data: r }));
      // Lock order: water-state row, then inventory revision. The guard, ledger, alerts and replay response commit atomically.
      const result = await sql`WITH cloud_lock AS MATERIALIZED (
        SELECT revision FROM reef_controller_state WHERE id = 'personal' AND revision = ${current.cloud_revision} FOR UPDATE
      ), guard AS (
        UPDATE reef_inventory_revision SET revision = reef_inventory_revision.revision + 1 FROM cloud_lock
        WHERE id = 'personal' AND reef_inventory_revision.revision = ${current.revision} RETURNING reef_inventory_revision.revision
      ), reservoirs AS (
        INSERT INTO dosing_reservoirs (id, tank_id, name, dose_key, capacity_ml, remaining_ml, bottom_reserve_ml, reminder_days, warning_days, urgent_days, active, deleted_at, data)
        SELECT r.* FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS r(id text, tank_id text, name text, dose_key text,
          capacity_ml numeric, remaining_ml numeric, bottom_reserve_ml numeric, reminder_days numeric, warning_days numeric, urgent_days numeric,
          active boolean, deleted_at timestamptz, data jsonb), guard
        ON CONFLICT (id) DO UPDATE SET capacity_ml = EXCLUDED.capacity_ml, remaining_ml = EXCLUDED.remaining_ml,
          bottom_reserve_ml = EXCLUDED.bottom_reserve_ml, reminder_days = EXCLUDED.reminder_days, warning_days = EXCLUDED.warning_days, urgent_days = EXCLUDED.urgent_days,
          active = EXCLUDED.active, deleted_at = EXCLUDED.deleted_at, data = EXCLUDED.data
        RETURNING id
      ), entries AS (
        INSERT INTO reservoir_transactions (id, tank_id, reservoir_id, type, occurred_at, local_date, source, amount_ml, before_ml, after_ml, metadata)
        SELECT r.* FROM jsonb_to_recordset(${JSON.stringify(ledger)}::jsonb) AS r(id text, tank_id text, reservoir_id text, type text,
          occurred_at timestamptz, local_date date, source text, amount_ml numeric, before_ml numeric, after_ml numeric, metadata jsonb), guard
        WHERE (SELECT count(*) FROM reservoirs) >= 0 RETURNING id
      ), alert_changes AS (
        INSERT INTO reservoir_alerts (id, tank_id, reservoir_id, opened_at, resolved_at, data)
        SELECT r.id, r.data->>'tankId', r.data->>'reservoirId', (r.data->>'openedAt')::timestamptz, (r.data->>'resolvedAt')::timestamptz, r.data
        FROM jsonb_to_recordset(${JSON.stringify(changedAlerts.map((a) => ({ id: a.id, data: a })))}::jsonb) AS r(id text, data jsonb), guard
        WHERE (SELECT count(*) FROM reservoirs) >= 0
        ON CONFLICT (id) DO UPDATE SET resolved_at = EXCLUDED.resolved_at, data = EXCLUDED.data RETURNING id
      ), replay AS (
        INSERT INTO reservoir_operations(id, request_hash, response)
        SELECT ${operation?.idempotencyKey || ""}, ${requestHash || ""}, ${JSON.stringify(response)}::jsonb FROM guard WHERE ${Boolean(operation)}
        RETURNING id
      ) SELECT revision FROM guard`;
      if (result.length) return { ...response, state: current.data, cloudRevision: Number(current.cloud_revision) };
      // A competing update won. Reload and replay from its committed state rather than applying a second deduction.
    }
    throw new Error("INVENTORY_CONFLICT_RETRY");
  }

  return {
    ensureSchema,
    async contextState() {
      const result = await run();
      return { data: result.state, revision: result.cloudRevision, updated_at: result.cloudUpdatedAt,
        reservoirs: result.reservoirs, inventoryCalculatedAt: result.calculatedAt };
    },
    async list(tankId) {
      const { state, cloudRevision, ...result } = await run(null, tankId);
      return result;
    },
    async operate(tankId, operation) {
      const { state, cloudRevision, ...result } = await run(operation, tankId);
      return result;
    },
    async reconcile() { const result = await run(); return { calculatedAt: result.calculatedAt, reservoirCount: result.reservoirs.length }; },
    async history(tankId, reservoirId, before = "9223372036854775807") {
      if (!safeId(reservoirId) || !/^\d{1,19}$/.test(before) || BigInt(before) > 9223372036854775807n) throw new Error("INVALID_INVENTORY_INPUT");
      const current = await load();
      if (!current.data?.tanks.some((t) => t.id === tankId && isReefTank(t))) throw new Error("TANK_NOT_FOUND");
      const rows = await sql`SELECT sequence::text, id, type, occurred_at, local_date::text, source, amount_ml, before_ml, after_ml, metadata
        FROM reservoir_transactions WHERE tank_id = ${tankId} AND reservoir_id = ${reservoirId} AND sequence < ${before}::bigint
        ORDER BY reservoir_transactions.sequence DESC LIMIT 101`;
      const entries = rows.slice(0, 100);
      return { entries, nextCursor: rows.length > 100 ? entries.at(-1).sequence : null };
    },
  };
}
