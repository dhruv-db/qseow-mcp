import { z } from "zod";

/** Wrap any value as MCP text content. */
export const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

// ── Credential redaction ─────────────────────────────────────────────────────
// QRS entities can carry secrets two ways: dedicated fields (password,
// passphrase, ...) and key=value pairs embedded in connection strings
// (PWD=...;). Generic endpoints like qrs_search must never egress either —
// an MCP client transcript is not a secret store.

const SECRET_KEY = /^(password|passphrase|secret|privatekey|apikey|api_key|clientsecret|client_secret)$/i;
// Key names may be prefixed/suffixed (vPassword, DB_PASSWORD, apiKey2) and
// values may be bare, single- or double-quoted — load scripts quote them,
// connection strings usually don't. All three value forms must be masked.
const SECRET_KV =
  /\b([\w.]*(?:pwd|password|passwd|passphrase|secret|api_?key|access_token|refresh_token|client_secret)[\w.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^;\s"']+)/gi;

export const REDACTED = "***REDACTED***";

/** Mask key=value secrets in free text: connection strings, load scripts,
 *  reload logs. Over-redaction of a look-alike (vPasswordPolicy=strict) is
 *  acceptable in an egress path; under-redaction is not. */
export function scrubString(s: string): string {
  return s.replace(SECRET_KV, (_m, key: string, eq: string) => `${key}${eq}${REDACTED}`);
}

/** Recursively redact credential-bearing fields and embedded key=value
 *  secrets from an arbitrary QRS response. */
export function redactSecrets<T>(v: T): T {
  if (typeof v === "string") return scrubString(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x)) as unknown as T;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) {
        // Keep null/empty as-is — "no credential present" is a legitimate,
        // non-sensitive signal. Everything else is masked.
        out[k] = val === null || val === undefined || val === "" ? val : "***REDACTED***";
      } else {
        out[k] = redactSecrets(val);
      }
    }
    return out as unknown as T;
  }
  return v;
}

// ── Input validation ─────────────────────────────────────────────────────────
// Repository/engine ids are GUIDs. Tool args are supplied by an LLM that may
// hold untrusted content in context, and ids are interpolated into QRS URL
// paths and WebSocket URLs — a GUID gate closes that path-injection surface.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const guid = z.string().regex(GUID_RE, "must be a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)");

/** Escape a literal value for use inside a QRS filter string ('...'). */
export function qrsQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ── Pagination ───────────────────────────────────────────────────────────────
// QRS "full" endpoints return every entity on the site (thousands on a real
// enterprise deployment) and the engine doc list can be similarly large.
// Every list tool takes offset/limit and returns a stable envelope so an MCP
// client can page instead of blowing its context window.

export const pageParams = {
  offset: z.number().int().min(0).optional().describe("Skip this many items (default 0)"),
  limit: z.number().int().positive().max(1000).optional().describe("Max items to return (default 100, max 1000)"),
};

export function paginate<T>(items: T[], offset?: number, limit?: number, defaultLimit = 100) {
  const off = offset ?? 0;
  const lim = limit ?? defaultLimit;
  const page = items.slice(off, off + lim);
  return {
    total: items.length,
    offset: off,
    returned: page.length,
    truncated: off + page.length < items.length,
    items: page,
  };
}

// ── Visualization shape specs (builder + validation gate) ────────────────────
// What each built-in visualization needs to actually render. Derived from the
// object model and verified against a live engine by scripts/viz_matrix.mjs —
// a shape the engine accepts but the client renders blank is exactly the bug
// class the validation gate exists to catch.

export interface VizSpec {
  minDims: number; maxDims: number;
  minMeasures: number; maxMeasures: number;
  cube: "hypercube" | "listobject" | "none";
  pivot?: boolean; // qMode 'P' required — a straight cube renders empty
  /** false = the built object has NOT been proven to paint pixels in a real
   *  browser client (see scripts/viz_matrix.mjs + the headless render proof).
   *  Absent means verified. */
  renderVerified?: boolean;
}

export const VIZ_SPECS: Record<string, VizSpec> = {
  kpi:          { minDims: 0, maxDims: 0, minMeasures: 1, maxMeasures: 2, cube: "hypercube" },
  // gauge: the engine accepts it and the object loads, but sn-gauge paints
  // nothing with generically-built properties on May 2026 — kept available,
  // flagged unverified rather than silently shipping a blank tile.
  gauge:        { minDims: 0, maxDims: 0, minMeasures: 1, maxMeasures: 1, cube: "hypercube", renderVerified: false },
  barchart:     { minDims: 1, maxDims: 2, minMeasures: 1, maxMeasures: 9, cube: "hypercube" },
  linechart:    { minDims: 1, maxDims: 2, minMeasures: 1, maxMeasures: 9, cube: "hypercube" },
  combochart:   { minDims: 1, maxDims: 1, minMeasures: 1, maxMeasures: 9, cube: "hypercube" },
  piechart:     { minDims: 1, maxDims: 1, minMeasures: 1, maxMeasures: 1, cube: "hypercube" },
  scatterplot:  { minDims: 1, maxDims: 1, minMeasures: 2, maxMeasures: 3, cube: "hypercube" },
  treemap:      { minDims: 1, maxDims: 9, minMeasures: 1, maxMeasures: 1, cube: "hypercube" },
  table:        { minDims: 0, maxDims: 99, minMeasures: 0, maxMeasures: 99, cube: "hypercube" },
  "pivot-table": { minDims: 1, maxDims: 99, minMeasures: 1, maxMeasures: 99, cube: "hypercube", pivot: true },
  listbox:      { minDims: 1, maxDims: 1, minMeasures: 0, maxMeasures: 0, cube: "listobject" },
  "text-image": { minDims: 0, maxDims: 0, minMeasures: 0, maxMeasures: 9, cube: "none" },
};

