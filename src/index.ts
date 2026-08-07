#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { QrsClient } from "./qrs.js";
import { ProxySession } from "./session.js";
import { EngineClient } from "./engine.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAnalystTools } from "./tools/analyst.js";
import { registerDeveloperTools } from "./tools/developer.js";
import { registerInspectorTools } from "./tools/inspector.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerBuilderTools } from "./tools/builder.js";

// Single source of truth for the version: package.json (dist/ sits one level
// below it both in the repo and in the npm tarball).
const VERSION: string = createRequire(import.meta.url)("../package.json").version;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = new McpServer({ name: "qseow-mcp", version: VERSION });

  const session = cfg.authMode === "jwt" ? new ProxySession(cfg) : undefined;
  const qrs = new QrsClient(cfg, session);
  const engine = new EngineClient(cfg, session);

  // Mutating tools are gated at REGISTRATION: with mutations disabled they
  // are never added to the server, so tools/list is honestly read-only.
  if (cfg.toolGroups.has("admin")) {
    registerAdminTools(server, qrs, cfg);
    // Ops layer (Tier 2): reload forensics, engine health, security-rule
    // audit, QPS sessions. Read-only except end_user_sessions (mutation-gated).
    registerOpsTools(server, qrs, cfg, session);
  }
  if (cfg.toolGroups.has("analyst")) {
    registerAnalystTools(server, engine);
    // The troubleshooting loop (sheets, objects, expression search, master
    // items, lineage) ships with the analyst group: read-only introspection.
    registerInspectorTools(server, engine);
  }
  if (cfg.toolGroups.has("developer")) {
    registerDeveloperTools(server, engine, qrs, cfg);
    // UI builder + render-validation gate. validate_sheet is read-only and
    // always registers with the group; create/add are mutation-gated inside.
    registerBuilderTools(server, engine, qrs, cfg);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `qseow-mcp ${VERSION} | host=${cfg.host} auth=${cfg.authMode}` +
    ` groups=[${[...cfg.toolGroups].join(",")}] mutations=${cfg.allowMutations ? "ENABLED" : "read-only (mutating tools not registered)"}`,
  );

  const shutdown = async () => { await engine.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
