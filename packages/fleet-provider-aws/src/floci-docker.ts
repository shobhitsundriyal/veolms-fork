import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainModule } from "@veolms/fleet-types";
import { resolveRepoRoot } from "@veolms/fleet-types/env";
import {
  bold,
  cyan,
  green,
  info,
  ok,
  warn,
} from "@veolms/fleet-types/terminal";
import { DEFAULT_FLOCI_ENDPOINT } from "./floci.ts";

const FLOCI_COMPOSE_FILE = "compose.floci.yaml";
const FLEET_COMPOSE_FILE = "compose.fleet.yaml";
const BASE_COMPOSE_FILE = "compose.yaml";
const FLOCI_NETWORK = "veolms-fleet";

export interface EnsureFlociDockerOptions {
  readonly endpoint?: string;
  readonly repoRoot?: string;
  readonly waitMs?: number;
}

export interface EnsureFlociDockerResult {
  readonly endpoint: string;
  readonly started: boolean;
}

export interface FlociDockerCleanupResult {
  readonly removedContainers: readonly string[];
  readonly removedImages: readonly string[];
  readonly removedNetworks: readonly string[];
}

function localEndpointPort(endpoint: string): string | undefined {
  try {
    const parsed = new URL(endpoint);
    const hostname = parsed.hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      return undefined;
    }
    return parsed.port || "4566";
  } catch {
    return undefined;
  }
}

function composeEnvArgs(repoRoot: string): string[] {
  const rootEnvPath = path.join(repoRoot, ".env");
  return fs.existsSync(rootEnvPath) ? ["--env-file", rootEnvPath] : [];
}

function composeFilePath(repoRoot: string, fileName: string): string {
  const filePath = path.join(repoRoot, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected Docker Compose file was not found: ${filePath}`);
  }
  return filePath;
}

function runDocker(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly inheritOutput?: boolean;
  } = {},
): string {
  const output = execFileSync("docker", [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return output ? String(output).trim() : "";
}

async function waitForFloci(endpoint: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      // A 404 from the root path still proves that the Floci HTTP server is
      // ready. Only retry server-side failures while the service is booting.
      if (response.status < 500) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Floci did not become ready at ${endpoint} within ${waitMs}ms (${lastError}).`,
  );
}

/**
 * Starts the local Floci control plane as part of AWS-provider infra setup.
 * This intentionally uses compose.floci.yaml alone: PostgreSQL is never
 * started here because DATABASE_URL may point at the hosted database from the
 * root .env file.
 */
export async function ensureFlociDocker(
  options: EnsureFlociDockerOptions = {},
): Promise<EnsureFlociDockerResult> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const endpoint = (options.endpoint ?? DEFAULT_FLOCI_ENDPOINT).replace(
    /\/$/,
    "",
  );
  const port = localEndpointPort(endpoint);

  if (!port) {
    info(
      `Using external Floci endpoint ${bold(endpoint)}; local Docker startup is not required.`,
    );
    return { endpoint, started: false };
  }

  const composeFile = composeFilePath(repoRoot, FLOCI_COMPOSE_FILE);
  info(
    `Starting Floci at ${bold(endpoint)} from ${cyan("fleet:infra")} (PostgreSQL is not started).`,
  );

  runDocker(
    [
      "compose",
      ...composeEnvArgs(repoRoot),
      "-f",
      composeFile,
      "up",
      "-d",
      "floci",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        FLOCI_PORT: port,
      },
      inheritOutput: true,
    },
  );

  await waitForFloci(endpoint, options.waitMs ?? 30_000);
  ok(`Floci is ready at ${bold(endpoint)}.`);
  return { endpoint, started: true };
}

function splitDockerLines(output: string): string[][] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function tryRunDocker(args: readonly string[], cwd: string): string | null {
  try {
    return runDocker(args, { cwd });
  } catch {
    return null;
  }
}

/**
 * Removes local Floci/PostgreSQL/fleet containers and images so the next
 * `pnpm run fleet:infra` starts from clean Docker resources. Bind-mounted
 * `.data/floci` and the named PostgreSQL volume are deliberately preserved.
 */
