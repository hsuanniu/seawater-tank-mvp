import { neon } from "@neondatabase/serverless";
import { migrateMcpAuthorization } from "../migrations/003_mcp_authorization.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required on the server");
await migrateMcpAuthorization(neon(process.env.DATABASE_URL));
console.log("MCP authorization storage ready. Existing water, dosing and inventory records were not changed.");
