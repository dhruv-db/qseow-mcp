import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";

/** QRS REST client. Certificate mode talks to :4242 directly as an internal
 *  service identity; JWT mode goes through the virtual proxy on :443. */
export class QrsClient {
  constructor(private cfg: Config) {}

  private xrfkey(): string {
    return randomBytes(8).toString("hex"); // 16 chars
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const cfg = this.cfg;
    const xrf = this.xrfkey();
    const viaProxy = cfg.authMode === "jwt";
    const port = viaProxy ? cfg.proxyPort : cfg.qrsPort;
    const prefix = viaProxy ? `/${cfg.vpPrefix}` : "";
    const sep = path.includes("?") ? "&" : "?";
    const fullPath = `${prefix}${path}${sep}xrfkey=${xrf}`;

    const headers: Record<string, string> = {
      "x-qlik-xrfkey": xrf,
      Accept: "application/json",
    };
    if (viaProxy) {
      headers.Authorization = `Bearer ${cfg.jwt}`;
    } else {
      headers["X-Qlik-User"] = `UserDirectory=${cfg.certUser.directory}; UserId=${cfg.certUser.id}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const options: https.RequestOptions = {
      host: cfg.host,
      port,
      method,
      path: fullPath,
      headers,
      rejectUnauthorized: cfg.tlsVerify,
      ...(cfg.cert && !viaProxy
        ? { cert: cfg.cert.cert, key: cfg.cert.key, passphrase: cfg.cert.passphrase, ca: cfg.cert.ca }
        : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`QRS ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          if (!text) { resolve(undefined as T); return; }
          try { resolve(JSON.parse(text) as T); } catch { resolve(text as unknown as T); }
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get<T = unknown>(path: string) { return this.request<T>("GET", path); }
  post<T = unknown>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }
  put<T = unknown>(path: string, body?: unknown) { return this.request<T>("PUT", path, body); }
  delete<T = unknown>(path: string) { return this.request<T>("DELETE", path); }
}
