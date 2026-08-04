/**
 * qlik-sense-mcp — MCP server for Qlik Sense Enterprise on Windows.
 *
 * Pre-alpha scaffold. Entry point will wire:
 *   - @modelcontextprotocol/sdk server (stdio + streamable HTTP transports)
 *   - QRS client (REST, cert/header/jwt auth, Xrfkey handling)
 *   - Engine client (enigma.js over WSS)
 *   - Tool registries per group: governance, data, objects, script, sessions, ops
 *
 * Mutating tools are registered only when QSEOW_ALLOW_MUTATIONS=true.
 */

console.error("qlik-sense-mcp: scaffold only — no tools registered yet");
