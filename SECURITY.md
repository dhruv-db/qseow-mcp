# Security

## Reporting

Email the maintainer via the GitHub profile contact rather than opening a
public issue for anything exploitable. Expect an acknowledgment within a few
days.

## Design posture

- **Default read-only.** Mutating tools are not registered unless
  `QSEOW_ALLOW_MUTATIONS=true` — a read-only deployment's `tools/list` is
  genuinely read-only.
- **Credential redaction on every egress path**: QRS entities (including
  generic `qrs_search` with `full: true` and secrets embedded in connection
  strings), load scripts (`get_script`, `search_expressions` snippets),
  reload logs and progress output (`get_reload_log`, `reload_app`), and
  object properties. `set_script` refuses to write a script containing the
  redaction marker, so masked scripts cannot silently round-trip over real
  credentials. If you find a bypass, that's a security bug — report it as
  above.
- **GUID validation on id arguments.** App and task ids are interpolated into
  QRS URLs and engine WebSocket paths; non-GUID values are rejected at the
  schema and again at the engine client.
- **No header-auth virtual proxies.** Identity comes from QMC-exported
  certificates or a signed, expiring JWT. Header auth is spoofable by any
  client that can reach the proxy and is deliberately unsupported.
- **Least privilege:** run the MCP under a dedicated Qlik user with the
  narrowest role that serves your use case; expose only the tool groups you
  need (`QSEOW_TOOL_GROUPS`). Certificate mode bypasses security rules —
  prefer JWT mode when the agent should inherit a real user's access.
- `QSEOW_TLS_VERIFY=false` is for lab self-signed certs only.
