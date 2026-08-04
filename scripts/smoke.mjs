#!/usr/bin/env node
// Integration smoke test: spawns the MCP server over stdio and exercises
// admin + developer + analyst tools against a live QSEoW site.
// Requires env (see .env.example) and reachable QRS/engine ports.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const APP_NAME = process.env.SMOKE_APP_NAME || "MCP Smoke Demo";
const DEMO_SCRIPT = `
Sales:
LOAD * INLINE [
Region,Product,Month,Sales
East,Widget,Jan,120
East,Gadget,Jan,90
West,Widget,Jan,150
West,Gadget,Jan,70
East,Widget,Feb,130
East,Gadget,Feb,110
West,Widget,Feb,160
West,Gadget,Feb,95
];
`;

const t0 = Date.now();
const log = (label, v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}: ${s.length > 400 ? s.slice(0, 400) + "…" : s}`);
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
};

let failures = 0;
const step = async (label, fn) => {
  try {
    const v = await fn();
    log(`PASS ${label}`, v ?? "");
    return v;
  } catch (e) {
    failures++;
    log(`FAIL ${label}`, e.message);
    return undefined;
  }
};

// ---- admin
const tools = await client.listTools();
log("tools registered", tools.tools.map((t) => t.name).join(", "));
await step("qrs_about", () => call("qrs_about"));
await step("service_status", () => call("service_status"));
await step("license_summary", async () => {
  const r = await call("license_summary");
  return JSON.parse(r).serial;
});

// ---- developer: create demo app if absent
let appId;
await step("find-or-create demo app", async () => {
  const apps = JSON.parse(await call("list_apps", { filter: `name eq '${APP_NAME}'` }));
  if (apps.length > 0) { appId = apps[0].id; return `exists ${appId}`; }
  const created = JSON.parse(await call("create_app", { name: APP_NAME, script: DEMO_SCRIPT, reload: true }));
  appId = created.appId;
  return `created ${appId} reloaded=${created.reloaded}`;
});

if (appId) {
  await step("check_script", () => call("check_script", { appId }));
  await step("get_app_data_model", async () => {
    const m = JSON.parse(await call("get_app_data_model", { appId }));
    return m.tables.map((t) => `${t.name}(${t.rows} rows)`).join(",");
  });
  await step("evaluate_expression Sum(Sales)", () => call("evaluate_expression", { appId, expression: "Sum(Sales)" }));
  await step("create_hypercube Region x Sum(Sales)", () =>
    call("create_hypercube", { appId, dimensions: ["Region"], measures: ["Sum(Sales)"] }));
  await step("select East", () => call("select_field_values", { appId, field: "Region", values: ["East"] }));
  await step("hypercube honors selection", async () => {
    const r = JSON.parse(await call("create_hypercube", { appId, dimensions: ["Product"], measures: ["Sum(Sales)"] }));
    return JSON.stringify(r.rows);
  });
  await step("current selections", () => call("get_current_selections", { appId }));
  await step("clear selections", () => call("clear_selections", { appId }));
  await step("get_field_values Month", () => call("get_field_values", { appId, field: "Month" }));
}

await client.close();
console.log(failures === 0 ? "SMOKE: ALL PASS" : `SMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
