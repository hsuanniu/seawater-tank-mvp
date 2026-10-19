import { neon } from "@neondatabase/serverless";
import { migrateReservoirInventory } from "../migrations/001_reservoir_inventory.js";
import { migrateReservoirDayAlerts } from "../migrations/002_reservoir_day_alerts.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no data was changed");
const sql = neon(process.env.DATABASE_URL);
await migrateReservoirInventory(sql);
await migrateReservoirDayAlerts(sql);
console.log("Inventory migration completed: corrected legacy default capacities and switched to day alerts. Stock and water/dosing records preserved.");
