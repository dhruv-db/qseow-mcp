import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QrsClient } from "../qrs.js";
import type { Config } from "../config.js";
import { text, guid, qrsQuote } from "./shared.js";
import { TASK_STATUS } from "./admin.js";

// Reload-task lifecycle: execution history (Qlik Cloud qlik_get_reload_status),
// stop (qlik_cancel_app_reload), task + schedule CRUD. QRS encodings below are
// ported from bintocher/qlik-sense-mcp (MIT, (c) Stanislav Chernov), where each
// was measured against a live site.

const READ = { readOnlyHint: true, openWorldHint: false };

/** QRS SchemaEvent.incrementOption. No "minutely"; daily is 2, not 3. */
export const REPEAT_OPTIONS = { once: 0, hourly: 1, daily: 2, weekly: 3, monthly: 4 } as const;
export type Repeat = keyof typeof REPEAT_OPTIONS;

/** "every N minutes" -> QRS incrementDescription "minutes hours days weeks".
 *  Writing the raw minutes into the days slot asks for every 1440 DAYS. */
export function incrementDescription(minutes: number): string {
  let m = Math.max(Math.trunc(minutes || 0), 0);
  const weeks = Math.floor(m / 10080); m %= 10080;
  const days = Math.floor(m / 1440); m %= 1440;
  const hours = Math.floor(m / 60);
  return `${m % 60} ${hours} ${days} ${weeks}`;
}

/** No time-window restriction. "-" in slot 3 is a value (no week prefix). */
export const OPEN_SCHEMA_FILTER = "* * - * * * * *";

export function buildScheduleBody(a: {
  taskId: string; name: string; repeat: Repeat; intervalMinutes: number;
  startDate: string; timeZone: string; enabled: boolean; timeWindow?: string;
}) {
  if (a.timeWindow !== undefined && a.timeWindow.split(" ").length !== 8) {
    throw new Error('timeWindow needs 8 space-separated positions, e.g. "45 3-21 - * * * * *"');
  }
  if (a.repeat !== "once" && a.intervalMinutes < 1) throw new Error("intervalMinutes must be >= 1");
  return {
    name: a.name,
    enabled: a.enabled,
    eventType: 0,
    reloadTask: { id: a.taskId },
    timeZone: a.timeZone,
    // 0 = follow the zone's DST rules, so 03:00 stays 03:00 wall-clock.
    daylightSavingTime: 0,
    startDate: a.startDate,
    expirationDate: "9999-12-30T23:59:59.000Z",
    schemaFilterDescription: [a.timeWindow ?? OPEN_SCHEMA_FILTER],
    incrementDescription: incrementDescription(a.intervalMinutes),
    incrementOption: REPEAT_OPTIONS[a.repeat],
    // No "operational" key: QRS rejects an empty one with 400.
  };
}

const statusName = (s: unknown) => TASK_STATUS[s as number] ?? "Unknown";

