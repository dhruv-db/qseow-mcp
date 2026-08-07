// Unit tests for the pure logic layer (node --test; no live site needed).
//
// Fixture modes:
//   - tests/fixtures/*.json  — synthetic, shipped with the repo, always run
//   - QPROP_FIXTURE_DIR=<dir> — optional deep mode: recursively walks every
//     .json under the dir (e.g. a real site snapshot with thousands of
//     recorded qProps) through the same code paths. Not shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  redactSecrets, paginate, walkStrings, classifyLineage, buildSelectValues,
  tailText, decodeRuleActions, lintSecurityRules, summarizeHealthcheck,
  scrubString, qrsQuote, REDACTED,
} from "../dist/tools/shared.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

// ── redactSecrets ────────────────────────────────────────────────────────────

test("redactSecrets masks credential fields but keeps empty/null", () => {
  const dc = redactSecrets(fixture("dataconnection_full.json"));
  assert.equal(dc.password, "***REDACTED***");
  assert.equal(dc.passphrase, "");                      // empty passes through
  assert.equal(dc.username, "svc_qlik");                // not a secret field
  assert.equal(dc.owner.userId, "svc_qlik");
});

test("redactSecrets scrubs key=value secrets inside connection strings", () => {
  const dc = redactSecrets(fixture("dataconnection_full.json"));
  assert.ok(!dc.connectionstring.includes("SuperSecret123"));
  assert.ok(dc.connectionstring.includes("PWD=***REDACTED***"));
  assert.ok(dc.connectionstring.includes("Data Source=warehouse.internal")); // non-secret kv intact
});

test("redactSecrets handles arrays and non-objects", () => {
  const arr = redactSecrets([{ password: "x" }, "pwd=abc;", 42, null]);
  assert.equal(arr[0].password, "***REDACTED***");
  assert.equal(arr[1], "pwd=***REDACTED***;");
  assert.equal(arr[2], 42);
  assert.equal(arr[3], null);
});

// ── scrubString: free-text egress (scripts, logs, snippets) ──────────────────

test("scrubString masks quoted and bare values, prefixed key names", () => {
  // Load-script shapes: SET/LET with quoted values, prefixed variable names.
  assert.equal(scrubString("SET vPassword = 'hunter2';"), `SET vPassword = ${REDACTED};`);
  assert.equal(scrubString('LET vApiKey = "abc-123";'), `LET vApiKey = ${REDACTED};`);
  assert.equal(scrubString("CUSTOM CONNECT TO \"provider=X;pwd=topsecret;host=y\";"),
    `CUSTOM CONNECT TO \"provider=X;pwd=${REDACTED};host=y\";`);
  // Reload-log echo of a script line.
  assert.equal(scrubString("0007 LET vClient_Secret = 'shh'"), `0007 LET vClient_Secret = ${REDACTED}`);
  // Non-secrets survive untouched.
  const clean = "LOAD OrderId, Region FROM [lib://X/y.qvd] (qvd);";
  assert.equal(scrubString(clean), clean);
});

// ── qrsQuote: filter-value escaping ──────────────────────────────────────────

test("qrsQuote escapes quotes and backslashes for QRS filters", () => {
  assert.equal(qrsQuote("Everyone"), "Everyone");
  assert.equal(qrsQuote("O'Brien's Stream"), "O\\'Brien\\'s Stream");
  assert.equal(qrsQuote("back\\slash"), "back\\\\slash");
});

// ── paginate ─────────────────────────────────────────────────────────────────

test("paginate envelope: defaults, offset/limit, truncated flag", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const d = paginate(items);
  assert.deepEqual([d.total, d.offset, d.returned, d.truncated], [250, 0, 100, true]);
  const p2 = paginate(items, 240, 100);
  assert.deepEqual([p2.returned, p2.truncated, p2.items[0]], [10, false, 240]);
  const all = paginate([1, 2, 3], 0, 100);
  assert.equal(all.truncated, false);
});

// ── buildSelectValues ────────────────────────────────────────────────────────

test("buildSelectValues: numbers and numeric strings become duals", () => {
  const [n, s, t, e] = buildSelectValues([120, "150", "East", ""]);
  assert.deepEqual(n, { qText: "120", qIsNumeric: true, qNumber: 120 });
  assert.deepEqual(s, { qText: "150", qIsNumeric: true, qNumber: 150 });
  assert.deepEqual(t, { qText: "East", qIsNumeric: false });
  assert.deepEqual(e, { qText: "", qIsNumeric: false });
});

// ── classifyLineage ──────────────────────────────────────────────────────────

test("classifyLineage covers the discriminator taxonomy", () => {
  assert.equal(classifyLineage("INLINE;", "LOAD * INLINE"), "inline");
  assert.equal(classifyLineage("RESIDENT Revenue", "LOAD"), "resident");
  assert.equal(classifyLineage("C:\\qlik\\revenue_close.qvd", "LOAD"), "qvd");
  assert.equal(classifyLineage("lib://X/y.qvd", "STORE Revenue INTO"), "store");
  assert.equal(classifyLineage("Provider=SQLOLEDB;Data Source=w", "SQL SELECT"), "database");
  assert.equal(classifyLineage("something.xlsx", "LOAD"), "other");
});

// ── walkStrings + search semantics over qProp fixtures ───────────────────────

function searchQProp(prop, term) {
  const needle = term.toLowerCase();
  const found = [];
  walkStrings(prop, "", (path, s) => {
    if (s.toLowerCase().includes(needle)) found.push({ path, s });
  });
  return found;
}

test("search finds an inline expression with its qProp path", () => {
  const hits = searchQProp(fixture("barchart_expressions.json"), "Scenario={'Actual'}");
  assert.equal(hits.length, 1);
  assert.match(hits[0].path, /qHyperCubeDef\.qMeasures\[0\]\.qDef\.qDef/);
});

