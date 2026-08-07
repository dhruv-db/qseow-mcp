import https from "node:https";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QrsClient } from "../qrs.js";
import type { Config } from "../config.js";
import type { ProxySession } from "../session.js";
import {
  text, tailText, decodeRuleActions, lintSecurityRules, isShippedRule,
  summarizeHealthcheck, pageParams, paginate, scrubString, guid,
} from "./shared.js";

const READ = { readOnlyHint: true, openWorldHint: false };

const EXECUTION_STATUS: Record<number, string> = {
  0: "NeverStarted", 1: "Triggered", 2: "Started", 3: "Queued", 4: "AbortInitiated",
  5: "Aborting", 6: "Aborted", 7: "FinishedSuccess", 8: "FinishedFail", 9: "Skipped",
  10: "Retry", 11: "Error", 12: "Reset",
};

const NIL_GUID = "00000000-0000-0000-0000-000000000000";

/** Raw HTTPS request outside the QRS client's routing: the engine healthcheck
 *  and the Proxy Service (QPS) REST API live on their own ports. QPS is
 *  certificate-only; the healthcheck follows the configured auth mode.
 *  Socket-level failures retry once on a fresh connection (same rationale as
 *  QrsClient). */
async function rawRequest(
  cfg: Config,
  opts: { port: number; path: string; method?: string; useCert?: boolean; cookie?: string },
): Promise<{ status: number; body: string }> {
  try {
    return await rawAttempt(cfg, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/socket hang up|ECONNRESET|EPIPE|socket closed/i.test(msg)) {
      return await rawAttempt(cfg, opts);
    }
    throw e;
  }
}

