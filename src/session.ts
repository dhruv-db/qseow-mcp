import https from "node:https";
import type { Config } from "./config.js";

export interface ProxyCredentials {
  cookie: string;
  csrfToken: string;
}

/**
 * JWT-mode session bootstrap.
 *
 * A Qlik virtual proxy protects WebSocket upgrades with a CSRF check
 * ("Cross-Site Websocket Hijacking prevention"). Presenting the JWT as a
 * bearer token on the upgrade is rejected — the proxy expects the same thing a
 * browser sends: an established session cookie plus a server-issued CSRF token
 * as the `qlik-csrf-token` query parameter.
 *
 * GET /{prefix}/qps/csrftoken authenticates the JWT once and returns both: the
 * session in Set-Cookie and the token in a `qlik-csrf-token` response header.
 *
 * Reusing the result matters. Every bearer-authenticated request mints a fresh
 * Qlik session, and users have a parallel-session limit — re-authenticating per
 * call exhausts it and the engine answers OnMaxParallelSessionsExceeded.
 */
export class ProxySession {
  private creds?: ProxyCredentials;
  private inFlight?: Promise<ProxyCredentials>;

  constructor(private cfg: Config) {}

  async ensure(): Promise<ProxyCredentials> {
    if (this.creds) return this.creds;
    if (!this.inFlight) {
      this.inFlight = this.bootstrap().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  /** Drop cached credentials so the next call re-authenticates. */
  invalidate(): void {
    this.creds = undefined;
  }

  private bootstrap(): Promise<ProxyCredentials> {
    const cfg = this.cfg;
    return new Promise<ProxyCredentials>((resolve, reject) => {
      const req = https.request({
        host: cfg.host,
        port: cfg.proxyPort,
        method: "GET",
        path: `/${cfg.vpPrefix}/qps/csrftoken`,
        headers: { Authorization: `Bearer ${cfg.jwt}`, Accept: "*/*", Connection: "close" },
        rejectUnauthorized: cfg.tlsVerify,
        // The proxy closes this connection after the 204; keeping it out of the
        // pool stops the next request from inheriting a dead socket.
        agent: false,
      }, (res) => {
        res.resume(); // drain
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`CSRF bootstrap GET /${cfg.vpPrefix}/qps/csrftoken -> ${res.statusCode}`));
            return;
          }
          const csrfToken = res.headers["qlik-csrf-token"];
          const setCookie = res.headers["set-cookie"] ?? [];
          const sessionCookie = setCookie
            .map((c) => c.split(";")[0])
            .find((c) => c.startsWith("X-Qlik-Session"));
          if (typeof csrfToken !== "string" || !csrfToken) {
            reject(new Error("CSRF bootstrap: no qlik-csrf-token response header"));
            return;
          }
          if (!sessionCookie) {
            reject(new Error("CSRF bootstrap: no X-Qlik-Session cookie returned"));
            return;
          }
          this.creds = { cookie: sessionCookie, csrfToken };
          resolve(this.creds);
        });
      });
      req.on("error", reject);
      req.end();
    });
  }
}
