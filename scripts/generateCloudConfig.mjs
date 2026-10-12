import { writeFile } from "node:fs/promises";
import { deploymentCloudConfig } from "../services/cloudConfigService.js";

const config = deploymentCloudConfig(process.env);
await writeFile(new URL("../cloud-config.json", import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
