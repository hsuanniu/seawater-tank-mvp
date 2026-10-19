# Dosing Reservoir Inventory

## First Use

Open the existing dosing page and expand the five inventory cards below the daily settings. Enter the actual remaining mL and confirm each baseline. The defaults are KH/CA/MG 1500mL and A+/K+ 800mL, all with **null stock** until confirmed. Cloud management login and a completed initial import are required. No existing dosing value is changed.

## Persistence and Migration

Run `npm run db:migrate:inventory` with server-only `DATABASE_URL`, or let the repository apply the repeatable migrations on first authenticated use. Migration 001 adds inventory tables. Migration 002 runs a one-time transactional correction of the old default capacities (1000 -> 1500; 500 -> 800) without changing stock, calibration dates, refill/consumption history or dosing. Explicit custom capacities such as 2000mL are retained. A dated capacity event and migration audit preserve the old capacity for historical replay. Old percentage alert episodes are resolved, not deleted. The legacy `warning_threshold` database column and historical percentage-setting events remain for history/rolling-deployment compatibility, but are never used for current alerts.

- `dosing_reservoirs`: current per-tank inventory aggregate, replayable manual events, effective schedule and device coverage. Null stock is not an empty/full bucket.
- `reservoir_transactions`: immutable calibration/refill/capacity/tracking/consumption/correction audit, Taipei local day, source and before/after values.
- `reservoir_alerts`: one open days-based episode per reservoir, updated on severity changes and resolved on recovery; no repeated daily notification while the episode stays open.
- `reef_inventory_revision`: optimistic concurrency guard.
- `reservoir_operations`: idempotency key, request hash and committed response; retries return that response without applying a second operation.

Daily dosing stays in the existing TankStore/cloud snapshot. A backward-compatible `dosingHistory` array records the previous/new rate, enabled state, pause flag and explicit ISO effective time on actual setting changes. Older snapshots still load. Manual backup/restore preserves this timeline, but inventory remains server-owned and is **not** overwritten by restoring a phone snapshot.

Inventory updates lock the cloud-state row and compare both revisions in one PostgreSQL statement. Reservoirs, audit entries, alerts and the idempotency response commit together or not at all. Failed CAS retries reload and recalculate; no client-side decrement is authoritative. Removed buckets are tombstoned; audits remain accessible through the authenticated history API.

Capacity is editable. Remaining stock and bottom reserve are independently validated against the bucket's current capacity in the form, backend and database. Lowering capacity below stock requires an explicit corrected stock value, never silent truncation. Raising capacity never fills or scales stock. The global 1,000,000mL technical bound is shared; there is no 1000/500mL input cap.

## Consumption

Consumption is replayed from the latest manual confirmation using exact timestamps, with day boundaries at Asia/Taipei midnight. Estimated usage is uniform over elapsed time at the **effective** daily rate; an enabled flag plus `pausedDays > 0` means zero effective dose until explicitly resumed. This does not infer a pause end date.

The existing ml/day setting is a complete daily total: if a pump runs several times, enter their sum, not one execution's amount. There is no separate intraday pump scheduling model in this app; weekly additive reference schedules must not be added to this total again. Missing, blank, negative or invalid daily settings are unknown, not zero, and unknown periods are not deducted.

Rate/enable changes are timestamped, so late offline events recalculate the affected estimates using the correct historical rate. Differences are appended as corrections, not duplicate debits. Calibration resets the baseline; refill and capacity changes are replayed in order, including events on the same day. Remaining stock is clamped to [0, capacity]. If a historical correction makes an earlier refill exceed capacity, the result is flagged for manual confirmation.

Missing/invalid temporal history produces a data gap, skips deduction for the unknown interval and labels the result as an **upper bound**, with no days forecast. A manual calibration clears earlier gaps prospectively. Disabling inventory tracking does not disable dosing; if dosing continues during that gap, calibration is required. Changes made directly on a pump must be confirmed manually.

The daily Vercel job calls `/api/internal/reservoirs/reconcile` at `0 16 * * *` UTC (Taipei midnight; Hobby execution may occur later within the hour). Set a separate random `CRON_SECRET` in Vercel Production. Opening the dosing page, returning to foreground and GPT context reads also catch up. Repeated calls cannot double-debit. No push/email service is added; warnings are persistent in the app/API.

## API

Existing management session and CORS rules apply. These endpoints are never exposed as GPT write actions:

- `GET /api/internal/reservoirs/{tankId}`: reconcile and list.
- `POST /api/internal/reservoirs/{tankId}/operations`: `idempotencyKey`, `reservoirId`, `type`, fields below. Reuse the exact key/body on a network retry.
- `GET /api/internal/reservoirs/{tankId}/{reservoirId}/history[/{beforeSequence}]`: immutable audit, 100 entries plus `nextCursor`.
- `GET /api/internal/reservoirs/reconcile`: separate cron Bearer secret.

