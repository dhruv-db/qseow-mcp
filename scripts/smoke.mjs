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

const MUTATING = ["set_script", "reload_app", "create_app", "copy_app", "publish_app", "delete_app", "start_task"];

await step("annotations present on every tool", () => {
  const missing = tools.tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean");
  if (missing.length) throw new Error(`no annotations: ${missing.map((t) => t.name).join(",")}`);
  const wrongRead = tools.tools.filter((t) => MUTATING.includes(t.name) && t.annotations.readOnlyHint !== false);
  if (wrongRead.length) throw new Error(`mutating tool marked read-only: ${wrongRead.map((t) => t.name).join(",")}`);
  return `${tools.tools.length} tools annotated`;
});

await step("read-only server registers no mutating tools", async () => {
  const roEnv = { ...process.env };
  delete roEnv.QSEOW_ALLOW_MUTATIONS;
  const roTransport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"], env: roEnv, stderr: "ignore",
  });
  const roClient = new Client({ name: "smoke-ro", version: "0.0.1" });
  await roClient.connect(roTransport);
  try {
    const roTools = (await roClient.listTools()).tools.map((t) => t.name);
    const leaked = MUTATING.filter((m) => roTools.includes(m));
    if (leaked.length) throw new Error(`mutating tools visible read-only: ${leaked.join(",")}`);
    return `${roTools.length} tools, zero mutating`;
  } finally {
    await roClient.close();
  }
});

await step("qrs_about", () => call("qrs_about"));
await step("service_status", () => call("service_status"));
await step("license_summary", async () => {
  const r = await call("license_summary");
  return JSON.parse(r).serial;
});

await step("pagination envelope (list_apps limit=1)", async () => {
  const page = JSON.parse(await call("list_apps", { limit: 1 }));
  if (!Array.isArray(page.items) || typeof page.total !== "number" || page.returned > 1) {
    throw new Error(`bad envelope: ${JSON.stringify(page).slice(0, 200)}`);
  }
  return `total=${page.total} returned=${page.returned} truncated=${page.truncated}`;
});