export interface VizFinding { severity: "fail" | "warn"; message: string }

/** Shape check for a visualization request; empty result = shape is fine. */
export function checkVizShape(viz: string, nDims: number, nMeasures: number): VizFinding[] {
  const spec = VIZ_SPECS[viz];
  if (!spec) {
    return [{ severity: "warn", message: `unknown visualization type "${viz}" — not a known built-in; will render only if a matching extension is installed` }];
  }
  const out: VizFinding[] = [];
  if (nDims < spec.minDims || nDims > spec.maxDims) {
    out.push({ severity: "fail", message: `${viz} needs ${spec.minDims}-${spec.maxDims} dimensions, got ${nDims}` });
  }
  if (nMeasures < spec.minMeasures || nMeasures > spec.maxMeasures) {
    out.push({ severity: "fail", message: `${viz} needs ${spec.minMeasures}-${spec.maxMeasures} measures, got ${nMeasures}` });
  }
  return out;
}

/** Sheet-cell placement lint: every child placed, every cell backed by a
 *  child, everything inside the grid, no overlaps. These are the "object
 *  exists but the sheet shows nothing / garbage" failure modes. */
export function checkCellPlacement(
  cells: Array<{ name: string; col: number; row: number; colspan: number; rowspan: number }>,
  childIds: string[],
  columns: number,
  rows: number,
): VizFinding[] {
  const out: VizFinding[] = [];
  const placed = new Set(cells.map((c) => c.name));
  for (const id of childIds) {
    if (!placed.has(id)) out.push({ severity: "fail", message: `object ${id} has no cell on the sheet — it will not appear` });
  }
  for (const c of cells) {
    if (!childIds.includes(c.name)) {
      out.push({ severity: "warn", message: `cell references ${c.name} which is not a child of the sheet (orphan cell)` });
    }
    if (c.col < 0 || c.row < 0 || c.col + c.colspan > columns || c.row + c.rowspan > rows) {
      out.push({ severity: "fail", message: `cell ${c.name} (${c.col},${c.row} span ${c.colspan}x${c.rowspan}) exceeds the ${columns}x${rows} grid` });
    }
    if (c.colspan <= 0 || c.rowspan <= 0) {
      out.push({ severity: "fail", message: `cell ${c.name} has non-positive span` });
    }
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const overlap = a.col < b.col + b.colspan && b.col < a.col + a.colspan &&
                      a.row < b.row + b.rowspan && b.row < a.row + a.rowspan;
      if (overlap) out.push({ severity: "warn", message: `cells ${a.name} and ${b.name} overlap` });
    }
  }
  return out;
}

/** Map engine CheckExpression qBadFieldNames ranges ({qFrom,qCount} into the
 *  expression string) to the offending substrings. */
export function badFieldSubstrings(expression: string, ranges: Array<{ qFrom: number; qCount: number }>): string[] {
  return (ranges ?? []).map((r) => expression.slice(r.qFrom, r.qFrom + r.qCount));
}

// ── Pure helpers shared by tools and unit tests ──────────────────────────────

/** Walk any JSON value; call visit(path, string) on every string leaf. */
export function walkStrings(v: unknown, path: string, visit: (path: string, s: string) => void): void {
  if (typeof v === "string") {
    visit(path, v);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, visit));
  } else if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      walkStrings(val, path ? `${path}.${k}` : k, visit);
    }
  }
}

/** Classify a lineage entry by its discriminator/statement. */
export function classifyLineage(discriminator: string | undefined, statement: string | undefined): string {
  const s = (discriminator ?? "").toUpperCase();
  const st = (statement ?? "").toUpperCase();
  if (st.startsWith("STORE")) return "store";
  if (s.startsWith("INLINE")) return "inline";
  if (s.startsWith("RESIDENT")) return "resident";
  if (s.includes(".QVD")) return "qvd";
  if (s.startsWith("BINARY")) return "binary";
  if (s.includes("PROVIDER=") || s.includes("ODBC") || s.includes("OLEDB") || s.includes("CUSTOM CONNECT")) return "database";
  return "other";
}

