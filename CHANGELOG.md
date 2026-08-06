# Changelog

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
