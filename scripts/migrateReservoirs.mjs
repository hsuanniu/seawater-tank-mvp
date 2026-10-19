import { neon } from "@neondatabase/serverless";
import { migrateReservoirInventory } from "../migrations/001_reservoir_inventory.js";
import { migrateReservoirDayAlerts } from "../migrations/002_reservoir_day_alerts.js";
import { migrateReservoirHistory } from "../migrations/004_reservoir_history.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no data was changed");
const sql = neon(process.env.DATABASE_URL);
await migrateReservoirInventory(sql);
await migrateReservoirDayAlerts(sql);
await migrateReservoirHistory(sql);
console.log("Inventory migrations completed, including the additive manual-history index. Stock and water/dosing histories preserved.");