/** Last n lines of a (possibly huge) log. Returns the tail plus how many
 *  lines were dropped, so a truncated log can't masquerade as complete. */
export function tailText(text: string, n: number): { lines: string[]; dropped: number; totalLines: number } {
  const all = text.split(/\r?\n/);
  // A trailing newline yields one empty final element — not a log line.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const lines = all.slice(Math.max(0, all.length - n));
  return { lines, dropped: all.length - lines.length, totalLines: all.length };
}

// QRS systemrule `actions` bitmask, per the QMC security-rule editor.
const RULE_ACTIONS: Array<[number, string]> = [
  [1, "Create"], [2, "Read"], [4, "Update"], [8, "Delete"], [16, "Export"],
  [32, "Publish"], [64, "Change owner"], [128, "Change role"], [256, "Export data"],
  [512, "Offline access"], [1024, "Distribute"], [2048, "Duplicate"], [4096, "Approve"],
];

export function decodeRuleActions(mask: number): string[] {
  const out = RULE_ACTIONS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return out.length ? out : [`unknown(${mask})`];
}

export interface SecurityRuleFinding {
  severity: "high" | "warn" | "info";
  ruleId: string;
  ruleName: string;
  reason: string;
}

/** Shipped rules carry type "Default" (editable) or "ReadOnly" (immutable,
 *  e.g. RootAdmin) — verified live; only "Custom" is user-authored. */
export function isShippedRule(type: unknown): boolean {
  return type === "Default" || type === "ReadOnly";
}

/** Heuristic lint over QRS security rules. Findings are prompts for a human
 *  review, not verdicts — a disabled default rule can be a deliberate
 *  hardening choice. */
export function lintSecurityRules(rules: Array<Record<string, any>>): SecurityRuleFinding[] {
  const findings: SecurityRuleFinding[] = [];
  const WRITE_MASK = 4 | 8 | 64 | 128; // Update, Delete, Change owner, Change role
  for (const r of rules) {
    const isDefault = isShippedRule(r.type);
    const id = r.id ?? "?";
    const name = r.name ?? "?";
    const condition = String(r.rule ?? "").trim();
    const filter = String(r.resourceFilter ?? "").trim();
    if (isDefault && r.disabled) {
      findings.push({ severity: "warn", ruleId: id, ruleName: name,
        reason: "Default rule is disabled — the site deviates from the shipped security baseline" });
    }
    if (!isDefault && !r.disabled) {
      if (filter === "*") {
        findings.push({ severity: "high", ruleId: id, ruleName: name,
          reason: "Custom rule applies to ALL resource types (resourceFilter '*')" });
      }
      const unconditional = condition === "" || /^\(*\s*true\s*\)*$/i.test(condition);
      if (unconditional && (Number(r.actions) & WRITE_MASK) !== 0) {
        findings.push({ severity: "high", ruleId: id, ruleName: name,
          reason: `Unconditional custom rule grants write-level actions (${decodeRuleActions(Number(r.actions)).join(", ")})` });
      }
    }
    if (!isDefault && r.disabled) {
      findings.push({ severity: "info", ruleId: id, ruleName: name,
        reason: "Disabled custom rule — dead configuration worth pruning" });
    }
  }
  return findings;
}

/** Flatten the engine healthcheck payload into the numbers an operator asks
 *  for first; the raw payload rides along untouched. */
export function summarizeHealthcheck(h: Record<string, any>) {
  const committed = Number(h.mem?.committed ?? 0);
  const free = Number(h.mem?.free ?? 0);
  return {
    version: h.version,
    started: h.started,
    saturated: h.saturated === true,
    memCommittedMB: committed,
    memFreeMB: free,
    cpuTotalPct: h.cpu?.total,
    sessions: h.session,
    apps: {
      activeDocs: Array.isArray(h.apps?.active_docs) ? h.apps.active_docs.length : h.apps?.active_docs,
      loadedDocs: Array.isArray(h.apps?.loaded_docs) ? h.apps.loaded_docs.length : h.apps?.loaded_docs,
      inMemoryDocs: Array.isArray(h.apps?.in_memory_docs) ? h.apps.in_memory_docs.length : h.apps?.in_memory_docs,
      calls: h.apps?.calls,
      selections: h.apps?.selections,
    },
    users: h.users,
    raw: h,
  };
}

/** Build engine field-value duals for SelectValues. Numeric values (and
 *  numeric-looking strings) get qIsNumeric + qNumber — a text-only qText
 *  against a numeric field silently selects nothing or widens. */
export function buildSelectValues(values: Array<string | number>) {
  return values.map((v) => {
    const n = typeof v === "number" ? v : Number(v);
    const isNum = typeof v === "number" || (String(v).trim() !== "" && Number.isFinite(n));
    return isNum
      ? { qText: String(v), qIsNumeric: true, qNumber: n }
      : { qText: String(v), qIsNumeric: false };
  });
}
