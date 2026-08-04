# qlik-sense-mcp

**An MCP server for Qlik Sense Enterprise on Windows (client-managed).**

Qlik Cloud ships a native MCP endpoint — the on-prem estate, where most large Qlik deployments still live, has nothing. This server exposes the full client-managed API surface (Repository, Engine/QIX, Proxy) as [Model Context Protocol](https://modelcontextprotocol.io) tools, so Claude and other MCP clients can govern, query, and operate a Qlik Sense site.

> **Status: pre-alpha scaffold.** API surface and tool schemas are being designed against a live QSEoW demo site. Nothing here is stable yet.

## Planned tool groups

| Group | API | Examples |
|-------|-----|----------|
| Governance/Admin | QRS REST | search apps/streams/users/tasks, security-rule audit, license usage |
| Data/Query | Engine (QIX) via WebSocket | evaluate expressions, build hypercubes, inspect data model |
| Objects/Viz | Engine GenericObject | read/create sheets and charts from properties, master items |
| Script/Reload | Engine + QRS tasks | get/set load script, reload, task chains, reload logs |
| Sessions/Access | QPS REST | tickets, session management |
| Ops/Health | healthcheck + QRS | service health, node info |

## Auth (all standard QSEoW patterns)

Client certificates (QMC export), header-auth virtual proxy, or JWT virtual proxy — configurable via environment. Mutating tools are gated behind an explicit opt-in; the default is read-only.

## Configuration

Copy `.env.example` to `.env` and fill in your site details. **Never commit `.env`.**

## License

Apache-2.0
