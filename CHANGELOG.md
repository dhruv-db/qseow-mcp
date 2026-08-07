# Changelog

## 0.4.0 — 2026-08-06

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
