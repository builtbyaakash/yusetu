import { useState } from "react";
import { slugifyUpstreamName } from "@yusetu/shared";
import type {
  CreateUpstream,
  UpdateUpstream,
  Upstream,
  UpstreamAuthMode,
  UpstreamIsolation,
  UpstreamIsolationNetwork,
  UpstreamTransport,
} from "../api/types";
import { SecretFields, secretsToRecord, secretsToRemove, type SecretPair } from "./SecretFields";

type UpstreamFormProps = {
  initial?: Upstream;
  submitting?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onSubmit: (body: CreateUpstream | UpdateUpstream) => void;
  onCancel: () => void;
};

/** UI source modes: stdio (manual), HTTP (auto-detect), or GitHub/git checkout. */
type SourceMode = "stdio" | "http" | "github";

function parseArgs(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/);
}

function initialSourceMode(initial?: Upstream): SourceMode {
  if (initial?.gitUrl) return "github";
  if (
    initial?.transport === "sse" ||
    initial?.transport === "streamable-http"
  ) {
    return "http";
  }
  return "stdio";
}

export function UpstreamForm({
  initial,
  submitting,
  error,
  readOnly = false,
  onSubmit,
  onCancel,
}: UpstreamFormProps) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [sourceMode, setSourceMode] = useState<SourceMode>(() =>
    initialSourceMode(initial),
  );
  const [transport, setTransport] = useState<UpstreamTransport>(
    initial?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(
    (initial?.argsJson ?? []).join(" "),
  );
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [gitUrl, setGitUrl] = useState(initial?.gitUrl ?? "");
  const [gitRef, setGitRef] = useState(initial?.gitRef ?? "main");
  const [installCommand, setInstallCommand] = useState(
    initial?.installCommand ?? "",
  );
  const [isolation, setIsolation] = useState<UpstreamIsolation>(
    initial?.isolation ?? "docker",
  );
  const [isolationNetwork, setIsolationNetwork] =
    useState<UpstreamIsolationNetwork>(initial?.isolationNetwork ?? "none");
  const [isolationImage, setIsolationImage] = useState(
    initial?.isolationImage ?? "",
  );
  const [url, setUrl] = useState(initial?.url ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [timeoutMs, setTimeoutMs] = useState(
    String(initial?.timeoutMs ?? 30_000),
  );
  const [authMode, setAuthMode] = useState<UpstreamAuthMode>(
    initial?.authMode ?? "none",
  );
  const [secrets, setSecrets] = useState<SecretPair[]>(() =>
    (initial?.secretKeys ?? []).map((key) => ({
      key,
      value: "",
      stored: true,
    })),
  );

  const needsUrl = sourceMode === "http";
  const isGithub = sourceMode === "github";
  const useOauth = needsUrl && authMode === "oauth";
  const slugPreview = slugifyUpstreamName(name);

  function setSource(mode: SourceMode) {
    setSourceMode(mode);
    if (mode === "stdio" || mode === "github") {
      setTransport("stdio");
    } else {
      // Placeholder; gateway overwrites with streamable-http | sse from URL.
      setTransport("streamable-http");
    }
    if (mode === "github" && !isEdit) {
      setIsolation("docker");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    const secretsRecord = !useOauth ? secretsToRecord(secrets) : undefined;
    const removeSecrets =
      isEdit && !useOauth
        ? secretsToRemove(initial?.secretKeys, secrets)
        : undefined;
    const base = {
      name: name.trim(),
      transport,
      enabled,
      timeoutMs: Number(timeoutMs) || 30_000,
      ...(secretsRecord ? { secrets: secretsRecord } : {}),
      ...(removeSecrets ? { removeSecrets } : {}),
      ...(needsUrl ? { authMode } : {}),
    };

    if (needsUrl) {
      onSubmit({
        ...base,
        url: url.trim(),
        command: undefined,
        argsJson: undefined,
        cwd: undefined,
      });
      return;
    }

    if (isGithub) {
      onSubmit({
        ...base,
        transport: "stdio",
        gitUrl: gitUrl.trim(),
        gitRef: gitRef.trim() || "main",
        installCommand: installCommand.trim() || undefined,
        command: command.trim(),
        argsJson: parseArgs(argsText),
        isolation,
        isolationNetwork: isolation === "docker" ? isolationNetwork : "none",
        isolationImage:
          isolation === "docker" ? isolationImage.trim() : undefined,
        url: undefined,
      });
      return;
    }

    onSubmit({
      ...base,
      command: command.trim(),
      argsJson: parseArgs(argsText),
      cwd: cwd.trim() || undefined,
      isolation: "host",
      url: undefined,
    });
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {readOnly ? (
        <div className="alert alert-info">
          Shared team MCP — definition is read-only. Connect OAuth or use
          credentials when your admin enables overlays.
        </div>
      ) : null}

      <fieldset disabled={readOnly} className="bare-fieldset">
      <div className="field">
        <label htmlFor="upstream-name">Name</label>
        <input
          id="upstream-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        {!isEdit ? (
          <span className="hint">Slug will be: {slugPreview}</span>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="upstream-transport">Transport</label>
        <select
          id="upstream-transport"
          className="select"
          value={sourceMode}
          onChange={(e) => setSource(e.target.value as SourceMode)}
        >
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
          <option value="github">GitHub</option>
        </select>
      </div>

      {needsUrl ? (
        <div className="field">
          <label htmlFor="upstream-url">URL</label>
          <input
            id="upstream-url"
            className="input mono"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
          />
          <span className="hint">
            Transport (streamable-http or SSE) is detected from the URL.
          </span>
        </div>
      ) : isGithub ? (
        <>
          <div className="alert alert-info">
            Clones the repo on the gateway, then runs install/runtime in a slim
            Docker container by default (no host process for untrusted code).
            Prefer network <code>none</code> unless the MCP needs egress.
          </div>
          <div className="field">
            <label htmlFor="upstream-git-url">Git URL</label>
            <input
              id="upstream-git-url"
              className="input mono"
              type="url"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/org/mcp-server.git"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="upstream-git-ref">Ref / branch</label>
            <input
              id="upstream-git-ref"
              className="input mono"
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
            />
            <span className="hint">Defaults to main if left blank.</span>
          </div>
          <div className="field">
            <label htmlFor="upstream-install-command">Install command</label>
            <input
              id="upstream-install-command"
              className="input mono"
              value={installCommand}
              onChange={(e) => setInstallCommand(e.target.value)}
              placeholder="npm install or uv sync"
            />
            <span className="hint">
              Optional — run once after clone (in Docker when isolation is
              docker). Prefer <code>uv sync</code> when the repo has a lockfile.
            </span>
          </div>
          <div className="field">
            <label htmlFor="upstream-command">Run command</label>
            <input
              id="upstream-command"
              className="input mono"
              list="upstream-github-command-presets"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="uv"
              required
            />
            <datalist id="upstream-github-command-presets">
              <option value="uv" />
              <option value="node" />
              <option value="npx" />
            </datalist>
            <span className="hint">
              Use the checkout cwd — for Python/uv prefer{" "}
              <code>uv</code> + args <code>run beszel-mcp</code> (not uvx).
            </span>
          </div>
          <div className="field">
            <label htmlFor="upstream-args">Args</label>
            <input
              id="upstream-args"
              className="input mono"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="run beszel-mcp"
            />
            <span className="hint">
              Space-separated — e.g. run package-script or path/to/server.js
            </span>
          </div>
          <div className="field">
            <label htmlFor="upstream-isolation">Isolation</label>
            <select
              id="upstream-isolation"
              className="select"
              value={isolation}
              onChange={(e) =>
                setIsolation(e.target.value as UpstreamIsolation)
              }
            >
              <option value="docker">Docker (recommended)</option>
              <option value="host">Host (trusted only)</option>
            </select>
            <span className="hint">
              Docker uses slim images + dropped caps; network{" "}
              <code>none</code> is the lightweight strong default (no egress).
            </span>
          </div>
          {isolation === "docker" ? (
            <>
              <div className="field">
                <label htmlFor="upstream-isolation-network">
                  Container network
                </label>
                <select
                  id="upstream-isolation-network"
                  className="select"
                  value={isolationNetwork}
                  onChange={(e) =>
                    setIsolationNetwork(
                      e.target.value as UpstreamIsolationNetwork,
                    )
                  }
                >
                  <option value="none">none — no egress (lightweight)</option>
                  <option value="bridge">bridge — allow egress</option>
                </select>
                <span className="hint">
                  Install always uses bridge briefly. Runtime defaults to none;
                  switch to bridge only if the MCP must call the network.
                </span>
              </div>
              <div className="field">
                <label htmlFor="upstream-isolation-image">
                  Docker image override
                </label>
                <input
                  id="upstream-isolation-image"
                  className="input mono"
                  value={isolationImage}
                  onChange={(e) => setIsolationImage(e.target.value)}
                  placeholder="Leave blank to auto-pick node or uv slim"
                />
              </div>
            </>
          ) : (
            <div className="alert alert-error">
              Host isolation runs third-party install/runtime on the gateway
              process — only for repos you fully trust.
            </div>
          )}
          <p className="hint">
            Working directory is managed from the git checkout.
          </p>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="upstream-command">Command</label>
            <input
              id="upstream-command"
              className="input mono"
              list="upstream-command-presets"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx or uvx"
              required
            />
            <datalist id="upstream-command-presets">
              <option value="npx" />
              <option value="uvx" />
              <option value="node" />
              <option value="docker" />
            </datalist>
            <span className="hint">
              Any executable on the gateway PATH — npx (Node), uvx (Python/uv),
              node, docker, …
            </span>
          </div>
          <div className="field">
            <label htmlFor="upstream-args">Args</label>
            <input
              id="upstream-args"
              className="input mono"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={
                command.trim() === "uvx"
                  ? "mcp-server-git --repository /path"
                  : command.trim() === "npx"
                    ? "-y @modelcontextprotocol/server-filesystem /tmp"
                    : "space-separated arguments"
              }
            />
            <span className="hint">
              Space-separated arguments
              {command.trim() === "uvx"
                ? " — e.g. uvx mcp-server-fetch"
                : command.trim() === "npx"
                  ? " — e.g. npx -y @scope/package"
                  : ""}
            </span>
          </div>
          <div className="field">
            <label htmlFor="upstream-cwd">Working directory</label>
            <input
              id="upstream-cwd"
              className="input mono"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/optional/cwd"
            />
          </div>
        </>
      )}

      {needsUrl ? (
        <fieldset className="field bare-fieldset">
          <legend className="choice-legend">Auth method</legend>
          <div className="choice-list">
            <label className="choice-row">
              <input
                type="radio"
                name="authMode"
                checked={authMode === "none"}
                onChange={() => setAuthMode("none")}
              />
              <span>
                <strong>Static secrets / headers</strong>
                <span className="hint">
                  API keys or custom headers stored as encrypted secrets
                </span>
              </span>
            </label>
            <label className="choice-row">
              <input
                type="radio"
                name="authMode"
                checked={authMode === "oauth"}
                onChange={() => setAuthMode("oauth")}
              />
              <span>
                <strong>OAuth</strong>
                <span className="hint">
                  Recommended for Linear and other OAuth MCP servers
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}

      <div className="field">
        <label htmlFor="upstream-timeout">Timeout (ms)</label>
        <input
          id="upstream-timeout"
          className="input"
          type="number"
          min={1}
          max={600000}
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Enabled</label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          MCP is enabled
        </label>
      </div>

      {useOauth ? (
        <p className="hint">
          OAuth credentials are managed separately. After saving, use Connect
          OAuth on the MCP list. You can still add static headers later via Edit
          if needed.
        </p>
      ) : (
        <>
          <SecretFields
            secrets={secrets}
            onChange={setSecrets}
            hint={
              isEdit
                ? "Write-only env vars for the MCP process. Values are never shown — leave blank to keep, enter a new value to overwrite, or remove a key."
                : "Env vars for the MCP process (e.g. COOLIFY_BASE_URL + COOLIFY_ACCESS_TOKEN). Encrypted at rest; values are never returned."
            }
          />
        </>
      )}

      </fieldset>

      <div className="row-actions form-actions">
        {!readOnly ? (
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create MCP"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          {readOnly ? "Close" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
