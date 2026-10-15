# Dosing Reservoir Inventory

## First Use

Open the existing dosing page and expand the five inventory cards below the daily settings. Enter the actual remaining mL and confirm each baseline. The defaults are KH/CA/MG 1000mL and A+/K+ 500mL, all with **null stock** until confirmed. Cloud management login and a completed initial import are required. No existing dosing value is changed.

## Persistence and Migration

`migrations/001_reservoir_inventory.js` is an additive, repeatable migration. Run `npm run db:migrate:inventory` with server-only `DATABASE_URL`, or let the inventory repository apply it on first authenticated use.

- `dosing_reservoirs`: current per-tank inventory aggregate, replayable manual events, effective schedule and device coverage. Null stock is not an empty/full bucket.
- `reservoir_transactions`: immutable calibration/refill/capacity/tracking/consumption/correction audit, Taipei local day, source and before/after values.
- `reservoir_alerts`: one open low-stock episode per reservoir, resolved on recovery; no new daily notification while the episode stays open.
- `reef_inventory_revision`: optimistic concurrency guard.
- `reservoir_operations`: idempotency key, request hash and committed response; retries return that response without applying a second operation.

Daily dosing stays in the existing TankStore/cloud snapshot. A backward-compatible `dosingHistory` array records the previous/new rate, enabled state, pause flag and explicit ISO effective time on actual setting changes. Older snapshots still load. Manual backup/restore preserves this timeline, but inventory remains server-owned and is **not** overwritten by restoring a phone snapshot.

Inventory updates lock the cloud-state row and compare both revisions in one PostgreSQL statement. Reservoirs, audit entries, alerts and the idempotency response commit together or not at all. Failed CAS retries reload and recalculate; no client-side decrement is authoritative. Removed buckets are tombstoned; audits remain accessible through the authenticated history API.

## Consumption

Consumption is replayed from the latest manual confirmation using exact timestamps, with day boundaries at Asia/Taipei midnight. Estimated usage is uniform over elapsed time at the **effective** daily rate; an enabled flag plus `pausedDays > 0` means zero effective dose until explicitly resumed. This does not infer a pause end date.

Rate/enable changes are timestamped, so late offline events recalculate the affected estimates using the correct historical rate. Differences are appended as corrections, not duplicate debits. Calibration resets the baseline; refill and capacity changes are replayed in order, including events on the same day. Remaining stock is clamped to [0, capacity]. If a historical correction makes an earlier refill exceed capacity, the result is flagged for manual confirmation.

Missing/invalid temporal history produces a data gap, skips deduction for the unknown interval and labels the result as an **upper bound**, with no days forecast. A manual calibration clears earlier gaps prospectively. Disabling inventory tracking does not disable dosing; if dosing continues during that gap, calibration is required. Changes made directly on a pump must be confirmed manually.

The daily Vercel job calls `/api/internal/reservoirs/reconcile` at `0 16 * * *` UTC (Taipei midnight; Hobby execution may occur later within the hour). Set a separate random `CRON_SECRET` in Vercel Production. Opening the dosing page, returning to foreground and GPT context reads also catch up. Repeated calls cannot double-debit. No push/email service is added; warnings are persistent in the app/API.

## API

Existing management session and CORS rules apply. These endpoints are never exposed as GPT write actions:

- `GET /api/internal/reservoirs/{tankId}`: reconcile and list.
- `POST /api/internal/reservoirs/{tankId}/operations`: `idempotencyKey`, `reservoirId`, `type`, fields below. Reuse the exact key/body on a network retry.
- `GET /api/internal/reservoirs/{tankId}/{reservoirId}/history[/{beforeSequence}]`: immutable audit, 100 entries plus `nextCursor`.
- `GET /api/internal/reservoirs/reconcile`: separate cron Bearer secret.

Operation types: `calibrate {amountMl}`, `refill {amountMl}`, `capacity {capacityMl, correctedRemainingMl?}`, `threshold {warningThreshold}`, `tracking {active}`, `delete`, `create {name, doseKey, capacityMl, warningThreshold?}`. Reducing capacity below stock requires an explicit corrected amount. A live daily-dose key can only link one bucket, including the existing `custom` key; deleted links may be replaced. Maximum 30 live buckets per tank.

For future device integration, `execution {start, end, records:[{id, executedAt, amountMl}]}` asserts **complete** device coverage of [start,end), including zero-execution periods. Each pulse is timestamped; duplicate IDs and overlapping coverage are rejected. Partial logs must not be submitted as complete coverage. Actual coverage replaces estimates, never adds to them. No hardware connector is installed by this change.

## GPT

Existing operation IDs and routes stay unchanged. Context adds `reservoirInventory`: all default buckets (or the user's active inventory list), provenance, confirmation/calculation times, percent, effective/configured rates, days and warnings. Stock below the configurable threshold (strictly <80% by default) warns. A valid engine-approved dose with fewer than seven days of inventory adds a supply warning. Inventory never changes engine output or daily settings.

Re-import the existing `/api/openapi` URL in GPT Actions to update the response schema and instructions. The token and authentication stay the same. Policy instructs GPT to include inventory warnings in every water analysis, distinguish measurement/sync/inventory confirmation times, and never invent a dose when `canAdjust=false` or the suggestion is null. LLM compliance is not an enforced controller; GPT remains read-only.

## Verification

Run `npm test`, `npm run build`, then `vercel build --prod` and `npm run test:cloud-bundle` before deploying. `tests/reservoir.test.mjs` covers pure replay and real PostgreSQL semantics through PGlite. Never run calibration/refill fixtures against production.

## Changed Files

New: `modules/reservoirModule.js`, `engines/reservoirEngine.js`, `migrations/001_reservoir_inventory.js`, `server/reservoirRepository.js`, `components/reservoirComponent.js`, `scripts/migrateReservoirs.mjs`, `tests/reservoir.test.mjs`, this document.

Integration: `services/tankStore.js`, `services/adminCloudService.js`, `services/reefGptContextService.js`, `services/reefGptApiService.js`, `server/cloudRepository.js`, `server/cloudHandler.js`, `server/index.js`, `api/index.js`, `app.module.js`, `app.js`, `index.html`, `styles.css`, `sw.js`, `vercel.json`, `scripts/checkCloudBundle.mjs`, `package.json`, `package-lock.json`, `version.json`.

Release checks: 117 tests passed (20 new inventory tests), build and cloud bundle smoke test passed; 320/390/1280px viewport checks passed. Production migration created only new inventory tables/default null buckets; existing cloud snapshot and revision were compared unchanged. Device execution imports were tested locally, not with a real pump. GPT response wording still depends on the GPT following its read-only schema/policy.
