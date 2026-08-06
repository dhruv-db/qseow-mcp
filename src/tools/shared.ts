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
const SECRET_KV = /\b(pwd|password|passwd|secret|apikey|api_key|client_secret|access_token|refresh_token)(\s*=\s*)[^;"']*/gi;

function scrubString(s: string): string {
  return s.replace(SECRET_KV, (_m, key: string, eq: string) => `${key}${eq}***REDACTED***`);
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