function rawAttempt(
  cfg: Config,
  opts: {
    port: number;
    path: string;
    method?: string;
    useCert?: boolean;
    cookie?: string;
  },
): Promise<{ status: number; body: string }> {
  const xrf = randomBytes(8).toString("hex");
  const sep = opts.path.includes("?") ? "&" : "?";
  const headers: Record<string, string> = {
    "x-qlik-xrfkey": xrf,
    Accept: "application/json",
  };
  if (opts.useCert) {
    headers["X-Qlik-User"] = `UserDirectory=${cfg.certUser.directory}; UserId=${cfg.certUser.id}`;
  } else if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: cfg.host,
      port: opts.port,
      method: opts.method ?? "GET",
      path: `${opts.path}${sep}xrfkey=${xrf}`,
      headers,
      rejectUnauthorized: cfg.tlsVerify,
      ...(opts.useCert && cfg.cert
        ? { cert: cfg.cert.cert, key: cfg.cert.key, passphrase: cfg.cert.passphrase, ca: cfg.cert.ca }
        : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

export function registerOpsTools(
  server: McpServer,
  qrs: QrsClient,
  cfg: Config,
  session?: ProxySession,
): void {
  server.registerTool(
    "get_reload_log",
    {
      description:
        "Why did a reload fail? Last execution result of a reload task (status, timing, execution detail timeline) " +
        "plus the tail of the reload script log. The first tool to reach for on FinishedFail.",
      inputSchema: {
        taskId: guid.describe("Reload task id (see list_tasks)"),
        tailLines: z.number().int().positive().max(2000).optional()
          .describe("Script-log lines to return from the end (default 200)"),
      },
      annotations: { ...READ, idempotentHint: true },
    },
    async ({ taskId, tailLines }) => {
      const task = await qrs.get<any>(`/qrs/reloadtask/${taskId}`);
      const er = task?.operational?.lastExecutionResult;
      if (!er) return text({ taskId, taskName: task?.name, log: null, note: "Task has no execution result yet." });
      const summary = {
        taskId,
        taskName: task.name,
        appId: task.app?.id,
        appName: task.app?.name,
        status: EXECUTION_STATUS[er.status] ?? `status-${er.status}`,
        startTime: er.startTime,
        stopTime: er.stopTime,
        durationMs: er.duration,
        executingNode: er.executingNodeName,
        // The detail timeline (queued -> started -> finished/error messages)
        // often names the failure even when the script log is unavailable.
        details: (er.details ?? []).map((d: any) => ({ at: d.detailCreatedDate, type: d.detailsType, message: scrubString(String(d.message ?? "")) })),
      };
      const fileRef: string | undefined = er.fileReferenceID;
      if (!fileRef || fileRef === NIL_GUID) {
        return text({ ...summary, log: null, note: "No script log stored for this execution." });
      }
      // Two-step QRS download: stage the log behind a temp GUID, then fetch it.
      const staged = await qrs.get<any>(`/qrs/reloadtask/${taskId}/scriptlog?fileReferenceId=${fileRef}`);
      const tempGuid = typeof staged === "string" ? staged : staged?.value;
      if (!tempGuid) return text({ ...summary, log: null, note: `scriptlog staging returned no GUID: ${JSON.stringify(staged).slice(0, 200)}` });
      const logText = await qrs.get<string>(`/qrs/download/reloadtask/${tempGuid}/scriptlog.txt`);
      const tail = tailText(typeof logText === "string" ? logText : JSON.stringify(logText), tailLines ?? 200);
      // Reload logs echo script statements — a credential egress path.
      return text({ ...summary, log: { totalLines: tail.totalLines, droppedLeadingLines: tail.dropped, lines: tail.lines.map(scrubString) } });
    },
  );

  server.registerTool(
    "engine_healthcheck",
    {
      description:
        "Engine health: version, saturated flag, memory, CPU, active/loaded app counts, session and user counts. " +
        "The 'is the engine the problem?' tool.",
      annotations: { ...READ, idempotentHint: true },
    },
    async () => {
      // Trailing slash matters: the proxy 301s `/engine/healthcheck` to the
      // slash-terminated form (verified live), and redirects drop the auth.
      const viaProxy = cfg.authMode === "jwt";
      const res = await rawRequest(cfg, viaProxy
        ? { port: cfg.proxyPort, path: `/${cfg.vpPrefix}/engine/healthcheck/`, cookie: (await session!.ensure()).cookie }
        : { port: cfg.enginePort, path: "/engine/healthcheck/", useCert: true });
      if (res.status >= 400 || !res.body) {
        throw new Error(`engine healthcheck -> ${res.status}: ${res.body.slice(0, 300)}`);
      }
      return text(summarizeHealthcheck(JSON.parse(res.body)));
    },
  );

  server.registerTool(
    "security_rule_audit",
    {
      description:
        "Audit the site's security rules: every Security-category system rule with decoded actions, plus lint " +
        "findings (disabled default rules, wildcard resource filters, unconditional write grants). Findings are " +
        "review prompts, not verdicts. Paged.",
      inputSchema: {
        includeRules: z.boolean().optional().describe("Include the full rule list, not just counts + findings (default true)"),
        ...pageParams,
      },
      annotations: { ...READ, idempotentHint: true },
    },
    async ({ includeRules, offset, limit }) => {
      const rules = await qrs.get<any[]>(
        `/qrs/systemrule/full?filter=${encodeURIComponent("category eq 'Security'")}`,
      );
      const findings = lintSecurityRules(rules);
      const mapped = rules.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        disabled: r.disabled,
        resourceFilter: r.resourceFilter,
        actions: decodeRuleActions(Number(r.actions)),
        condition: r.rule,
        comment: r.comment || undefined,
      }));
      const counts = {
        totalRules: rules.length,
        shippedRules: rules.filter((r) => isShippedRule(r.type)).length,
        customRules: rules.filter((r) => !isShippedRule(r.type)).length,
        disabledRules: rules.filter((r) => r.disabled).length,
      };
      return text({
        ...counts,
        findings,
        rules: includeRules === false ? undefined : paginate(mapped, offset, limit),
      });
    },
  );

  // ── QPS session tools ──────────────────────────────────────────────────────
  // The Proxy Service REST API (:4243) authenticates with the client
  // certificate ONLY — there is no JWT/virtual-proxy route to it. These tools
  // register whenever certificate material is configured, in either auth mode,
  // and are absent otherwise so tools/list stays honest.
  if (cfg.cert) {
    server.registerTool(
      "list_user_sessions",
      {
        description:
          "Active proxy sessions for a user on a virtual proxy (default: the default proxy). Certificate-backed " +
          "(QPS REST is certificate-only). Answers 'is this user logged in, and how many times?'",
        inputSchema: {
          directory: z.string().describe("User directory, e.g. 'LAB'"),
          userId: z.string().describe("User id, e.g. 'qservice'"),
          virtualProxy: z.string().optional().describe("Virtual proxy prefix to query (omit for the default proxy)"),
        },
        annotations: { ...READ, idempotentHint: true },
      },
      async ({ directory, userId, virtualProxy }) => {
        const vp = virtualProxy ? `/${virtualProxy}` : "";
        const res = await rawRequest(cfg, {
          port: cfg.qpsPort,
          path: `/qps${vp}/user/${encodeURIComponent(directory)}/${encodeURIComponent(userId)}`,
          useCert: true,
        });
        if (res.status >= 400) throw new Error(`QPS user sessions -> ${res.status}: ${res.body.slice(0, 300)}`);
        const sessions = res.body ? JSON.parse(res.body) : [];
        return text({
          user: `${directory}\\${userId}`,
          virtualProxy: virtualProxy ?? "(default)",
          sessionCount: sessions.length,
          sessions: sessions.map((s: any) => ({ sessionId: s.SessionId, attributes: s.Attributes })),
        });
      },
    );

    if (cfg.allowMutations) {
      server.registerTool(
        "end_user_sessions",
        {
          description:
            "Log a user out of a virtual proxy by deleting ALL their proxy sessions there. MUTATION: the user's " +
            "open hub/QMC tabs die immediately. Certificate-backed (QPS REST is certificate-only).",
          inputSchema: {
            directory: z.string().describe("User directory"),
            userId: z.string().describe("User id"),
            virtualProxy: z.string().optional().describe("Virtual proxy prefix (omit for the default proxy)"),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async ({ directory, userId, virtualProxy }) => {
          const vp = virtualProxy ? `/${virtualProxy}` : "";
          const res = await rawRequest(cfg, {
            port: cfg.qpsPort,
            path: `/qps${vp}/user/${encodeURIComponent(directory)}/${encodeURIComponent(userId)}`,
            method: "DELETE",
            useCert: true,
          });
          if (res.status >= 400) throw new Error(`QPS delete sessions -> ${res.status}: ${res.body.slice(0, 300)}`);
          // Observed live: no-session users yield a literal `null` body.
          const removed = res.body ? JSON.parse(res.body) : null;
          return text({
            user: `${directory}\\${userId}`,
            virtualProxy: virtualProxy ?? "(default)",
            endedSessions: Array.isArray(removed) ? removed.length : removed == null ? 0 : removed,
          });
        },
      );
    }
  }
}