export function cleanFlociDocker(
  repoRoot = resolveRepoRoot(),
): FlociDockerCleanupResult {
  const removedContainers: string[] = [];
  const removedImages: string[] = [];
  const removedNetworks: string[] = [];

  console.log(`\n${bold(cyan("Cleaning local Floci Docker resources"))}`);

  for (const composeArgs of [
    [
      "compose",
      ...composeEnvArgs(repoRoot),
      "-f",
      composeFilePath(repoRoot, BASE_COMPOSE_FILE),
      "-f",
      composeFilePath(repoRoot, FLOCI_COMPOSE_FILE),
      "down",
      "--remove-orphans",
      "--rmi",
      "all",
    ],
    [
      "compose",
      ...composeEnvArgs(repoRoot),
      "-f",
      composeFilePath(repoRoot, FLEET_COMPOSE_FILE),
      "--profile",
      "serverful",
      "down",
      "--remove-orphans",
      "--rmi",
      "all",
    ],
  ] as const) {
    tryRunDocker(composeArgs, repoRoot);
  }

  const containerOutput = tryRunDocker(
    ["ps", "-a", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"],
    repoRoot,
  );
  const containerTargets = new Set<string>();
  const containerImageTargets = new Set<string>();
  if (containerOutput) {
    for (const [id, image = "", name = ""] of splitDockerLines(
      containerOutput,
    )) {
      const normalizedImage = image.toLowerCase();
      const normalizedName = name.toLowerCase();
      if (
        normalizedName.includes("floci") ||
        normalizedName.startsWith("veolms-postgres") ||
        normalizedImage.startsWith("floci/") ||
        normalizedImage === "floci" ||
        (normalizedName.startsWith("veolms-") &&
          normalizedImage.startsWith("postgres:"))
      ) {
        if (id) {
          containerTargets.add(id);
          if (image) containerImageTargets.add(image);
        }
      }
    }
  }

  const managedWorkerOutput = tryRunDocker(
    [
      "ps",
      "-a",
      "--filter",
      "label=veolms.managed=true",
      "--format",
      "{{.ID}}\t{{.Image}}",
    ],
    repoRoot,
  );
  for (const [id, image = ""] of splitDockerLines(
    managedWorkerOutput ?? "",
  )) {
    if (id) {
      containerTargets.add(id);
      if (image) containerImageTargets.add(image);
    }
  }

  for (const id of containerTargets) {
    try {
      runDocker(["rm", "-f", id], { cwd: repoRoot, inheritOutput: true });
      removedContainers.push(id);
    } catch {
      warn(`Could not remove Docker container ${id}.`);
    }
  }

  const imageOutput = tryRunDocker(
    ["image", "ls", "--format", "{{.ID}}\t{{.Repository}}\t{{.Tag}}"],
    repoRoot,
  );
  const imageTargets = new Set<string>();
  if (imageOutput) {
    for (const [id, repository = "", tag = ""] of splitDockerLines(
      imageOutput,
    )) {
      const normalizedRepository = repository.toLowerCase();
      const isFlociImage =
        normalizedRepository === "floci" ||
        normalizedRepository.startsWith("floci/");
      const isPostgresImage =
        normalizedRepository === "postgres" && tag === "18-alpine";
      const isLocalFleetImage = [
        "veolms-media-worker",
        "veolms-fleet-manager",
        "veolms-ffprobe-layer",
      ].includes(normalizedRepository);
      const isBackedByRemovedContainer = id
        ? containerImageTargets.has(id) ||
          containerImageTargets.has(repository) ||
          containerImageTargets.has(`${repository}:${tag}`)
        : false;
      if (
        id &&
        (isFlociImage ||
          isPostgresImage ||
          isLocalFleetImage ||
          isBackedByRemovedContainer)
      ) {
        imageTargets.add(id);
      }
    }
  }

  for (const id of imageTargets) {
    try {
      runDocker(["image", "rm", "-f", id], {
        cwd: repoRoot,
        inheritOutput: true,
      });
      removedImages.push(id);
    } catch {
      warn(`Could not remove Docker image ${id}.`);
    }
  }

  try {
    runDocker(["network", "rm", FLOCI_NETWORK], {
      cwd: repoRoot,
      inheritOutput: true,
    });
    removedNetworks.push(FLOCI_NETWORK);
  } catch {
    // The network may be absent or still used by an unrelated local service.
  }

  ok(
    `Removed ${removedContainers.length} container(s), ${removedImages.length} image(s), and ${removedNetworks.length} network(s).`,
  );
  info("Preserved .data/floci and the PostgreSQL volume; no data was deleted.");

  return { removedContainers, removedImages, removedNetworks };
}

if (isMainModule(import.meta.url)) {
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (command === "clean") {
    cleanFlociDocker();
  } else {
    ensureFlociDocker().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n✘ Floci Docker setup failed: ${message}\n`);
      process.exit(1);
    });
  }
}
