import { neon } from "@neondatabase/serverless";
import { cloudServerConfig } from "../server/cloudHandler.js";
import { createCloudRepository } from "../server/cloudRepository.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";
import { createMcpAuthRepository } from "../server/mcpAuthRepository.js";
import { createReefMcpApp } from "../server/reefMcpServer.js";
// Trace browser-versioned engine imports just as the existing REST entry does.
import "../engines/stabilityEngine.js";
import "../engines/safetyEngine.js";

let app;
export default function handler(req, res) {
  try {
    if (!app) {
      const config = cloudServerConfig(process.env);
      const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
      const repository = sql ? createCloudRepository(sql) : null;
      app = createReefMcpApp({ ...config, repository, authStore: sql ? createMcpAuthRepository(sql) : null,
        inventory: sql ? createReservoirRepository(sql, repository) : null });
    }
    return app(req, res);
  } catch {
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end('{"error":"MCP_UNAVAILABLE"}');
  }
}
