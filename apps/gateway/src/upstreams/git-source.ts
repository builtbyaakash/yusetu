import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getLogger } from "../logger.js";
import { assertSafeUpstreamUrl } from "../secrets/ssrf.js";

const DEFAULT_GIT_REF = "main";
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Full SHA-1 (40) or SHA-256 (64) commit ids. */
function isFullCommitSha(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref);
}

/**
 * Absolute path for a managed MCP git checkout:
 * `{dataDir}/mcp-sources/{userId}/{slug}/`
 */
export function mcpSourceDir(
  dataDir: string,
  userId: string,
  slug: string,
): string {
  return path.resolve(dataDir, "mcp-sources", userId, slug);
}

/**
 * Validate a git clone URL: http(s) only, no embedded credentials,
 * SSRF-safe (blocks localhost / private IPs / metadata).
 */
export async function assertSafeGitUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid gitUrl: must be a valid http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "gitUrl must be an http or https URL (ssh:// and git@ remotes are not supported)",
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "gitUrl must not include credentials; do not embed tokens in the clone URL",
    );
  }

  // Reuse SSRF helpers — never allow private/loopback for remote git clones.
  await assertSafeUpstreamUrl(rawUrl, { allowLocalhost: false });
}

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function spawnCaptured(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      if (signal.aborted) {
        reject(
          new Error(
            `${command} timed out after ${Math.round(options.timeoutMs / 1000)}s`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (signal.aborted) {
        reject(
          new Error(
            `${command} timed out after ${Math.round(options.timeoutMs / 1000)}s`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function runGit(
  args: string[],
  options: { cwd?: string; timeoutMs?: number },
): Promise<string> {
  const result = await spawnCaptured("git", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? CLONE_TIMEOUT_MS,
    env: process.env,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new Error(`git ${args[0] ?? ""} failed: ${detail}`);
  }
  return result.stdout;
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

export type EnsureGitCheckoutParams = {
  dataDir: string;
  userId: string;
  slug: string;
  gitUrl: string;
  gitRef?: string | null;
  installCommand?: string | null;
};

/**
 * Ensure `{dataDir}/mcp-sources/{userId}/{slug}` is a checkout of `gitUrl` at `gitRef`.
 * Fresh clone is shallow (`--depth 1`). Existing dirs: fetch + hard reset to ref.
 * Returns the absolute checkout path.
 */
export async function ensureGitCheckout(
  params: EnsureGitCheckoutParams,
): Promise<string> {
  const { dataDir, userId, slug, gitUrl } = params;
  const ref = (params.gitRef?.trim() || DEFAULT_GIT_REF);
  const dir = mcpSourceDir(dataDir, userId, slug);
  const installCommand = params.installCommand?.trim() ?? "";
  const log = getLogger("control");

  await assertSafeGitUrl(gitUrl);

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  log.warn(
    { slug, gitUrl, gitRef: ref, checkout: dir },
    "git MCP source: cloning/updating local checkout — this runs untrusted repository code on the gateway host",
  );

  if (!fs.existsSync(dir)) {
    if (isFullCommitSha(ref)) {
      await runGit(["clone", "--depth", "1", gitUrl, dir], {});
      await runGit(["fetch", "--depth", "1", "origin", ref], { cwd: dir });
      await runGit(["checkout", "--force", ref], { cwd: dir });
    } else {
      await runGit(
        ["clone", "--depth", "1", "--branch", ref, gitUrl, dir],
        {},
      );
    }
    if (installCommand) {
      await runInstallCommand(dir, installCommand);
    }
    return dir;
  }

  if (!isGitRepo(dir)) {
    throw new Error(
      `MCP source directory exists but is not a git repository: ${dir}`,
    );
  }

  // Update existing checkout to the requested ref (v1: always sync).
  await runGit(["fetch", "--depth", "1", "origin", ref], { cwd: dir });
  await runGit(["checkout", "--force", "FETCH_HEAD"], { cwd: dir });
  await runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: dir });

  return dir;
}

/**
 * Parse `installCommand` on whitespace and spawn argv with `shell: false`.
 * Inherits PATH from the gateway process. Non-zero exit throws with stderr.
 * For `uv …` installs: prefer managed CPython (avoids x86_64 wheels on Apple
 * Silicon) and create `.venv` first when missing.
 */
export async function runInstallCommand(
  cwd: string,
  installCommand: string,
): Promise<void> {
  const trimmed = installCommand.trim();
  if (!trimmed) return;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command) return;
  const args = parts.slice(1);

  const log = getLogger("control");
  const env =
    command === "uv"
      ? {
          ...process.env,
          // Prefer uv-managed interpreters so native wheels match host arch.
          UV_PYTHON_PREFERENCE: process.env.UV_PYTHON_PREFERENCE ?? "only-managed",
        }
      : process.env;

  if (command === "uv") {
    const venvPath = path.join(cwd, ".venv");
    if (!fs.existsSync(venvPath)) {
      log.info({ cwd }, "git MCP source: creating uv virtualenv (.venv)");
      const venvResult = await spawnCaptured("uv", ["venv"], {
        cwd,
        timeoutMs: INSTALL_TIMEOUT_MS,
        env,
      });
      if (venvResult.code !== 0) {
        const detail =
          (venvResult.stderr || venvResult.stdout).trim() ||
          `exit code ${venvResult.code}`;
        throw new Error(`installCommand failed (uv venv): ${detail}`);
      }
    }
  }

  log.warn(
    { cwd, command, args },
    "git MCP source: running installCommand — this executes local code from the checkout",
  );

  const result = await spawnCaptured(command, args, {
    cwd,
    timeoutMs: INSTALL_TIMEOUT_MS,
    env,
  });

  if (result.code !== 0) {
    const detail =
      (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
    throw new Error(`installCommand failed (${command}): ${detail}`);
  }
}

/**
 * Best-effort removal of a managed MCP source checkout. Errors are logged, not thrown.
 */
export async function removeMcpSourceDir(
  dataDir: string,
  userId: string,
  slug: string,
): Promise<void> {
  const dir = mcpSourceDir(dataDir, userId, slug);
  const log = getLogger("control");
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    log.info({ slug, checkout: dir }, "removed MCP git source directory");
  } catch (err) {
    log.warn(
      {
        slug,
        checkout: dir,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to remove MCP git source directory",
    );
  }
}
