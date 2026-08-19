import { serve } from "@hono/node-server";
import { SECRET } from "./config.ts";
import { HOST, PORT } from "./env.ts";
import { createApp, VERSION } from "./http/app.ts";
import { adoptOrphanedAssets, assetPath } from "./images.ts";
import { createServices } from "./services.ts";

const services = createServices();
const app = createApp(services);
services.store.pruneMissingImageAssets((id) => Boolean(assetPath(id)));
const adopted = adoptOrphanedAssets(services.store);

const mcpTools = await services.mcp.connect();
const connected = services.mcp.status().filter((server) => server.connected).length;

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, ({ port }) => {
  console.log(`Luma ${VERSION} — http://${HOST}:${port}`);
  console.log(`Access code: ${services.vault.get(SECRET.accessCode)}`);
  console.log(`MCP: ${connected} connected, ${mcpTools.length} tools`);
  if (adopted) console.log(`Library: adopted ${adopted} generated images`);
  console.log(`Models: ${services.store.listModels().filter((model) => model.enabled).length} enabled`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await services.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
