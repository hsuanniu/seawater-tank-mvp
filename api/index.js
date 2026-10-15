import { neon } from "@neondatabase/serverless";
import { createCloudRepository } from "../server/cloudRepository.js";
import { cloudServerConfig, createReefCloudHandler } from "../server/cloudHandler.js";
import { createReservoirRepository } from "../server/reservoirRepository.js";
// Expose browser-versioned imports to Vercel's server file tracer without changing the engines.
import "../engines/stabilityEngine.js";
import "../engines/safetyEngine.js";

let handler;

export default {
  fetch(request) {
    if (!handler) {
      const config = cloudServerConfig(process.env);
      const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
      const repository = sql ? createCloudRepository(sql) : null;
      const inventory = sql ? createReservoirRepository(sql, repository) : null;
      handler = createReefCloudHandler({ ...config, repository, inventory, cronSecret: process.env.CRON_SECRET });
    }
    return handler(request);
  },
};
