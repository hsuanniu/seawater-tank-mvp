# Read Token Connection Verification

`GET /api/gpt/auth/verify` accepts the existing `Authorization: Bearer <read token>`
header. A valid credential returns `200` with
`{"authenticated":true,"scope":"reef:read"}`. Missing/invalid credentials return
`401`, missing server configuration returns `503`, non-GET methods return `405`,
and query parameters are rejected.

This route returns before loading state, running migrations, reconciling
inventory, or reading any database table. Repeated connection checks therefore
cannot deduct inventory. It does not issue, rotate, or save credentials.

The existing three GPT Actions and three MCP tools remain unchanged. The new
connection-only route is deliberately not advertised as an extra analysis tool.
The Site stores a user-supplied credential only after checking the exact success
response. API verification and Site credential-storage failures have separate,
sanitized error codes; neither logs nor error responses may include credentials.

Verification of actual water-data tools is separate: those existing queries can
reconcile estimated inventory, so do not call them during a no-database-write
connection check.
