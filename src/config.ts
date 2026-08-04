import { readFileSync } from "node:fs";

export type AuthMode = "certificate" | "jwt";
export type ToolGroup = "analyst" | "developer" | "admin";

export interface Config {
  host: string;
  qrsPort: number;
  enginePort: number;
  proxyPort: number;
  authMode: AuthMode;
  vpPrefix: string;
  jwt?: string;
  cert?: { cert: Buffer; key: Buffer; passphrase?: string; ca?: Buffer };
  certUser: { directory: string; id: string };
  tlsVerify: boolean;
  toolGroups: Set<ToolGroup>;
  allowMutations: boolean;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): Config {
  const authMode = (env("QSEOW_AUTH_MODE", "certificate") as AuthMode);
  if (authMode !== "certificate" && authMode !== "jwt") {
    throw new Error(`QSEOW_AUTH_MODE must be "certificate" or "jwt", got "${authMode}"`);
  }

  let cert: Config["cert"];
  if (authMode === "certificate") {
    const certPath = env("QSEOW_CERT_PATH");
    const keyPath = env("QSEOW_CERT_KEY_PATH");
    if (!certPath || !keyPath) throw new Error("certificate mode requires QSEOW_CERT_PATH and QSEOW_CERT_KEY_PATH");
    cert = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      passphrase: env("QSEOW_CERT_PASSPHRASE"),
      ca: env("QSEOW_ROOT_CERT_PATH") ? readFileSync(env("QSEOW_ROOT_CERT_PATH")!) : undefined,
    };
  }

  let jwt: string | undefined;
  if (authMode === "jwt") {
    jwt = env("QSEOW_JWT");
    const jwtPath = env("QSEOW_JWT_PATH");
    if (!jwt && jwtPath) jwt = readFileSync(jwtPath, "utf8").trim();
    if (!jwt) throw new Error("jwt mode requires QSEOW_JWT or QSEOW_JWT_PATH");
  }

  const groups = (env("QSEOW_TOOL_GROUPS", "analyst,developer,admin") ?? "")
    .split(",").map((g) => g.trim().toLowerCase()).filter(Boolean) as ToolGroup[];

  return {
    host: env("QSEOW_HOST", "localhost")!,
    qrsPort: Number(env("QSEOW_QRS_PORT", "4242")),
    enginePort: Number(env("QSEOW_ENGINE_PORT", "4747")),
    proxyPort: Number(env("QSEOW_PROXY_PORT", "443")),
    authMode,
    vpPrefix: env("QSEOW_VP_PREFIX", "jwt")!,
    jwt,
    cert,
    certUser: {
      directory: env("QSEOW_CERT_USER_DIRECTORY", "INTERNAL")!,
      id: env("QSEOW_CERT_USER_ID", "sa_repository")!,
    },
    tlsVerify: env("QSEOW_TLS_VERIFY", "true") !== "false",
    toolGroups: new Set(groups),
    allowMutations: env("QSEOW_ALLOW_MUTATIONS", "false") === "true",
  };
}
