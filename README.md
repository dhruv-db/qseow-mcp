# qlik-sense-mcp

**An MCP server for Qlik Sense Enterprise on Windows (client-managed).**

Qlik Cloud ships a native MCP endpoint. The client-managed estate — where a large share of enterprise Qlik still runs — has nothing equivalent. This server exposes the on-prem API surface (Repository/QRS, Engine/QIX, Proxy) as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an MCP client can govern, query, and build against a Qlik Sense site.

> **Status: 0.1.0, early.** Validated end-to-end against Qlik Sense **May 2026 (15.13.8)** on a single-node site. Tool names and shapes may still change.

## Tools by persona

Expose only what a given deployment needs with `QSEOW_TOOL_GROUPS`.

**Analyst** — ask questions of data (Engine/QIX)
| Tool | Purpose |
|---|---|
| `list_engine_apps` | Apps visible to the session |
| `get_app_data_model` | Tables, fields, row counts, cardinality |
| `evaluate_expression` | Evaluate a Qlik expression in the current selection state |
| `create_hypercube` | Group-by query: dimensions × measures → rows |
| `get_field_values` | Distinct values with selection state, optional search |
| `select_field_values` / `clear_selections` / `get_current_selections` | Drive and inspect selection state |

**Developer** — build and ship apps (Engine + QRS)
| Tool | Purpose |
|---|---|
| `get_script` / `set_script` | Read and replace an app's load script |
| `check_script` | Syntax-check without reloading |
| `reload_app` | Reload and save, returns progress tail |
| `create_app` | Create app, optionally set script and reload |
| `copy_app` / `publish_app` | Duplicate; publish to a stream |

**Admin** — govern the site (QRS)
| Tool | Purpose |
|---|---|
| `qrs_about` / `service_status` | Version; health of every service on every node |
| `license_summary` | Serial, edition, expiry, professional/analyzer allocations |
| `list_apps` / `list_streams` / `list_tasks` / `list_users` | Inventory, all filterable |
| `start_task` | Trigger a reload task |
| `list_extensions` / `list_data_connections` | Extension and connection inventory |
| `qrs_search` | Any QRS entity + filter expression — the governance power tool |

Mutating tools (`set_script`, `reload_app`, `create_app`, `copy_app`, `publish_app`, `start_task`) are **not registered unless `QSEOW_ALLOW_MUTATIONS=true`**. Default is read-only.

## Authentication

Two modes, both standard QSEoW patterns. Header-authentication virtual proxies are deliberately **not** supported: any client that can reach the proxy can assert any identity, which is not a footing to build an agent tool on.

**`certificate`** — QMC-exported client certificates against QRS `:4242` and Engine `:4747`. This is the service-to-service path and currently the only mode with full tool coverage. Export via QMC, or `POST /qrs/certificatedistribution/exportcertificates`.

**`jwt`** — a signed, expiring token through a JWT virtual proxy on `:443`. Carries a real per-user identity, so it's the right mode when the agent should act as a person and inherit that person's section-access and security rules.

### JWT and the engine

JWT authentication is verified working for the **entire QRS/REST surface** (all admin tools). Engine tools over JWT are currently blocked in our validation environment: the WebSocket upgrade returns 403, and the proxy audit log shows authentication *succeeding* and then Qlik's **Cross-Site WebSocket Hijacking (CSWSH)** check failing.

What we ruled out — all still 403:

- `Origin` absent, matching the request host, and every entry present in the virtual proxy's `websocketCrossOriginWhiteList` (with and without port)
- `Host` header overrides
- `Authorization: Bearer` on the upgrade, an established session cookie from a prior REST call, and both together
- `xrfkey` as query parameter, as `X-Qlik-Xrfkey` header, and both
- Running the client **on the Qlik server itself**, localhost to localhost, with no tunnel or port-forward in the path — this rules out network topology as the cause
- Proxy service restart after every virtual proxy change

One genuine misconfiguration was found and fixed along the way: a virtual proxy created through the QRS API has an **empty `loadBalancingServerNodes`**, so no engine is reachable through it until a server node is attached. Fixing that did not resolve the CSWSH rejection.

Until this is understood, **certificate mode is the supported path for engine tools**; JWT is fully supported for governance/REST tools. If you have JWT + engine WebSocket working against QSEoW, the upgrade request headers from a working session would be very welcome in an issue.

## Quick start

```bash
npm install && npm run build
cp .env.example .env      # fill in host + auth
node dist/index.js        # stdio MCP server
```

Register with an MCP client (Claude Desktop / Claude Code) as a stdio server running `node /path/to/dist/index.js` with the environment from your `.env`.

Integration smoke test against a live site (creates a small demo app, needs `QSEOW_ALLOW_MUTATIONS=true`):

```bash
npm run smoke
```

## Notes

- Engine sessions are cached per server process with a 5-minute idle reap, so selections persist across tool calls within a conversation.
- QRS calls generate a fresh `xrfkey` per request.
- `QSEOW_TLS_VERIFY=false` exists for self-signed lab certificates; leave it on in production.

## License

Apache-2.0
