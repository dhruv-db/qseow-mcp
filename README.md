# qseow-mcp

**An MCP server for Qlik Sense Enterprise on Windows (client-managed).**

**The glue layer for a Qlik support agent.** Qlik Cloud ships a native MCP endpoint; the client-managed estate — where a large share of enterprise Qlik still runs — has nothing equivalent. This server exposes the on-prem API surface (Repository/QRS, Engine/QIX, Proxy) as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an agent can do what a support engineer does when a number is wrong: walk KPI → object → sheet → app → script → source, evaluating definitions at every step — plus govern, query, and build against the site.

> **Status: 0.5.1, pre-release.** All 44 tools exercised end-to-end against Qlik Sense **May 2026 (15.13.8)** on a single-node site, in BOTH certificate and JWT auth modes (including the full mutation lifecycle: copy → set_script → reload → publish → delete, and task start-to-finish). Tool names and shapes may still change.

> qseow-mcp is an independent open-source project by Terenzi LLC. It is **not affiliated with, endorsed by, or sponsored by QlikTech International AB**. Qlik®, Qlik Sense®, and related marks are trademarks of QlikTech International AB, used here only to identify the software this server interoperates with.

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
| `crosscheck_expression` | Adversarial self-check: total vs sum-of-groups — flags non-additive measures and scoping bugs before a number reaches a user |

