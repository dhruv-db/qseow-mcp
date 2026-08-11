# Changelog

## 0.5.1 — 2026-08-11

**Security fix: credential redaction missed camelCase-prefixed field names.**

- `redactSecrets` matched field names against an anchored `^...$` pattern, so
  it masked `clientSecret` but not `oidcClientSecret` / `samlClientSecret` —
  the names Qlik actually uses on `virtualproxyconfig`. A site with OIDC SSO
  configured egressed its identity-provider client secret in cleartext through
  `qrs_search(entity: "virtualproxyconfig", full: true)`. Field names are now
  matched as substrings, mirroring the prefix/suffix tolerance `SECRET_KV`
  already applied to free text.
- Public, non-credential fields (`oidcClientId`, `jwtPublicKeyCertificate`)
  are unaffected and still egress intact.
- Regression tests + a `virtualproxyconfig` fixture cover the prefixed-name
  case and the non-secret look-alikes.
- **Same bug family, closed pre-emptively:** credentials stored as name/value
  PAIRS (`userdirectoryconnector.settings` holds an LDAP bind password as
  `{name: "Password", value: "..."}`) put the secret under a key called
  `value`, which a name-based matcher walks straight past. The redactor now
  masks a `value`/`val`/`settingValue` whose sibling `name`/`key`/
  `settingName` names a credential. The label itself is preserved, so the
  response still shows *that* a password setting exists.

Found and fixed **pre-release**: the repository was private and 0.5.0 was
never published, so no third-party deployment was affected.

## 0.5.0 — 2026-08-07/08

**The UI builder + render-validation gate, and the analytics trust envelope.**

- `create_sheet` / `add_sheet_object` (mutation-gated): build sheets and
  visualizations. `add_sheet_object` refuses bad shapes and unknown dimension
  fields BEFORE creating, then runs the validation gate on what it created —
  the response says whether the object will actually render.
- `validate_sheet` (read-only): the standalone gate for any sheet or object —
  definition errors (qError), unknown visualization types (vs built-ins +
  installed extensions), unknown fields in measure expressions, empty-data
  cubes, the pivot-table qMode='P' trap, and cell-placement lint (unplaced
  objects, orphan cells, off-grid, overlaps). The engine happily persists
  definitions the client renders blank; "saved" and "renders" are different
  claims and the gate closes the gap.
- Auto-placement grows the sheet grid when tiles would overflow it — a bug
  the gate itself caught on its first live run (14 tiles vs a 12-row grid).
- `scripts/viz_matrix.mjs`: builds one of every supported type through the
  MCP server against a live engine, validates each, probes the negative
  paths. 11/12 types render-verified in a real browser client, gauge flagged
  unverified; 4/4 negative probes caught (verified on May 2026).
- **Analytics trust envelope** on every value-returning tool
  (`evaluate_expression`, `create_hypercube`, `evaluate_master_measure`):
  engine-validated expression warnings (a misspelled field returns null/0
  WITHOUT erroring) and the active selections the value was computed under.
- `crosscheck_expression` (read-only): adversarial self-check — evaluates a
  measure as a single total AND as a group-by decomposition, compares, and
  flags non-additive measures (Count DISTINCT, ratios, chart-scoped set
  analysis) where sum-of-parts silently misleads.
- **Nebula render fix (found by pixel-proofing, not by the engine):** modern
  visualizations are `@nebula.js/sn-*` supernovas rendered client-side. Built
  from a bare hypercube, 8 of 12 types rendered BLANK while the engine
  reported a perfectly healthy object. The builder now ships the required
  default property blocks per type (shared block + per-supernova extras
  identified from each chart's exact browser TypeError: `showAsDonut` for
  pie, `settings.labels` for treemap, axis-specific `refLinesX/Y` for
  scatter, enumerated `columnOrder` for table). `validate_sheet` flags
  objects missing them. **All 12 supported types are render-verified against a
  real browser client at sheet-tile sizes.**
- **treemap fixed** by mirroring a client-authored treemap harvested from
  Qlik's shipped Content Monitor app: the cube must be `qMode: "K"` (tree
  mode — "S" renders Qlik's error state, the same trap as pivot needing "P"),
  and the shared property block had to be replaced by a lean, client-shaped
  set. Guessing from error messages had failed twice; harvesting worked in
  one pass.
- **gauge fixed** the same way: it needed `gaugetype: "radial"`, `angle`,
  `autoOrientation`, `paletteProgressColor` and `segmentInfo` (earlier
  attempts had invented a `segments` key). Gauge fails SILENTLY — no console
  error — so there was nothing to reverse-engineer from; harvesting a
  client-authored gauge answered it in one pass.
- `scripts/harvest_client_props.mjs`: finds client-authored objects of a given
  type and dumps their properties — the reusable way to get a supernova's real
  property contract instead of reconstructing it from crashes.
