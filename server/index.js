import { createServer } from "node:http";
import { neon } from "@neondatabase/serverless";
import { createCloudRepository } from "./cloudRepository.js";
import { cloudServerConfig, createReefCloudHandler, MAX_BODY_BYTES } from "./cloudHandler.js";

const config = cloudServerConfig(process.env);
const repository = process.env.DATABASE_URL ? createCloudRepository(neon(process.env.DATABASE_URL)) : null;
const handler = createReefCloudHandler({ ...config, repository });

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        outgoing.writeHead(413, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"error":"PAYLOAD_TOO_LARGE"}');
        return;
      }
      chunks.push(chunk);
    }
    const method = incoming.method;
    const request = new Request(new URL(incoming.url, config.publicUrl), {
      method, headers: incoming.headers,
      ...(!["GET", "HEAD"].includes(method) ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    outgoing.end('{"error":"CLOUD_UNAVAILABLE"}');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT || 10000), "0.0.0.0", () => console.log("Reef cloud API ready"));