Every value-returning analytics tool ships a **trust envelope**: expression validation warnings (a misspelled field returns null/0 *without erroring* — the engine's worst habit) and the active selections the value was computed under, so a filtered number can never masquerade as the unfiltered truth.

**Inspector** — the troubleshooting loop (ships with the analyst group)

| Tool | Purpose |
|---|---|
| `list_sheets` / `get_sheet_objects` | Walk the UI layer: sheets and the objects on them |
| `get_object_properties` | Full qProps of any object — the definition layer |
| `search_expressions` | Find a field, KPI, or expression fragment across ALL objects (with owning sheet), master items, variables, and the script |
| `list_master_measures` / `list_master_dimensions` | The governed definition inventory |
| `evaluate_master_measure` | Evaluate a master measure by id or title (sidesteps the `[Name]`-resolves-to-a-field trap) |
| `get_app_lineage` | Every LOAD/STORE source and target, classified (qvd, database, inline, resident, store) |

**Published-app caveat:** the engine hides a published app's *script* and *lineage* from user identities (internal certificate identities bypass this). The support-agent pattern is `copy_app` → trace the owned copy — the copy carries the same script and definitions.

**Developer** — build and ship apps (Engine + QRS)

| Tool | Purpose |
|---|---|
| `create_sheet` / `add_sheet_object` | Build the UI layer: sheets and visualizations. Creation runs the render-validation gate and returns its verdict |
| `validate_sheet` | Quality gate (read-only): will these objects actually render? Definition errors, unknown fields/types, empty cubes, pivot qMode traps, missing nebula property blocks, cell-placement lint |
| `get_script` / `set_script` | Read and replace an app's load script |
| `check_script` | Syntax-check without reloading |
| `reload_app` | Reload and save, returns progress tail |
| `create_app` | Create app, optionally set script and reload |
| `copy_app` / `publish_app` / `delete_app` | Duplicate; publish to a stream; delete |

**Admin** — govern the site (QRS)

| Tool | Purpose |
|---|---|
| `qrs_about` / `service_status` | Version; health of every service on every node |
| `license_summary` | Serial, edition, expiry, professional/analyzer allocations |
| `list_apps` / `list_streams` / `list_tasks` / `list_users` | Inventory, all filterable |
| `start_task` | Trigger a reload task |
| `list_extensions` / `list_data_connections` | Extension and connection inventory |
| `qrs_search` | Any QRS entity + filter expression — the governance power tool |
| `get_reload_log` | Why did a reload fail? Last execution result + detail timeline + script-log tail |
| `engine_healthcheck` | Engine version, saturated flag, memory/CPU, loaded apps, session counts |
| `security_rule_audit` | Every security rule with decoded actions + lint findings (disabled defaults, wildcard filters, unconditional write grants) |
| `list_user_sessions` / `end_user_sessions` | Active proxy sessions per user; force logout. Certificate-backed — see note below |

Mutating tools (`set_script`, `reload_app`, `create_app`, `copy_app`, `publish_app`, `delete_app`, `start_task`, `end_user_sessions`, `create_sheet`, `add_sheet_object`) are **gated at registration**: unless `QSEOW_ALLOW_MUTATIONS=true`, they are never registered, so a read-only deployment advertises a genuinely read-only tool surface in `tools/list`. Default is read-only.

Every tool carries MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients that honor them can apply their own policy — e.g. `reload_app`/`set_script`/`start_task` are flagged destructive; selection tools are non-destructive session-state mutations.

Credential redaction applies to **every** QRS egress path: `list_data_connections` and generic `qrs_search` (any entity type, condensed or `full:true`) recursively mask credential-bearing fields (`password`, `passphrase`, `clientsecret`, ...) and secrets embedded in connection strings (`PWD=...`, `apikey=...`). Empty/null credential fields pass through unmasked — "no credential present" is a legitimate signal.

All list tools are paged (`offset`/`limit`, envelope `{total, offset, returned, truncated, items}`) so a site with thousands of apps or users cannot blow the client's context window.

### Render verification

Modern Sense visualizations are **nebula.js supernovas rendered by the client, not the engine** — a hypercube the engine accepts and evaluates perfectly still renders **blank** if the supernova's default property blocks are missing (it throws `Cannot read properties of undefined` in the browser; the engine never knows). The builder ships those blocks per type, and `validate_sheet` flags objects that lack them.

Because engine-side validation cannot prove pixels, two scripts close the loop: `scripts/viz_matrix.mjs` builds one of every supported type against a live site, and `scripts/render_proof.mjs` drives a real headless browser over the result at **sheet-tile sizes** and reports what actually drew.

**All 12 supported types are render-verified on Qlik Sense May 2026**, at sheet-tile sizes, in a real browser client: kpi, gauge, barchart, linechart, combochart, piechart, scatterplot, treemap, table, pivot-table, listbox, text-image.

### Getting a chart's real property contract

When a supernova refuses to draw, do not reverse-engineer its properties from error messages — some charts throw nothing useful. Instead ask the client what it writes:

```bash
node scripts/harvest_client_props.mjs treemap ./truth.json
```

This scans every readable app for **client-authored** objects of that type and dumps their properties. Qlik's shipped monitoring apps (Content / Operations / License Monitor) are a good source. This is how the last two broken types were fixed, each in a single pass after repeated guesswork had failed:

- **treemap** needed `qMode: "K"` (tree mode — the same class of trap as pivot-table needing `"P"`) plus a far leaner property set than the generic builder produced. Harvested from Qlik's shipped Content Monitor app.
- **gauge** needed `gaugetype`, `angle`, `autoOrientation`, `paletteProgressColor` and `segmentInfo` — properties no error message ever named, because gauge fails silently. Harvested from a gauge authored in the Sense client for the purpose.

If a chart you build renders blank or errors, author one in the client, harvest it, and mirror it. That loop is minutes; reverse-engineering from crash messages is hours and does not terminate when the chart fails quietly.

Three methodology notes worth stealing if you build something similar:

1. Objects render at **sheet-tile size**, not full viewport — a chart that paints at 900×620 can refuse in a 640×150 tile.
2. **Counting painted SVG nodes is not proof.** A broken chart still draws its legend; that is how an earlier version of this proof reported a false PASS for treemap.
3. **Automated verdicts are advisory; the screenshot is the authority.** Qlik draws some error states as SVG text inside a shadow root that neither DOM scraping nor Playwright text locators matched reliably — treemap displayed "This chart cannot be displayed." while every automated probe called it rendered. Run `render_proof.mjs` with `SHOTS=<dir>` and look at the images.

## Authentication

Two modes, both standard QSEoW patterns. Header-authentication virtual proxies are deliberately **not** supported: any client that can reach the proxy can assert any identity, which is not a footing to build an agent tool on.

**`certificate`** — QMC-exported client certificates against QRS `:4242` and Engine `:4747`. The service-to-service path; full tool coverage. Export via QMC, or `POST /qrs/certificatedistribution/exportcertificates`.

**`jwt`** — a signed, expiring token through a JWT virtual proxy on `:443`. Carries a real per-user identity, so it's the right mode when the agent should act as a person and inherit that person's section-access and security rules.

**One platform exception:** the Proxy Service REST API (`:4243`, behind `list_user_sessions`/`end_user_sessions`) only speaks certificate auth — Qlik exposes no JWT route to it. Those two tools register whenever certificate material is configured (`QSEOW_CERT_PATH`/`QSEOW_CERT_KEY_PATH`), in **either** auth mode, and are absent from `tools/list` otherwise. Every other tool has identical coverage in both modes.

### JWT and the engine WebSocket (CSWSH)

Both modes have full tool coverage apart from the two certificate-only QPS session tools noted above. Getting JWT working against the engine takes a specific handshake, documented here because it is easy to get wrong and the failure mode is an opaque `403` with an empty body.

A virtual proxy guards WebSocket upgrades with Cross-Site WebSocket Hijacking protection. Presenting the JWT as a bearer token on the upgrade **fails** — the proxy expects what a browser sends:

1. `GET /{prefix}/qps/csrftoken` with `Authorization: Bearer <jwt>`. The response carries the token in a **`qlik-csrf-token` response header** (not a cookie) plus the session in `Set-Cookie`.
2. Open the WebSocket at `wss://host/{prefix}/app/engineData?qlik-csrf-token=<token>` sending that **session cookie** — not the bearer token.

The server handles this automatically and caches the result. Caching is not just an optimization: every bearer-authenticated request mints a *new* Qlik session, and users have a parallel-session limit, so re-authenticating per call eventually gets you `OnMaxParallelSessionsExceeded` from the engine.

Things that are **not** the cause, in case you are debugging a similar 403: `Origin` (a browser sends one with a port and is accepted), `Host`, ports, tunnels or port-forwards, `xrfkey`, or entries in the virtual proxy's `websocketCrossOriginWhiteList` — that list takes bare hostnames and did not affect the outcome either way.

One genuine misconfiguration worth checking on any scripted setup: a virtual proxy created through the QRS API comes up with an **empty `loadBalancingServerNodes`**, so no engine is reachable through it until a server node is attached.

To debug proxy authentication generally, enable debug logging: create `%ProgramData%\Qlik\Sense\Proxy\LocalLogConfig.xml` with a `QSRollingFileAppender` at `threshold=debug` bound to the `Audit.Proxy`, `System.Proxy`, and `Security.Proxy` loggers, then restart the proxy. It logs every request header the proxy actually received, which is the fastest way to compare a working browser upgrade against your client.

### Minting a test JWT

JWT mode is bring-your-own-token: you supply a signed JWT via `QSEOW_JWT` (or `QSEOW_JWT_PATH`), and your JWT virtual proxy's config decides which claims map to the Qlik identity. In the common setup the VP maps `sub` → user id and a directory claim → user directory, and validates the signature against the certificate pasted into the VP. To generate a short-lived token for testing, sign with the matching **private** key (RS256):

```js
// mint-jwt.mjs — node >=20, no deps. Usage: node mint-jwt.mjs > token.jwt
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const key = readFileSync(process.env.JWT_PRIVATE_KEY_PATH, "utf8"); // PEM the VP trusts
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT" };
const payload = {
  sub: process.env.QLIK_USER_ID || "svc_agent",          // → VP "User ID" claim
  directory: process.env.QLIK_USER_DIRECTORY || "QSEOW",  // → VP "User directory" claim
  iat: now,
  exp: now + 3600,
};
const unsigned = `${b64u(header)}.${b64u(payload)}`;
const sig = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
process.stdout.write(`${unsigned}.${sig}`);
```

Match the claim names to *your* virtual proxy's attribute mapping — they are configurable in the QMC. The identity you mint for must hold a Professional (or appropriate) license allocation, or the engine rejects `OpenDoc` with an opaque socket close.

**Trust model — read this before you point it at production.** A JWT virtual proxy verifies every token against the certificate you paste into it; a token is accepted only if it was signed by the *matching private key*. That private key is therefore a **master credential**: whoever holds it can mint a token asserting any identity the proxy will map, exactly as any SAML/OIDC identity provider can. This is inherent to JWT SSO, not something this server adds — qseow-mcp is only a *client* presenting a token, and it can impersonate nothing against a proxy whose private key it does not hold. The snippet above is harmless to publish for the same reason: it can only sign against a proxy **you already control**. Security therefore rests on four things, in order: (1) **guard the signing key** like the crown jewel it is — a secret store or HSM, never a repo, rotate on suspicion; (2) authentication is not authorization — a minted identity is still bound by that user's **security rules, stream access, and section access**, so scope the agent by scoping the Qlik user (the reason to prefer JWT over certificate mode, which runs as an internal identity that bypasses security rules); (3) the identity needs a **license allocation** to do anything; (4) keep tokens **short-lived** (the example expires in an hour) so a leaked token, unlike a leaked key, expires on its own. The server itself is read-only by default, so even a valid identity cannot mutate unless you enable it.

## Quick start

```bash
npm install && npm run build
cp .env.example .env      # fill in host + auth
node dist/index.js        # stdio MCP server
```

The server reads `./.env` automatically if present (or the file named by `QSEOW_ENV_PATH`); variables already set in the environment always win. When registering with an MCP client (Claude Desktop / Claude Code), either pass the variables in the client's `env` block or set `QSEOW_ENV_PATH` to an absolute path — the client controls the working directory, so a relative `./.env` may not be found.

## Demos

Three runnable demos live in [`examples/`](examples/) (GitHub repo only — not part of the npm package). Each has a runbook and an assertion-backed `trace.mjs`, so the claims are verifiable rather than illustrative:

| Demo | Shows | Tool time |
|---|---|---|
| [finance-close](examples/finance-close-demo/) | Root-cause a $50M reconciliation mismatch: KPI → definition → lineage → script → fix → tie-out | ~5 s |
| [ops](examples/ops-demo/) | Why did the nightly reload fail; is the engine healthy; has the security-rule baseline drifted | ~3 s |
| [builder](examples/builder-demo/) | Build a sheet from a brief, refuse nonsense, catch a silently-wrong measure, verify renderability | ~20 s |

Run any of them with `cd examples/<demo> && node trace.mjs` — a non-zero exit means an assertion failed.

Integration smoke test against a live site (creates a small demo app, needs `QSEOW_ALLOW_MUTATIONS=true`):

```bash
npm run smoke
```

## Notes

- Engine sessions are cached per server process with a 5-minute idle reap, so selections persist across tool calls within a conversation.
- QRS calls generate a fresh `xrfkey` per request.
- `QSEOW_TLS_VERIFY=false` exists for self-signed lab certificates; leave it on in production.

## Commercial support

qseow-mcp is free and open-source, and stays that way. If you want a Qlik troubleshooting/support agent running against your own estate — the server plus agent configuration, playbooks, and team enablement, deployed and validated — that's what [Terenzi LLC](https://www.terenzi.llc/qseow-mcp) does. There's a fixed-fee, read-only [assessment](https://www.terenzi.llc/services/support-agent-assessment) to start.

Terenzi LLC is a Qlik partner; this project is independent and is not a Qlik product (see the trademark note above).

## License

Apache-2.0 — Copyright 2026 Terenzi LLC. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
