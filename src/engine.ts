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

interface CachedSession {
  session: any;
  global: any;
  apps: Map<string, any>;
  lastUsed: number;
}

/** Engine (QIX) session factory with a single cached global session and
 *  per-app doc cache so selections persist across tool calls. */
export class EngineClient {
  private cached?: CachedSession;
  private idleTimer?: ReturnType<typeof setInterval>;
  private cachedCookie?: string;

  constructor(private cfg: Config, private session?: ProxySession) {
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  private async wsUrl(): Promise<string> {
    const cfg = this.cfg;
    if (cfg.authMode === "jwt") {
      // The proxy's CSWSH check requires a server-issued CSRF token on the URL.
      const { csrfToken } = await this.session!.ensure();
      return `wss://${cfg.host}:${cfg.proxyPort}/${cfg.vpPrefix}/app/engineData?qlik-csrf-token=${encodeURIComponent(csrfToken)}`;
    }
    return `wss://${cfg.host}:${cfg.enginePort}/app/engineData`;
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

  async global(): Promise<any> {
    if (this.cached) {
      this.cached.lastUsed = Date.now();
      return this.cached.global;
    }
    if (this.cfg.authMode === "jwt") {
      this.cachedCookie = (await this.session!.ensure()).cookie;
    }
    const session = enigma.create({
      schema,
      url: await this.wsUrl(),
      createSocket: (url: string) => this.createSocket(url),
      suspendOnClose: false,
    });
    session.on("closed", () => { this.cached = undefined; });
    let global: any;
    try {
      global = await session.open();
    } catch (e) {
      try { await session.close(); } catch { /* noop */ }
      throw normalizeEngineError("engine session open failed", e);
    }
    this.cached = { session, global, apps: new Map(), lastUsed: Date.now() };
    return global;
  }

  async app(appId: string): Promise<any> {
    const g = await this.global();
    const c = this.cached!;
    if (c.apps.has(appId)) {
      try {
        await c.apps.get(appId).getAppLayout(); // liveness check
        return c.apps.get(appId);
      } catch { c.apps.delete(appId); }
    }
    try {
      const doc = await g.openDoc(appId, "", "", "", false);
      c.apps.set(appId, doc);
      return doc;
    } catch (e) {
      throw normalizeEngineError(`openDoc(${appId}) failed`, e);
    }
  }

  private async reapIdle(): Promise<void> {
    if (this.cached && Date.now() - this.cached.lastUsed > 5 * 60_000) {
      try { await this.cached.session.close(); } catch { /* already gone */ }
      this.cached = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.cached) { try { await this.cached.session.close(); } catch { /* noop */ } }
    this.cached = undefined;
  }
}
