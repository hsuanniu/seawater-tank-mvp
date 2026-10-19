# Direct Reef MCP Connection

The existing Vercel project now supports `https://reef-tank-cloud.vercel.app/api/mcp` using the official MCP SDK's stateless Streamable HTTP transport. All existing REST/GPT Actions endpoints remain unchanged.

## Tools and Data

- `listReefTanks`
- `getActiveReefContext`
- `getReefTankContext({ tankId })`

These call the existing GPT context service and safety engine. No tools modify dosing settings, water records, or equipment. Inventory reads preserve the existing automatic estimated-consumption reconciliation, so the MCP annotations deliberately do **not** claim zero state changes. Existing `canAdjust=false` / `suggestedDoseMlPerDay=null` behavior, inherited measurement provenance, effective dosing, timestamps, and day-based inventory warnings remain intact.

## Authentication

OAuth authorization-code flow with mandatory S256 PKCE and the single `reef:read` scope. The owner confirms using the existing cloud management password on the Vercel authorization page; no new account is required. The management password and original GPT read token never appear in the plugin or model arguments. Neither original credential is accepted directly as an MCP access token.

Discovery endpoints:

- `/.well-known/oauth-protected-resource/api/mcp`
- `/.well-known/oauth-authorization-server`
- `/register`, `/authorize`, `/token`, `/revoke`

Registration supports ChatGPT HTTPS callbacks and local Codex loopback callbacks only. Authorization requires a same-origin POST, an HttpOnly SameSite cookie, a short-lived request-bound consent ticket, and the existing password. Authorization codes and refresh exchanges are single-use and atomic. Access tokens expire after 30 minutes; refresh authorization expires after 30 days. Rotating either existing server credential invalidates MCP connections; they must reconnect. OAuth client credentials are encrypted at rest, and issued bearer tokens are stored only as hashes. Revoking a token revokes its connection family.

Migration 003 creates only `reef_mcp_auth_records`, separate from water, dosing, inventory and management sessions. Run `npm run db:migrate:mcp` with server-only `DATABASE_URL`, or let the auth repository initialize its own schema. It does not change existing data. Expired authorization rows are cleaned during new authorizations/client registrations.

## Plugin Update

Keep the existing private analysis plugin identity and audience. Replace its old assistant App dependency with the verified Vercel MCP endpoint and OAuth discovery. Keep the old assistant installed as fallback until the new plugin has been authorized and tested in a fresh chat. Do not delete or replace the original Vercel/Neon deployment.

Any update must preserve the plugin's assets, knowledge files, presentation, and default prompts. An account update archive is a partial overlay, not a new plugin. Read back the stored files and verify that the former assistant App dependency is absent before calling the migration complete.

## Validation

`npm run build` includes MCP/OAuth tests using a memory-only PGlite database and local HTTP server. These verify discovery, denied credentials, password consent, CSRF, scopes, resource and redirect binding, PKCE, replay/concurrency, refresh/revocation/expiry, confidential client encryption, official SDK interoperability, and real inventory integration without modifying water/dosing state.

After `vercel build --prod`, run `npm run test:cloud-bundle` to check both function bundles and routing. Production verification must never log credentials. It may create short-lived test-only OAuth records, but must preserve existing water state and dosing. ChatGPT user consent is still needed for the real plugin connection.
## Plugin Source

`integrations/reef-analysis-plugin/` is a partial update package for the existing
private plugin, not a new plugin. The account update preserves the existing icon,
agent metadata and knowledge index, and explicitly removes only `.app.json`.
Do not install this partial directory as a complete standalone package: its
unchanged assets are retained by Plugin Creator during the guarded update.

