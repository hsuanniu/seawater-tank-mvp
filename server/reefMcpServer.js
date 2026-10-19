import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpAuthProvider, REEF_MCP_SCOPE } from "./mcpAuthProvider.js";
import { createReefGptHandler } from "../services/reefGptApiService.js";

const tools = {
  listReefTanks: { title: "列出海水缸", path: () => "/tanks", schema: z.object({}).strict() },
  getActiveReefContext: { title: "讀取目前魚缸完整資料", path: () => "/context", schema: z.object({}).strict() },
  getReefTankContext: { title: "讀取指定魚缸完整資料", path: ({ tankId }) => `/tanks/${encodeURIComponent(tankId)}/context`, schema: z.object({ tankId: z.string().min(1).max(100) }).strict() },
};

export function createReefMcpApp({ authStore, repository, inventory, adminPassword, readToken, publicUrl, appOrigin, now = () => Date.now() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  const mcpUrl = new URL(`${publicUrl}/api/mcp`);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const provider = createMcpAuthProvider({ store: authStore, adminPassword, readToken, publicUrl, now });
  const read = createReefGptHandler({ token: readToken, ownerUserId: "personal", baseUrl: `${publicUrl}/api/gpt`,
    loadOwnedState: () => inventory ? inventory.contextState() : repository.load(), now: () => new Date(now()) });

  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (!authStore || !repository || !adminPassword || !readToken) return res.status(503).json({ error: "MCP_CONNECTION_NOT_CONFIGURED" });
    next();
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: mcpUrl,
    scopesSupported: [REEF_MCP_SCOPE], resourceName: "Reef Tank Controller 唯讀資料", clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
  const authenticate = requireBearerAuth({ verifier: provider, requiredScopes: [REEF_MCP_SCOPE], resourceMetadataUrl, expectedResource: mcpUrl });
  app.all("/api/mcp", (req, res, next) => {
    const allowedOrigins = [new URL(publicUrl).origin, appOrigin, "https://chatgpt.com", "https://chat.openai.com"];
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
    if (req.url.includes("?")) return res.status(400).json({ error: "QUERY_PARAMETERS_NOT_SUPPORTED" });
    next();
  }, authenticate, express.json({ limit: "64kb" }), async (req, res, next) => {
    if (req.method !== "POST") return res.set("Allow", "POST").status(405).json({ error: "METHOD_NOT_ALLOWED" });
    const server = new McpServer({ name: "reef-tank-cloud", version: "1.4.0" }, { instructions: "僅查詢既有海水缸。區分測量與同步時間、實測與沿用值、設定與有效滴定量。只能引用安全引擎核准的新劑量；canAdjust=false 或建議=null 不得自算。庫存為推估，依天數告警，不得因庫存修改滴定量。" });
    for (const [name, tool] of Object.entries(tools)) server.registerTool(name, {
      title: tool.title,
      description: `${tool.title}。不能修改水質、滴定或控制設備。查詢會依既有規則補算及保存推估庫存，不是液位實測。canAdjust=false 或建議=null 時不可自算新劑量。`,
      inputSchema: tool.schema,
      outputSchema: z.object({}).passthrough(),
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [REEF_MCP_SCOPE] }] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (args) => {
      const response = await read(new Request(`${publicUrl}/api/gpt${tool.path(args)}`, { headers: { Authorization: `Bearer ${readToken}` } }));
      const data = await response.json();
      if (!response.ok) return { isError: true, content: [{ type: "text", text: `無法讀取海水缸資料：${data.error || "DATA_UNAVAILABLE"}` }] };
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedHosts: [mcpUrl.host], allowedOrigins: [new URL(publicUrl).origin, appOrigin, "https://chatgpt.com", "https://chat.openai.com"].filter(Boolean) });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch (error) { next(error); }
  });
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 503;
    res.status(status).json({ error: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "MCP_UNAVAILABLE" });
  });
  return app;
}