Operation types: `calibrate {amountMl}`, `refill {amountMl}`, `capacity {capacityMl, correctedRemainingMl?}`, `reserve {bottomReserveMl}`, `threshold {alertThresholds:{reminderDays,warningDays,urgentDays}}`, `tracking {active}`, `delete`, `create {name,doseKey,capacityMl,bottomReserveMl?,alertThresholds?}`. The old percentage-only threshold request is rejected. Reducing capacity below stock requires an explicit corrected amount; reduce reserve first if it would exceed the new capacity. A live daily-dose key can only link one bucket, including the existing `custom` key; deleted links may be replaced. Maximum 30 live buckets per tank.

For future device integration, `execution {start, end, records:[{id, executedAt, amountMl}]}` asserts **complete** device coverage of [start,end), including zero-execution periods. Each pulse is timestamped; duplicate IDs and overlapping coverage are rejected. Partial logs must not be submitted as complete coverage. Actual coverage replaces estimates, never adds to them. No hardware connector is installed by this change.

## GPT

Existing operation IDs and routes stay unchanged. `reservoirInventory` contains provenance, calculation/confirmation times, display-only percent, configured/effective daily totals, bottom reserve, usable mL, raw days, thresholds, alert level/label/reason. No percentage-based alarm is produced. Inventory never changes engine output or daily settings.

`engines/reservoirAlertEngine.js` is the common inventory safety classifier used by the inventory engine and the approved-dose forecast in GPT context. The UI renders its API-provided result, rather than reclassifying rounded numbers. Usable mL = max(remaining - reserve, 0), with reserve default 0. Divide by the effective daily total without rounding. Defaults: >30 normal; (14,30] reminder; (7,14] warning; <=7 urgent. Validate reminder > warning > urgent > 0. Display days with one decimal only. Zero effective dose is not_dosing, null stock is pending_initialization, invalid/missing dose is unavailable. Unknown inventory intervals require confirmation. Stock and days are calculations, never liquid-level sensor measurements.

A valid engine-approved new dose is evaluated with the same reserve and custom day thresholds. Its supply risk is explicitly conditional on applying that dose; neither its forecast nor inventory alerts can alter the approved dose or bypass canAdjust=false/null guards.

Re-import the existing `/api/openapi` URL in GPT Actions to update the response schema and instructions. The token and authentication stay the same. Policy instructs GPT to include inventory warnings in every water analysis, distinguish measurement/sync/inventory confirmation times, and never invent a dose when `canAdjust=false` or the suggestion is null. LLM compliance is not an enforced controller; GPT remains read-only.

## Verification

### Home Focus Reminders (1.5.1)

The existing weekly-focus card consumes the same inventory-controller snapshot as the dosing page. `components/reservoirFocusModule.js` only presents server-provided statuses and raw day estimates; it never deducts inventory or defines a second set of thresholds. Existing 30/14/7-day defaults and per-reservoir custom thresholds remain unchanged. Urgent/depleted messages precede the water focus, while warning/procurement and incomplete-data messages follow it. Normal inventories add no markup. Multiple reservoirs are merged by severity and sorted by raw days. Links navigate to the current tank's existing dosing page.

Both home and dosing pages refresh through the existing authenticated inventory client on navigation, foreground return and completed cloud sync. Refill/calibration responses publish directly to both views. A local dose that does not match the last server snapshot produces a data-update prompt rather than an old day estimate; the completed sync fetches a new forecast using the existing historical consumption timeline. Stopped/zero-dose reservoirs do not generate depletion reminders. Unknown stock/rates, failed reads and unconfirmed operations never become zero stock or a normal status. No new API, migration, notification channel or dosing mutation is introduced. `tests/reservoirFocus.test.mjs` covers presentation, thresholds, selected-tank isolation and the repository's refill/calibration/piecewise-dose update behavior.

Run `npm test`, `npm run build`, then `vercel build --prod` and `npm run test:cloud-bundle` before deploying. `tests/reservoir.test.mjs` covers pure replay and real PostgreSQL semantics through PGlite. Never run calibration/refill fixtures against production.

## Refill, Calibration and Correction History (1.5.0)

On the existing dosing page, expand a reservoir and use **添加滴定液** to enter the amount being added, not the resulting total. Notes are optional. The server records the timestamp; the UI displays Asia/Taipei date and time, with no backdating field. Missing stock or a data gap requires **校正剩餘量** first. Defaults remain KH/CA/MG 1500mL and A+/K+ 800mL; custom capacities and existing quantities are preserved. The backend and form enforce current capacity without silently clipping a new refill.