await step("qrs_search dataconnection full:true redacts secrets", async () => {
  const raw = await call("qrs_search", { entity: "dataconnection", full: true });
  const leaks = raw.match(/"(password|passphrase|clientsecret)"\s*:\s*"(?!\*\*\*REDACTED\*\*\*")[^"]+"/gi) ?? [];
  const kvLeaks = raw.match(/\b(pwd|password|apikey)\s*=\s*(?!\*\*\*REDACTED\*\*\*)[^;"'\s*]+/gi) ?? [];
  if (leaks.length || kvLeaks.length) throw new Error(`unredacted: ${[...leaks, ...kvLeaks].slice(0, 3).join(" | ")}`);
  return `clean (${raw.length} chars scanned)`;
});

// ---- developer: create demo app if absent
let appId;
await step("find-or-create demo app", async () => {
  const apps = JSON.parse(await call("list_apps", { filter: `name eq '${APP_NAME}'` }));
  if (apps.items.length > 0) { appId = apps.items[0].id; return `exists ${appId}`; }
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
  await step("select East", async () => {
    const r = JSON.parse(await call("select_field_values", { appId, field: "Region", values: ["East"] }));
    if (r.selectedCount !== 1) throw new Error(`expected selectedCount 1, got ${r.selectedCount}`);
    return `mode=${r.mode} selectedCount=${r.selectedCount}`;
  });
  await step("hypercube honors selection", async () => {
    const r = JSON.parse(await call("create_hypercube", { appId, dimensions: ["Product"], measures: ["Sum(Sales)"] }));
    return JSON.stringify(r.rows);
  });
  await step("numeric selection lands exactly (Sales=120)", async () => {
    // Regression for the silent-widening bug: text-only qText against a
    // numeric field selects nothing/widens without error. Numeric dual must
    // select exactly one value.
    await call("clear_selections", { appId });
    const r = JSON.parse(await call("select_field_values", { appId, field: "Sales", values: [120] }));
    if (r.selectedCount !== 1) throw new Error(`expected selectedCount 1, got ${r.selectedCount} (mode=${r.mode})`);
    const ev = JSON.parse(await call("evaluate_expression", { appId, expression: "Sum(Sales)" }));
    if (Number(ev.value) !== 120) throw new Error(`Sum(Sales) under selection = ${ev.value}, want 120`);
    return `mode=${r.mode} selectedCount=1 Sum=120`;
  });
  await step("numeric-looking text via string also lands", async () => {
    await call("clear_selections", { appId });
    const r = JSON.parse(await call("select_field_values", { appId, field: "Sales", values: ["150"] }));
    if (r.selectedCount !== 1) throw new Error(`expected selectedCount 1, got ${r.selectedCount} (mode=${r.mode})`);
    return `mode=${r.mode} selectedCount=1`;
  });
  await step("current selections", () => call("get_current_selections", { appId }));
  await step("clear selections", () => call("clear_selections", { appId }));
  await step("get_field_values Month", () => call("get_field_values", { appId, field: "Month" }));
}

// ---- explicit coverage: remaining list tools (envelope shape asserted)
const envelope = (r) => {
  const p = JSON.parse(r);
  if (!Array.isArray(p.items) || typeof p.total !== "number") throw new Error(`bad envelope: ${r.slice(0, 120)}`);
  return p;
};
await step("list_streams", async () => `total=${envelope(await call("list_streams", {})).total}`);
await step("list_tasks", async () => `total=${envelope(await call("list_tasks", {})).total}`);
await step("list_users", async () => `total=${envelope(await call("list_users", {})).total}`);
await step("list_extensions", async () => `total=${envelope(await call("list_extensions", {})).total}`);
await step("list_data_connections redacts", async () => {
  const raw = await call("list_data_connections", {});
  const p = envelope(raw);
  const kvLeaks = raw.match(/\b(pwd|password|apikey)\s*=\s*(?!\*\*\*REDACTED\*\*\*)[^;"'\s*]+/gi) ?? [];
  if (kvLeaks.length) throw new Error(`unredacted: ${kvLeaks.slice(0, 2).join(" | ")}`);
  return `total=${p.total} clean`;
});
await step("list_engine_apps", async () => `total=${envelope(await call("list_engine_apps", {})).total}`);

// ---- mutation lifecycle on a disposable copy: copy -> set_script ->
// reload -> evaluate -> publish -> delete. Leaves the site as it found it.
const COPY_NAME = `MCP Smoke Copy`;
const COPY_SCRIPT = `S: LOAD * INLINE [Sales\n42\n];`;
let copyId;
await step("copy_app", async () => {
  const r = JSON.parse(await call("copy_app", { appId, name: COPY_NAME }));
  copyId = r.newAppId;
  if (!copyId) throw new Error("no newAppId");
  return copyId;
});
if (copyId) {
  await step("set_script on copy", () => call("set_script", { appId: copyId, script: COPY_SCRIPT }));
  await step("reload_app on copy", async () => {
    const r = JSON.parse(await call("reload_app", { appId: copyId }));
    if (!r.reloadSuccess) throw new Error("reload failed");
    return `reloadSuccess=${r.reloadSuccess}`;
  });
  await step("copy reflects new script (Sum(Sales)=42)", async () => {
    const ev = JSON.parse(await call("evaluate_expression", { appId: copyId, expression: "Sum(Sales)" }));
    if (Number(ev.value) !== 42) throw new Error(`Sum(Sales)=${ev.value}, want 42`);
    return "Sum=42";
  });
  await step("publish_app copy to Everyone", async () => {
    const r = JSON.parse(await call("publish_app", { appId: copyId, streamName: "Everyone" }));
    if (!r.published) throw new Error("not published");
    return `stream=${r.stream}`;
  });
  await step("delete_app copy (cleanup)", async () => {
    await call("delete_app", { appId: copyId });
    const gone = JSON.parse(await call("list_apps", { filter: `id eq ${copyId}` }));
    if (gone.total !== 0) throw new Error("copy still present after delete");
    return "deleted + verified gone";
  });
}

// ---- start_task: needs the persistent fixture task (bound to the demo app).
await step("start_task (fixture 'MCP Smoke Task')", async () => {
  const tasks = envelope(await call("list_tasks", { filter: `name eq 'MCP Smoke Task'` }));
  if (tasks.total === 0) throw new Error("fixture task missing — create 'MCP Smoke Task' bound to the demo app");
  const taskId = tasks.items[0].id;
  await call("start_task", { taskId });
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const t = envelope(await call("list_tasks", { filter: `name eq 'MCP Smoke Task'` })).items[0];
    if (t.lastStatus === "FinishedSuccess") return `FinishedSuccess after ~${(i + 1) * 5}s`;
    if (["FinishedFail", "Error", "Aborted"].includes(t.lastStatus)) throw new Error(`task ended ${t.lastStatus}`);
  }
  throw new Error("task did not finish within 120s");
});

await client.close();
console.log(failures === 0 ? "SMOKE: ALL PASS" : `SMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