export function registerTaskTools(server: McpServer, qrs: QrsClient, cfg: Config): void {
  server.registerTool(
    "get_task_executions",
    {
      description:
        "Execution history of a reload task, newest first: status, start/stop, duration, node, whether a script log " +
        "exists. Use after start_task to poll a reload's status (the Qlik Cloud get_reload_status equivalent).",
      inputSchema: {
        taskId: guid.describe("Reload task id"),
        top: z.number().int().positive().max(100).optional().describe("Most recent N (default 10)"),
      },
      annotations: READ,
    },
    async ({ taskId, top }) => {
      const task = await qrs.get<any>(`/qrs/reloadtask/${taskId}`);
      // ponytail: full list + local sort; fine for per-task history, switch to
      // /executionresult/table with server-side sort if MaxRecordLimit bites.
      const results = await qrs.get<any[]>(`/qrs/executionresult/full?filter=${encodeURIComponent(`taskID eq ${taskId}`)}`);
      const rows = results
        .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
        .slice(0, top ?? 10)
        .map((r) => ({
          status: statusName(r.status),
          startTime: r.startTime,
          stopTime: r.stopTime,
          durationSeconds: typeof r.duration === "number" ? Math.round(r.duration / 1000) : undefined,
          node: r.executingNodeName,
          scriptLogAvailable: r.scriptLogAvailable,
          details: (r.details ?? []).map((d: any) => d.message).filter(Boolean).slice(-5),
        }));
      const op = task.operational?.lastExecutionResult;
      return text({
        taskId, name: task.name, app: task.app?.name, enabled: task.enabled,
        current: { status: statusName(op?.status), startTime: op?.startTime, stopTime: op?.stopTime },
        executions: rows,
      });
    },
  );

  server.registerTool(
    "list_task_schedules",
    {
      description: "Schedule triggers attached to a reload task: id, name, enabled, repeat, interval, start, time zone, next run.",
      inputSchema: { taskId: guid.describe("Reload task id") },
      annotations: READ,
    },
    async ({ taskId }) => {
      const events = await qrs.get<any[]>(`/qrs/schemaevent/full?filter=${encodeURIComponent(`reloadTask.id eq ${taskId}`)}`);
      const repeatName = Object.fromEntries(Object.entries(REPEAT_OPTIONS).map(([k, v]) => [v, k]));
      return text(events.map((e) => ({
        scheduleId: e.id, name: e.name, enabled: e.enabled,
        repeat: repeatName[e.incrementOption] ?? e.incrementOption,
        increment: e.incrementDescription, timeWindow: e.schemaFilterDescription?.[0],
        startDate: e.startDate, timeZone: e.timeZone, nextExecution: e.operational?.nextExecution,
      })));
    },
  );

  if (!cfg.allowMutations) return;

  server.registerTool(
    "stop_task",
    {
      description: "Stop one or more running reload tasks (the Qlik Cloud cancel_app_reload equivalent). Poll get_task_executions for the Aborted status. MUTATION.",
      inputSchema: { taskIds: z.array(guid).min(1).describe("Reload task ids") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskIds }) => {
      await qrs.post(`/qrs/task/stop/many`, taskIds);
      return text({ stopRequested: taskIds, next: "poll get_task_executions" });
    },
  );

  server.registerTool(
    "create_reload_task",
    {
      description: "Create a reload task for an app (no schedule; add one with create_task_schedule). Task names must be unique. MUTATION (additive).",
      inputSchema: {
        appId: guid.describe("App id"),
        name: z.string().min(1),
        enabled: z.boolean().optional().describe("Default true"),
        maxRetries: z.number().int().min(0).max(10).optional().describe("Default 0"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, name, enabled, maxRetries }) => {
      const clash = await qrs.get<any[]>(`/qrs/reloadtask?filter=${encodeURIComponent(`name eq '${qrsQuote(name)}'`)}`);
      if (clash.length) throw new Error(`a reload task named "${name}" already exists (${clash[0].id})`);
      const t = await qrs.post<any>(`/qrs/reloadtask/create`, {
        task: {
          app: { id: appId }, name, taskType: 0, enabled: enabled ?? true,
          taskSessionTimeout: 1440, maxRetries: maxRetries ?? 0, isManuallyTriggered: false,
        },
      });
      return text({ taskId: t.id, name: t.name, enabled: t.enabled, app: appId });
    },
  );

  server.registerTool(
    "update_reload_task",
    {
      description: "Rename, enable/disable, or change retries/timeout of a reload task (omitted = unchanged). MUTATION.",
      inputSchema: {
        taskId: guid,
        name: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        maxRetries: z.number().int().min(0).max(10).optional(),
        taskSessionTimeout: z.number().int().positive().optional().describe("Minutes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId, ...changes }) => {
      // QRS PUT takes the whole object; stale modifiedDate -> 409 conflict.
      const current = await qrs.get<any>(`/qrs/reloadtask/${taskId}`);
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) current[k] = v;
      const t = await qrs.put<any>(`/qrs/reloadtask/${taskId}`, current);
      return text({ taskId, name: t.name, enabled: t.enabled, maxRetries: t.maxRetries, taskSessionTimeout: t.taskSessionTimeout });
    },
  );

  server.registerTool(
    "delete_reload_task",
    {
      description: "Permanently delete a reload task and its triggers. No undo. MUTATION (destructive).",
      inputSchema: { taskId: guid },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      await qrs.delete(`/qrs/reloadtask/${taskId}`);
      return text({ taskId, deleted: true });
    },
  );

  server.registerTool(
    "create_task_schedule",
    {
      description:
        "Attach a schedule to a reload task. startDate is WALL-CLOCK time in timeZone ('YYYY-MM-DDThh:mm:ss.000'); a 'once' " +
        "schedule in the past never fires. timeWindow (optional) restricts WHEN it may fire: 8 positions " +
        "'Minute Hour WeekDayPrefix WeekDay WeeklyInterval DayOfMonth Month MonthlyInterval'. MUTATION (additive).",
      inputSchema: {
        taskId: guid,
        name: z.string().min(1),
        repeat: z.enum(["once", "hourly", "daily", "weekly", "monthly"]).optional().describe("Default daily"),
        intervalMinutes: z.number().int().positive().optional().describe("Default 1440"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/).describe("First run, wall-clock in timeZone"),
        timeZone: z.string().optional().describe("IANA zone, default Europe/Zurich"),
        enabled: z.boolean().optional(),
        timeWindow: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, name, repeat, intervalMinutes, startDate, timeZone, enabled, timeWindow }) => {
      const body = buildScheduleBody({
        taskId, name, repeat: repeat ?? "daily", intervalMinutes: intervalMinutes ?? 1440,
        startDate, timeZone: timeZone ?? "Europe/Zurich", enabled: enabled ?? true, timeWindow,
      });
      const e = await qrs.post<any>(`/qrs/schemaevent`, body);
      return text({ scheduleId: e.id, name: e.name, enabled: e.enabled, startDate: e.startDate, timeZone: e.timeZone });
    },
  );

  server.registerTool(
    "delete_task_schedule",
    {
      description: "Remove one schedule trigger, leaving the task and its other triggers intact. MUTATION.",
      inputSchema: { scheduleId: guid.describe("From list_task_schedules") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ scheduleId }) => {
      await qrs.delete(`/qrs/schemaevent/${scheduleId}`);
      return text({ scheduleId, deleted: true });
    },
  );
}
