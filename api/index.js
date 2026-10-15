import { neon } from "@neondatabase/serverless";
import { createCloudRepository } from "../server/cloudRepository.js";
import { cloudServerConfig, createReefCloudHandler } from "../server/cloudHandler.js";
// Expose browser-versioned imports to Vercel's server file tracer without changing the engines.
import "../engines/stabilityEngine.js";
import "../engines/safetyEngine.js";

let handler;

export default {
  fetch(request) {
    if (!handler) {
      const config = cloudServerConfig(process.env);
      const repository = process.env.DATABASE_URL ? createCloudRepository(neon(process.env.DATABASE_URL)) : null;
      handler = createReefCloudHandler({ ...config, repository });
    }
    return handler(request);
  },
};
