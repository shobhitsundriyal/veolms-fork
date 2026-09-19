/**
 * Shared configuration for the local Floci AWS emulator.
 *
 * An endpoint is deliberately treated as a local emulator target throughout
 * this package.  Keeping this decision in one place prevents one SDK client
 * or AWS CLI fallback from accidentally using the caller's real AWS profile.
 */

export const DEFAULT_FLOCI_ENDPOINT = "http://localhost:4566";
export const DEFAULT_FLOCI_HOST_DATABASE_URL =
  "postgresql://veolms:veolms@localhost:5433/veolms";
export const DEFAULT_FLOCI_DATABASE_URL =
  "postgresql://veolms:veolms@postgres:5432/veolms";
export const FLOCI_DEFAULT_ACCOUNT_ID = "000000000000";
// Debian 12 is a documented Floci EC2 image and has a complete apt/bash base.
// It avoids the curl-minimal/dnf lock conflict in Floci's best-effort IMDS
// installer while keeping the real AWS AMI path independent of this default.
export const FLOCI_DEFAULT_AMI_ID = "ami-debian12";

const LOCAL_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "db",
  "host.docker.internal",
]);

export interface FlociEnvironment {
  readonly FLOCI_ENDPOINT?: string;
  readonly FLOCI_DATABASE_URL?: string;
  readonly AWS_ENDPOINT_URL?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly S3_ACCESS_KEY_ID?: string;
  readonly S3_SECRET_ACCESS_KEY?: string;
}

export function resolveFlociEndpoint(
  env:
    | FlociEnvironment
    | Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicitEndpoint = env.FLOCI_ENDPOINT?.trim();
  if (explicitEndpoint) return explicitEndpoint;

  // Keep an existing AWS_ENDPOINT_URL local-emulator workflow compatible,
  // while refusing to reinterpret an arbitrary production AWS endpoint as a
  // Floci target (which would replace real credentials with test credentials).
  const legacyEndpoint = env.AWS_ENDPOINT_URL?.trim();
  if (!legacyEndpoint) return undefined;
  try {
    const hostname = new URL(legacyEndpoint).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "floci"].includes(hostname)
      ? legacyEndpoint
      : undefined;
  } catch {
    return undefined;
  }
}

export function isFlociConfigured(
  env:
    | FlociEnvironment
    | Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(resolveFlociEndpoint(env));
}

/**
 * Returns true for database URLs that only resolve from the local machine or
 * the optional local PostgreSQL Compose service. A hosted URL (for example a
 * Neon URL from the root .env) can be reused by Floci's Lambda/EC2 containers.
 */
export function isLocalDatabaseUrl(databaseUrl?: string): boolean {
  const value = databaseUrl?.trim();
  if (!value) return true;

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return LOCAL_DATABASE_HOSTS.has(hostname);
  } catch {
    // An invalid URL will be rejected by the database client later. Treat it
    // as local here so setup never silently sends a malformed value to a
    // spawned Floci container as though it were a hosted connection string.
    return true;
  }
}

/**
 * Selects the database URL visible inside Floci-created containers.
 * Explicit FLOCI_DATABASE_URL always wins; otherwise a hosted fleet-manager
 * DATABASE_URL is shared with the containers. The local Compose URL remains
 * the fallback for users who intentionally run PostgreSQL locally.
 */
export function resolveFlociContainerDatabaseUrl(
  databaseUrl?: string,
  explicitContainerDatabaseUrl?: string,
): string {
  const explicit = explicitContainerDatabaseUrl?.trim();
  if (explicit) return explicit;

  const fleetDatabaseUrl = databaseUrl?.trim();
  if (fleetDatabaseUrl && !isLocalDatabaseUrl(fleetDatabaseUrl)) {
    return fleetDatabaseUrl;
  }

  return DEFAULT_FLOCI_DATABASE_URL;
}

interface AwsServiceClientOptions {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

/** Options for IAM, EC2, Lambda, SSM, Scheduler, Logs, STS, and similar clients. */
export function awsServiceClientOptions(
  region: string,
  env:
    | FlociEnvironment
    | Readonly<Record<string, string | undefined>> = process.env,
): AwsServiceClientOptions {
  const endpoint = resolveFlociEndpoint(env);
  if (!endpoint) return { region };

  return {
    region,
    endpoint,
    // Floci accepts these deterministic test credentials. Supplying them
    // explicitly also prevents the AWS SDK from walking the real profile or
    // instance-metadata credential chain while the endpoint is local.
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID?.trim() || "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY?.trim() || "test",
    },
  };
}

/** Options for S3, including the path-style addressing Floci expects. */
export function awsS3ClientOptions(
  region: string,
  env:
    | FlociEnvironment
    | Readonly<Record<string, string | undefined>> = process.env,
): AwsServiceClientOptions & { readonly forcePathStyle?: boolean } {
  const endpoint = resolveFlociEndpoint(env);
  if (!endpoint) return { region };

  return {
    ...awsServiceClientOptions(region, env),
    credentials: {
      accessKeyId:
        env.S3_ACCESS_KEY_ID?.trim() || env.AWS_ACCESS_KEY_ID?.trim() || "test",
      secretAccessKey:
        env.S3_SECRET_ACCESS_KEY?.trim() ||
        env.AWS_SECRET_ACCESS_KEY?.trim() ||
        "test",
    },
    forcePathStyle: true,
  };
}

export function awsCliEndpointArgs(
  endpoint = resolveFlociEndpoint(),
): string[] {
  return endpoint ? ["--endpoint-url", endpoint] : [];
}
