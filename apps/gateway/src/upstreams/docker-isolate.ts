import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UpstreamIsolationNetwork } from "@yusetu/shared";
import { getLogger } from "../logger.js";

export type DockerIsolateConfig = {
  nodeImage: string;
  uvImage: string;
  dockerBin: string;
};

export function dockerIsolateConfigFromEnv(): DockerIsolateConfig {
  return {
    nodeImage:
      process.env.DOCKER_ISOLATION_NODE_IMAGE?.trim() ||
      "node:22-bookworm-slim",
    uvImage:
      process.env.DOCKER_ISOLATION_UV_IMAGE?.trim() ||
      "ghcr.io/astral-sh/uv:python3.12-bookworm-slim",
    dockerBin: process.env.DOCKER_BIN?.trim() || "docker",
  };
}

let dockerAvailableCache: boolean | null = null;

/** Quick check that docker CLI can talk to a daemon. Cached for process life. */
export async function isDockerAvailable(
  dockerBin = "docker",
): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  dockerAvailableCache = await new Promise<boolean>((resolve) => {
    const child = spawn(dockerBin, ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 4_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  return dockerAvailableCache;
}

/** Reset cache (tests). */
export function resetDockerAvailabilityCache(): void {
  dockerAvailableCache = null;
}

export function resolveIsolationImage(
  command: string,
  override: string | null | undefined,
  cfg: DockerIsolateConfig,
): string {
  const o = override?.trim();
  if (o) return o;
  const cmd = path.basename(command.trim());
  if (cmd === "uv" || cmd === "uvx" || cmd === "python" || cmd === "python3") {
    return cfg.uvImage;
  }
  return cfg.nodeImage;
}

function hostUidGid(): { uid: number; gid: number } {
  return { uid: typeof process.getuid === "function" ? process.getuid() : 1000, gid: typeof process.getgid === "function" ? process.getgid() : 1000 };
}

export type DockerStdioLaunch = {
  command: string;
  args: string[];
};

/**
 * Build `docker run` argv so the child speaks MCP on stdio.
 * Mounts only the checkout dir; passes only provided env (secrets).
 * Default network is none (no egress).
 */
export function buildDockerStdioLaunch(input: {
  slug: string;
  checkoutAbs: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  network: UpstreamIsolationNetwork;
  image: string;
  dockerBin?: string;
  /** Allow writes under checkout (needed for most MCP servers). */
  readOnlyRoot?: boolean;
}): DockerStdioLaunch {
  const dockerBin = input.dockerBin ?? "docker";
  const checkout = path.resolve(input.checkoutAbs);
  if (!fs.existsSync(checkout)) {
    throw new Error(`Docker isolation checkout missing: ${checkout}`);
  }

  const { uid, gid } = hostUidGid();
  const network = input.network === "bridge" ? "bridge" : "none";
  const readOnly = input.readOnlyRoot !== false;

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    `--network=${network}`,
    `--user=${uid}:${gid}`,
    "--workdir=/mcp",
    "--mount",
    `type=bind,source=${checkout},target=/mcp`,
    "--tmpfs",
    "/tmp:rw,exec,mode=1777,size=268435456",
    "--tmpfs",
    "/home/mcp:rw,mode=1777,size=67108864",
    "-e",
    "HOME=/home/mcp",
    "-e",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",
    "-e",
    "UV_CACHE_DIR=/tmp/uv-cache",
    "-e",
    "XDG_CACHE_HOME=/tmp/cache",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=512m",
  ];

  if (readOnly) {
    args.push("--read-only");
  }

  // Only explicit env — do not forward gateway process env / secrets of others.
  for (const [k, v] of Object.entries(input.env)) {
    if (!k || v === undefined) continue;
    args.push("-e", `${k}=${v}`);
  }

  args.push(input.image, input.command, ...input.args);

  getLogger("data", { slug: input.slug }).info(
    {
      image: input.image,
      network,
      checkout,
      innerCommand: input.command,
      envKeys: Object.keys(input.env).sort(),
    },
    "docker isolation: stdio launch",
  );

  return { command: dockerBin, args };
}

/**
 * Run installCommand inside Docker (needs bridge network for package downloads).
 */
export async function runInstallInDocker(input: {
  slug: string;
  checkoutAbs: string;
  installCommand: string;
  image: string;
  dockerBin?: string;
  timeoutMs?: number;
}): Promise<void> {
  const dockerBin = input.dockerBin ?? "docker";
  const checkout = path.resolve(input.checkoutAbs);
  const parts = input.installCommand.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return;

  const { uid, gid } = hostUidGid();
  const args = [
    "run",
    "--rm",
    "--network=bridge",
    `--user=${uid}:${gid}`,
    "--workdir=/mcp",
    "--mount",
    `type=bind,source=${checkout},target=/mcp`,
    "--tmpfs",
    "/tmp:rw,exec,mode=1777,size=536870912",
    "--tmpfs",
    "/home/mcp:rw,mode=1777,size=134217728",
    "-e",
    "HOME=/home/mcp",
    "-e",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",
    "-e",
    "UV_CACHE_DIR=/tmp/uv-cache",
    "-e",
    "UV_PYTHON_PREFERENCE=only-managed",
    "-e",
    "XDG_CACHE_HOME=/tmp/cache",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--memory=1g",
    input.image,
    ...parts,
  ];

  getLogger("data", { slug: input.slug }).warn(
    { image: input.image, install: parts },
    "docker isolation: running installCommand in container",
  );

  await spawnDockerCaptured(dockerBin, args, input.timeoutMs ?? 10 * 60 * 1000);
}

function spawnDockerCaptured(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const child = spawn(command, args, {
      cwd: os.tmpdir(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      if (signal.aborted) {
        reject(new Error(`docker install timed out after ${timeoutMs}ms`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (signal.aborted) {
        reject(new Error(`docker install timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-2000);
        reject(
          new Error(
            `docker install failed (exit ${code})${detail ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
