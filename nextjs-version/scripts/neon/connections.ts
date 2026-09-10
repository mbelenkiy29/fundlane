import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type NeonTarget = "verification" | "production";

interface ProtectedConnections {
  production: string;
  verification: string;
  projectId: string;
  productionBranch: string;
  verificationBranch: string;
}

const connectionFile = resolve(process.cwd(), ".neon/migration-connections.json");

export function protectedConnections(): ProtectedConnections {
  const mode = statSync(connectionFile).mode & 0o777;
  if (mode & 0o077) throw new Error(".neon/migration-connections.json must not be accessible by group or other users.");
  const parsed = JSON.parse(readFileSync(connectionFile, "utf8")) as Partial<ProtectedConnections>;
  for (const key of ["production", "verification", "projectId", "productionBranch", "verificationBranch"] as const) {
    if (!parsed[key]) throw new Error(`Protected Neon connection metadata is missing ${key}.`);
  }
  return parsed as ProtectedConnections;
}

export function directUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace("-pooler.", ".");
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

export function pooledUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.hostname.includes("-pooler.")) {
    const firstDot = parsed.hostname.indexOf(".");
    if (firstDot < 0) throw new Error("Unexpected Neon hostname.");
    parsed.hostname = `${parsed.hostname.slice(0, firstDot)}-pooler${parsed.hostname.slice(firstDot)}`;
  }
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

export function targetUrl(target: NeonTarget, direct: boolean): string {
  const environment = direct ? process.env.DATABASE_URL_UNPOOLED : process.env.DATABASE_URL;
  if (environment) return direct ? directUrl(environment) : pooledUrl(environment);
  const protectedValues = protectedConnections();
  return direct ? directUrl(protectedValues[target]) : pooledUrl(protectedValues[target]);
}

export function targetFromArgs(defaultTarget: NeonTarget = "verification"): NeonTarget {
  const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
    ?? process.env.MCA_NEON_TARGET
    ?? defaultTarget;
  if (requested !== "verification" && requested !== "production") {
    throw new Error("Neon target must be verification or production.");
  }
  return requested;
}

export function urlForDatabase(url: string, database: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error("Unsafe Postgres database identifier.");
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

