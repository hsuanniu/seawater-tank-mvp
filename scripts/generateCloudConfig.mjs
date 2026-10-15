import { readFile, writeFile } from "node:fs/promises";
import { deploymentCloudConfig } from "../services/cloudConfigService.js";

let defaults = null;
try { defaults = JSON.parse(await readFile(new URL("../cloud-config.defaults.json", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const config = deploymentCloudConfig(process.env, defaults);
await writeFile(new URL("../cloud-config.json", import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
