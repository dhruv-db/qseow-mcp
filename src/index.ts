#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { QrsClient } from "./qrs.js";
import { ProxySession } from "./session.js";
import { EngineClient } from "./engine.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAnalystTools } from "./tools/analyst.js";
import { registerDeveloperTools } from "./tools/developer.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = new McpServer({ name: "qlik-sense-mcp", version: "0.1.0" });

  const session = cfg.authMode === "jwt" ? new ProxySession(cfg) : undefined;
  const qrs = new QrsClient(cfg, session);
  const engine = new EngineClient(cfg, session);

  if (cfg.toolGroups.has("admin")) registerAdminTools(server, qrs, cfg);
  if (cfg.toolGroups.has("analyst")) registerAnalystTools(server, engine);
  if (cfg.toolGroups.has("developer")) registerDeveloperTools(server, engine, qrs, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `qlik-sense-mcp 0.1.0 | host=${cfg.host} auth=${cfg.authMode}` +
    ` groups=[${[...cfg.toolGroups].join(",")}] mutations=${cfg.allowMutations ? "ENABLED" : "read-only"}`,
  );

  const shutdown = async () => { await engine.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