- `text-image` no longer fabricates `[Measure 1]` placeholder text — embedding
  a live measure needs the client's own inline markup, so the type now takes
  authored text only (measures are refused) and a kpi is the right tool for a
  live value.
- Per-type minimum tile sizes in auto-placement (a short tile makes some
  charts refuse to draw).
- `scripts/render_proof.mjs`: the headless-browser render proof, shipped so
  the pixel check is reproducible. Detects Qlik's error state explicitly —
  counting painted SVG nodes reports false PASSes because a broken chart
  still paints its legend.
- Demo suite completed and validated: `examples/README.md` index plus
  assertion-backed `trace.mjs` for all three demos (finance-close, ops,
  builder) with archived transcripts of real runs. Every demo claim is now
  executable — a non-zero exit means a claim failed.
- 44 tools total.

## 0.4.0 — 2026-08-06/07

**Tier 2: the ops layer** (ships with the `admin` group):

- `get_reload_log` — last execution result of a reload task (status, timing,
  detail timeline) plus the script-log tail via the QRS two-step download.
- `engine_healthcheck` — engine version, saturated flag, memory/CPU, loaded
  app counts, session/user counts (direct `:4747` in certificate mode, via
  the virtual proxy in jwt mode).
- `security_rule_audit` — every Security-category system rule with decoded
  action bitmasks, plus lint findings: disabled default rules, custom rules
  with a `*` resource filter, unconditional write-level grants. Findings are
  review prompts, not verdicts.
- `list_user_sessions` / `end_user_sessions` (QPS) — active proxy sessions per
  user and force-logout. The Proxy Service REST API (`:4243`) is
  certificate-only, so these register whenever certificate material is
  configured (either auth mode) and are absent otherwise. `end_user_sessions`
  is mutation-gated and flagged destructive.
- Certificate material now loads opportunistically in jwt mode when
  `QSEOW_CERT_PATH`/`QSEOW_CERT_KEY_PATH` are set (enables the QPS tools);
  still required in certificate mode. New `QSEOW_QPS_PORT` (default 4243).

**Pre-publication hardening (security review):**

- Credential redaction extended beyond QRS to every free-text egress path:
  `get_script`, `search_expressions` snippets, `get_reload_log` log lines and
  detail messages, `reload_app` progress tail, `get_object_properties`.
  Scrub patterns now cover quoted values (`password='x'`, `="x"`) and
  prefixed/suffixed key names (`vPassword`, `DB_APIKEY`).
- `set_script` refuses scripts containing the redaction marker, so a
  get→edit→set round trip can never overwrite real credentials with masks.
- App/task id arguments are validated as GUIDs at the tool schema and again
  in the engine client (ids are interpolated into URLs); QRS filter values
  built from user input are quote-escaped.
- The server now loads `./.env` (or `QSEOW_ENV_PATH`) itself — the Quick
  start previously implied this and it wasn't true. Explicit environment
  variables always win.
- `rawRequest` (healthcheck/QPS) retries once on socket-level failures,
  matching the QRS client.

## 0.3.0 — 2026-08-06

**Tier 1: the troubleshooting loop.** Eight inspector tools (ship with the
`analyst` group): `list_sheets`, `get_sheet_objects`, `get_object_properties`,
`search_expressions` (app-wide: objects annotated with owning sheet, master
items, variables, load script), `list_master_measures`,
`list_master_dimensions`, `evaluate_master_measure` (by id or title; avoids
the `[Name]`-resolves-to-a-field trap), `get_app_lineage` (classified).

- Documented platform behavior: a published app's script and lineage are
  hidden from user identities — pattern: `copy_app`, trace the copy.
- Example: `examples/finance-close-demo/` — a re-runnable reconciliation-
  mismatch trace (plant/reset deterministic to the cent) with a timed runbook.
- Unit tests (`npm test`, node --test) over the pure logic layer, with an
  optional `QPROP_FIXTURE_DIR` deep mode; GitHub Actions CI.

## 0.2.0 — 2026-08-05/06

- All 26→27 tools migrated to `registerTool` with MCP tool annotations
  (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).
- Mutating tools gated at **registration** — a read-only server advertises a
  genuinely read-only `tools/list`. New `delete_app` tool.
- Credential redaction on every QRS egress path (`qrs_search` any entity,
  `list_data_connections`), including connection-string-embedded secrets.
- `select_field_values`: numeric duals + post-select `selectedCount`
  verification + text fallback (fixes silent selection widening).
- Pagination on all list tools: `{total, offset, returned, truncated, items}`.
- Engine session-per-app architecture (a QIX socket holds at most one open
  doc); JWT sockets reuse one proxy session cookie.
- Full smoke coverage: every tool exercised in BOTH certificate and JWT auth
  modes, including the mutation lifecycle and task start-to-finish.

## 0.1.0 — 2026-08-04

Initial release: 26 tools across analyst/developer/admin personas,
certificate + JWT auth, JWT engine-WebSocket CSWSH handshake solved and
documented.
