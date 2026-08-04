import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QrsClient } from "../qrs.js";
import type { Config } from "../config.js";

const TASK_STATUS: Record<number, string> = {
  0: "NeverStarted", 1: "Triggered", 2: "Started", 3: "Queued", 4: "AbortInitiated",
  5: "Aborting", 6: "Aborted", 7: "FinishedSuccess", 8: "FinishedFail", 9: "Skipped",
  10: "Retry", 11: "Error", 12: "Reset",
};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

function gate(cfg: Config) {
  if (!cfg.allowMutations) throw new Error("Mutations are disabled. Start the server with QSEOW_ALLOW_MUTATIONS=true to enable this tool.");
}

export function registerAdminTools(server: McpServer, qrs: QrsClient, cfg: Config): void {
  server.tool(
    "qrs_about",
    "Qlik Sense server version and build info from the Repository Service. Cheap health check.",
    {},
    async () => text(await qrs.get("/qrs/about")),
  );

  server.tool(
    "service_status",
    "Health of all Qlik services on every node (repository, proxy, engine, scheduler, printing).",
    {},
    async () => {
      const rows = await qrs.get<any[]>("/qrs/servicestatus/full");
      const TYPE: Record<number, string> = { 0: "Repository", 1: "Proxy", 2: "Scheduler", 3: "Engine", 4: "Printing" };
      const STATE: Record<number, string> = { 0: "NoCommunication", 1: "Running", 2: "Disabled" };
      return text(rows.map((r) => ({
        node: r.serverNodeConfiguration?.hostName ?? r.serverNodeConfiguration?.name,
        service: TYPE[r.serviceType] ?? r.serviceType,
        state: STATE[r.serviceState] ?? r.serviceState,
      })));
    },
  );

  server.tool(
    "license_summary",
    "License overview: serial, edition, expiry, and professional/analyzer access allocations.",
    {},
    async () => {
      const lic = await qrs.get<any>("/qrs/license");
      const pro = await qrs.get<any[]>("/qrs/license/professionalaccesstype/full");
      const ana = await qrs.get<any[]>("/qrs/license/analyzeraccesstype/full");
      return text({
        serial: lic.serial, name: lic.name, organization: lic.organization,
        isExpired: lic.isExpired, isSubscription: lic.isSubscription,
        keyDetails: lic.keyDetails,
        professionalAllocated: pro.map((p) => `${p.user?.userDirectory}\\${p.user?.userId}`),
        analyzerAllocated: ana.map((a) => `${a.user?.userDirectory}\\${a.user?.userId}`),
      });
    },
  );

  server.tool(
    "list_apps",
    "List apps in the repository with owner, stream, size, and reload time. Optional QRS filter, e.g. \"name sw 'Sales'\" or \"stream.name eq 'Everyone'\".",
    { filter: z.string().optional().describe("QRS filter expression") },
    async ({ filter }) => {
      const path = `/qrs/app/full${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;
      const apps = await qrs.get<any[]>(path);
      return text(apps.map((a) => ({
        id: a.id, name: a.name, owner: `${a.owner?.userDirectory}\\${a.owner?.userId}`,
        stream: a.stream?.name ?? null, published: a.published,
        lastReloadTime: a.lastReloadTime, fileSizeBytes: a.fileSize,
      })));
    },
  );

  server.tool(
    "list_streams",
    "List streams (publish targets) with owner.",
    {},
    async () => {
      const s = await qrs.get<any[]>("/qrs/stream/full");
      return text(s.map((x) => ({ id: x.id, name: x.name, owner: `${x.owner?.userDirectory}\\${x.owner?.userId}` })));
    },
  );

  server.tool(
    "list_tasks",
    "List reload tasks with enabled state and last execution result.",
    { filter: z.string().optional().describe("QRS filter expression") },
    async ({ filter }) => {
      const path = `/qrs/reloadtask/full${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;
      const tasks = await qrs.get<any[]>(path);
      return text(tasks.map((t) => ({
        id: t.id, name: t.name, app: t.app?.name, enabled: t.enabled,
        lastStatus: TASK_STATUS[t.operational?.lastExecutionResult?.status] ?? "Unknown",
        lastStart: t.operational?.lastExecutionResult?.startTime,
        lastStop: t.operational?.lastExecutionResult?.stopTime,
      })));
    },
  );

  server.tool(
    "start_task",
    "Start a reload task by id (fire-and-forget; poll list_tasks for status). MUTATION.",
    { taskId: z.string().describe("Reload task id") },
    async ({ taskId }) => {
      gate(cfg);
      await qrs.post(`/qrs/task/${taskId}/start`);
      return text(`Task ${taskId} start requested. Poll list_tasks for status.`);
    },
  );

  server.tool(
    "list_users",
    "List users known to the repository. Optional QRS filter, e.g. \"userId eq 'qservice'\".",
    { filter: z.string().optional().describe("QRS filter expression") },
    async ({ filter }) => {
      const path = `/qrs/user/full${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;
      const users = await qrs.get<any[]>(path);
      return text(users.map((u) => ({
        id: u.id, user: `${u.userDirectory}\\${u.userId}`, name: u.name,
        roles: u.roles, inactive: u.inactive, removedExternally: u.removedExternally,
      })));
    },
  );

  server.tool(
    "list_extensions",
    "List installed visualization extensions.",
    {},
    async () => {
      const ext = await qrs.get<any[]>("/qrs/extension/full");
      return text(ext.map((e) => ({ id: e.id, name: e.name, owner: `${e.owner?.userDirectory}\\${e.owner?.userId}` })));
    },
  );

  server.tool(
    "list_data_connections",
    "List data connections (credentials redacted).",
    {},
    async () => {
      const dc = await qrs.get<any[]>("/qrs/dataconnection/full");
      return text(dc.map((d) => ({
        id: d.id, name: d.name, type: d.type, connectionstring: d.connectionstring,
        owner: `${d.owner?.userDirectory}\\${d.owner?.userId}`,
      })));
    },
  );

  server.tool(
    "qrs_search",
    "Generic QRS entity search: any entity type (app, user, stream, reloadtask, dataconnection, extension, tag, customproperty, systemrule, ...) with an optional QRS filter expression. The governance power tool.",
    {
      entity: z.string().describe("QRS entity type, e.g. 'app', 'systemrule', 'tag'"),
      filter: z.string().optional().describe("QRS filter, e.g. \"name sw 'Finance'\""),
      full: z.boolean().optional().describe("Return full entities instead of condensed (default false)"),
    },
    async ({ entity, filter, full }) => {
      const suffix = full ? "/full" : "";
      const path = `/qrs/${entity}${suffix}${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;
      return text(await qrs.get(path));
    },
  );
}
