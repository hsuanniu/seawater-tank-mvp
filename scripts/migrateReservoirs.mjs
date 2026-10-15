import { neon } from "@neondatabase/serverless";
import { migrateReservoirInventory } from "../migrations/001_reservoir_inventory.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no data was changed");
await migrateReservoirInventory(neon(process.env.DATABASE_URL));
console.log("Inventory migration completed. Existing water/dosing records unchanged; no stock was initialized.");
