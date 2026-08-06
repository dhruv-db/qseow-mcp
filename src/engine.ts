import { createRequire } from "node:module";
import WebSocket from "ws";
import type { Config } from "./config.js";
import type { ProxySession } from "./session.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enigma = require("enigma.js");
const schema = require("enigma.js/schemas/12.170.2.json");

function normalizeEngineError(prefix: string, e: unknown): Error {
  if (e instanceof Error && e.message && e.message !== "[object Object]") {
    return new Error(`${prefix}: ${e.message}`);
  }
  return new Error(`${prefix}: ${JSON.stringify(e)}`);
}

interface CachedGlobal {
  session: any;
  global: any;
  lastUsed: number;
}

interface CachedApp {
  session: any;
  doc: any;
  lastUsed: number;
}

/** Engine (QIX) session manager.
 *
 *  A QIX websocket holds AT MOST ONE open doc — a second OpenDoc on the same
 *  socket fails with "App already open" (hit live 2026-08-06 when a smoke run
 *  touched two apps). So: one dedicated session per app (standard Qlik
 *  pattern, socket path /app/<appId>), plus one appless session
 *  (/app/engineData) for global calls (doc list, createApp). Each app session
 *  caches its doc so selections persist across tool calls.
 *
 *  JWT mode: every socket reuses the SAME bootstrapped proxy session cookie,
 *  so N app sockets consume one proxy session — no collision with the
 *  proxy's max-parallel-sessions-per-user limit (default 5). */
export class EngineClient {
  private globalCached?: CachedGlobal;
  private appCached = new Map<string, CachedApp>();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cachedCookie?: string;

  constructor(private cfg: Config, private session?: ProxySession) {
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  private async wsUrl(pathId: string): Promise<string> {
    const cfg = this.cfg;
    if (cfg.authMode === "jwt") {
      // The proxy's CSWSH check requires a server-issued CSRF token on the URL.
      const { csrfToken } = await this.session!.ensure();
      return `wss://${cfg.host}:${cfg.proxyPort}/${cfg.vpPrefix}/app/${pathId}?qlik-csrf-token=${encodeURIComponent(csrfToken)}`;
    }
    return `wss://${cfg.host}:${cfg.enginePort}/app/${pathId}`;
  }

  private createSocket(url: string): WebSocket {
    const cfg = this.cfg;
    if (cfg.authMode === "jwt") {
      // Must be the session cookie, not the bearer token: a bearer on the
      // upgrade re-authenticates and the CSWSH check rejects it.
      return new WebSocket(url, {
        rejectUnauthorized: cfg.tlsVerify,
        origin: `https://${cfg.host}:${cfg.proxyPort}`,
        headers: { Cookie: this.cachedCookie! },
      });
    }
    return new WebSocket(url, {
      rejectUnauthorized: cfg.tlsVerify,
      cert: cfg.cert!.cert,
      key: cfg.cert!.key,
      passphrase: cfg.cert!.passphrase,
      ca: cfg.cert!.ca ? [cfg.cert!.ca] : undefined,
      headers: {
        "X-Qlik-User": `UserDirectory=${cfg.certUser.directory}; UserId=${cfg.certUser.id}`,
      },
    });
  }

  private async openSession(pathId: string): Promise<{ session: any; global: any }> {
    if (this.cfg.authMode === "jwt") {
      this.cachedCookie = (await this.session!.ensure()).cookie;
    }
    const session = enigma.create({
      schema,
      url: await this.wsUrl(pathId),
      createSocket: (url: string) => this.createSocket(url),
      suspendOnClose: false,
    });
    let global: any;
    try {
      global = await session.open();
    } catch (e) {
      try { await session.close(); } catch { /* noop */ }
      throw normalizeEngineError("engine session open failed", e);
    }
    return { session, global };
  }

  /** Appless global session — doc list, createApp, engine-wide calls. */
  async global(): Promise<any> {
    if (this.globalCached) {
      this.globalCached.lastUsed = Date.now();
      return this.globalCached.global;
    }
    const { session, global } = await this.openSession("engineData");
    session.on("closed", () => { this.globalCached = undefined; });
    this.globalCached = { session, global, lastUsed: Date.now() };
    return global;
  }

  /** Dedicated session per app; doc cached so selections persist. */
  async app(appId: string): Promise<any> {
    const existing = this.appCached.get(appId);
    if (existing) {
      try {
        await existing.doc.getAppLayout(); // liveness check
        existing.lastUsed = Date.now();
        return existing.doc;
      } catch {
        this.appCached.delete(appId);
        try { await existing.session.close(); } catch { /* already gone */ }
      }
    }
    const { session, global } = await this.openSession(appId);
    session.on("closed", () => { this.appCached.delete(appId); });
    try {
      const doc = await global.openDoc(appId, "", "", "", false);
      this.appCached.set(appId, { session, doc, lastUsed: Date.now() });
      return doc;
    } catch (e) {
      try { await session.close(); } catch { /* noop */ }
      throw normalizeEngineError(`openDoc(${appId}) failed`, e);
    }
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - 5 * 60_000;
    if (this.globalCached && this.globalCached.lastUsed < cutoff) {
      try { await this.globalCached.session.close(); } catch { /* already gone */ }
      this.globalCached = undefined;
    }
    for (const [appId, entry] of this.appCached) {
      if (entry.lastUsed < cutoff) {
        this.appCached.delete(appId);
        try { await entry.session.close(); } catch { /* already gone */ }
      }
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.globalCached) { try { await this.globalCached.session.close(); } catch { /* noop */ } }
    this.globalCached = undefined;
    for (const [, entry] of this.appCached) {
      try { await entry.session.close(); } catch { /* noop */ }
    }
    this.appCached.clear();
  }
}