Each card shows the latest refill time/amount and separate expandable **添加歷史** and **校正歷史**. The entire manual history is returned from PostgreSQL, newest first, and survives refresh/device changes. Original event amounts, before/after balances and provenance remain immutable. Old metadata is recovered from existing audit rows when available; unknown values remain unknown. No historical refills are invented.

New refill fields: `refill {amountMl, notes?}`. Calibration supports `calibrate {amountMl, reason?}`; the current UI requires a reason for subsequent corrections of the live stock, while older clients remain compatible. Manual operation timestamps are server-owned; client date fields are ignored.

To fix a mistaken refill/calibration, expand its **更正此紀錄** form. Submit `correct {targetEventId, targetType, expectedRevisionId, amountMl, notes?, reason}` through the same existing management operation API. `targetType` is `refill` or `calibrate`; a non-empty correction reason is required. The original entry remains, with a new immutable correction event and the previous/new amounts, notes, reason and current-balance impact. The expected revision prevents one device from overwriting another edit. Reuse the same idempotency key/body on retry. Stock, correction audit, any consumption reconciliation and alert changes commit together. If the corrected timeline would overflow historical capacity, the entire operation is rejected. Corrections recompute the timeline using historical rates, not a simple delta applied to today's depleted balance; later manual calibrations remain authoritative.

Migration **004_reservoir_history.js** adds only a repeatable partial index over existing manual audit entries. No table is dropped, no remaining quantity is initialized, and no existing water/dosing/audit payload is rewritten. It runs on the first authenticated inventory use or via the existing migration command. Refill/calibration/correction events stay in `dosing_reservoirs.data.manualEvents` and the atomic append-only `reservoir_transactions` ledger; no separate duplicate source of truth is introduced.

The cloud save path preserves existing `dosingHistory` and automatically adds a missing change event when an older client changes a setting without supplying a valid timeline. Normal current clients already record the setting time automatically, so their event is not duplicated. Unchanged settings do not add events. Entries expose previous/new configured mL/day, signed change, recorded time, setting-effective time, source, enable/pause states and device synchronization status. The setting timestamp is not confirmation of the physical dosing pump. A server-observed change with unknown prior timing creates an explicit inventory data gap rather than guessing when a past pump change took effect. Water measurement `date` stays separate; date-only measurements cannot establish ordering relative to a same-day dosing change.

Existing REST context operations and MCP tools return full `dosingHistory`, `dosingAdjustmentHistory`, `dosingTimingPolicy` and each reservoir's `lastRefill`, `lastRefilledAmountMl`, `refillHistory`, `calibrationHistory` and nested correction audit. No recent-only cutoff is applied to these histories. Explicit freshwater tanks are excluded from reef inventory and reef context results. Authentication and read-only permissions are unchanged; no new GPT write tool is added. OpenAPI documents the additive fields. Days-based alerts and the dosing safety engine are unchanged.

`tests/reservoirHistory.test.mjs` covers additive refill arithmetic, defaults/overflow, concurrent idempotency, Taipei midnight, corrections and immutable audit, later-calibration precedence, corrected depletion replay, legacy recovery, full authenticated API history, server-captured dose changes, piecewise rates, zero dosing and freshwater isolation. Test data is confined to in-memory PGlite.

## Changed Files

New: `modules/reservoirModule.js`, `engines/reservoirEngine.js`, `migrations/001_reservoir_inventory.js`, `server/reservoirRepository.js`, `components/reservoirComponent.js`, `scripts/migrateReservoirs.mjs`, `tests/reservoir.test.mjs`, this document.

Integration: `services/tankStore.js`, `services/adminCloudService.js`, `services/reefGptContextService.js`, `services/reefGptApiService.js`, `server/cloudRepository.js`, `server/cloudHandler.js`, `server/index.js`, `api/index.js`, `app.module.js`, `app.js`, `index.html`, `styles.css`, `sw.js`, `vercel.json`, `scripts/checkCloudBundle.mjs`, `package.json`, `package-lock.json`, `version.json`.

Version 1.3.0 adds the corrected capacity migration, shared day-alert classifier, zero-default reserve and editable day thresholds. Tests cover raw threshold boundaries, the 100mL examples, missing/zero/invalid rates, migrated history preservation, custom capacities, capacity limits, reserve, API/UI/GPT consistency and idempotent replenishment/reconciliation. Device imports are tested locally, not with a real pump. GPT response wording still depends on the GPT following its read-only schema/policy.