test("search finds a library reference and a title expression", () => {
  assert.equal(searchQProp(fixture("kpi_library_ref.json"), "fixture-measure-1").length, 1);
  const title = searchQProp(fixture("barchart_expressions.json"), "GetCurrentSelections");
  assert.match(title[0].path, /title\.qStringExpression\.qExpr/);
});

test("every shipped fixture walks cleanly and yields string leaves", () => {
  for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith(".json"))) {
    let leaves = 0;
    walkStrings(fixture(f), "", () => { leaves++; });
    assert.ok(leaves > 0, `${f} produced no string leaves`);
  }
});

// ── tailText ─────────────────────────────────────────────────────────────────

test("tailText returns the last n lines and counts what it dropped", () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const t = tailText(log, 200);
  assert.deepEqual([t.totalLines, t.dropped, t.lines.length], [500, 300, 200]);
  assert.equal(t.lines[0], "line 301");
  assert.equal(t.lines.at(-1), "line 500");
  const short = tailText("a\r\nb", 10);
  assert.deepEqual([short.totalLines, short.dropped, short.lines], [2, 0, ["a", "b"]]);
  assert.deepEqual(tailText("", 10).totalLines, 0);
});

// ── decodeRuleActions / lintSecurityRules ────────────────────────────────────

test("decodeRuleActions decodes composite masks", () => {
  assert.deepEqual(decodeRuleActions(2), ["Read"]);
  assert.deepEqual(decodeRuleActions(1 + 2 + 4 + 8), ["Create", "Read", "Update", "Delete"]);
  assert.deepEqual(decodeRuleActions(64 | 128), ["Change owner", "Change role"]);
  assert.deepEqual(decodeRuleActions(0), ["unknown(0)"]);
});

test("lintSecurityRules flags the risky shapes and only those", () => {
  const rules = [
    { id: "r0", name: "RootAdmin", type: "ReadOnly", disabled: false, resourceFilter: "*", actions: 4294967295, rule: "((user.roles=\"RootAdmin\"))" },
    { id: "r1", name: "Owner", type: "Default", disabled: false, resourceFilter: "*", actions: 2, rule: "((Resource.owner = user))" },
    { id: "r2", name: "DisabledDefault", type: "Default", disabled: true, resourceFilter: "App*", actions: 2, rule: "x" },
    { id: "r3", name: "WildcardCustom", type: "Custom", disabled: false, resourceFilter: "*", actions: 2, rule: "user.name = \"x\"" },
    { id: "r4", name: "GodRule", type: "Custom", disabled: false, resourceFilter: "App_*", actions: 4 | 8, rule: "true" },
    { id: "r5", name: "DeadCustom", type: "Custom", disabled: true, resourceFilter: "App_*", actions: 2, rule: "x" },
    { id: "r6", name: "FineCustom", type: "Custom", disabled: false, resourceFilter: "Stream_*", actions: 2, rule: "user.group = \"BI\"" },
  ];
  const f = lintSecurityRules(rules);
  const byRule = Object.fromEntries(f.map((x) => [x.ruleId, x]));
  assert.equal(f.length, 4);
  assert.equal(byRule.r2.severity, "warn");   // disabled default
  assert.equal(byRule.r3.severity, "high");   // wildcard custom
  assert.equal(byRule.r4.severity, "high");   // unconditional write grant
  assert.equal(byRule.r5.severity, "info");   // dead custom
  assert.ok(!byRule.r0 && !byRule.r1 && !byRule.r6); // shipped ReadOnly/Default wildcards + scoped custom are fine
});

// ── summarizeHealthcheck ─────────────────────────────────────────────────────

test("summarizeHealthcheck flattens the operator numbers, keeps raw", () => {
  const h = {
    version: "12.1877.6", started: "20260806T120000.000Z", saturated: false,
    mem: { committed: 1024.5, allocated: 900, free: 14000 },
    cpu: { total: 3 },
    session: { active: 1, total: 2 },
    apps: { active_docs: ["a"], loaded_docs: ["a", "b"], in_memory_docs: ["a", "b"], calls: 42, selections: 7 },
    users: { active: 1, total: 1 },
  };
  const s = summarizeHealthcheck(h);
  assert.equal(s.saturated, false);
  assert.equal(s.memFreeMB, 14000);
  assert.deepEqual([s.apps.activeDocs, s.apps.loadedDocs], [1, 2]);
  assert.equal(s.raw.version, "12.1877.6");
  // Some engine builds return counts, not arrays — both shapes must survive.
  const s2 = summarizeHealthcheck({ apps: { active_docs: 3 } });
  assert.equal(s2.apps.activeDocs, 3);
});

// ── deep mode: a real snapshot directory of recorded qProps ──────────────────

test("deep fixture sweep (QPROP_FIXTURE_DIR)", { skip: !process.env.QPROP_FIXTURE_DIR }, () => {
  const root = process.env.QPROP_FIXTURE_DIR;
  let files = 0, leaves = 0, failures = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".json")) continue;
      files++;
      try {
        const doc = JSON.parse(readFileSync(p, "utf8"));
        walkStrings(doc, "", () => { leaves++; });
        redactSecrets(doc); // must never throw on real payloads
      } catch (e) {
        failures++;
        console.error("deep sweep failure:", p, String(e).slice(0, 120));
      }
    }
  };
  walk(root);
  console.log(`deep sweep: ${files} files, ${leaves} string leaves, ${failures} failures`);
  assert.equal(failures, 0);
  assert.ok(files > 0, "QPROP_FIXTURE_DIR contained no .json files");
});
