import { useState } from "react";
import { slugifyUpstreamName } from "@yusetu/shared";
import type {
  CreateUpstream,
  UpdateUpstream,
  Upstream,
  UpstreamAuthMode,
  UpstreamTransport,
} from "../api/types";
import { SecretFields, secretsToRecord, secretsToRemove, type SecretPair } from "./SecretFields";

type UpstreamFormProps = {
  initial?: Upstream;
  submitting?: boolean;
  error?: string | null;
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
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        url: undefined,
      });
      return;
    }

    onSubmit({
      ...base,
      command: command.trim(),
      argsJson: parseArgs(argsText),
      cwd: cwd.trim() || undefined,
      url: undefined,
    });
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      {error ? <div className="alert alert-error">{error}</div> : null}

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
            Clones and runs code from this repo on the gateway host. Only use
            repos you trust.
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
              Optional — run once after clone. Prefer{" "}
              <code>uv sync</code> when the repo has a lockfile (not{" "}
              <code>uv pip install</code>). uv auto-creates .venv with a
              managed Python.
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
        <fieldset className="field" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Auth method
          </legend>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
              marginBottom: "0.5rem",
            }}
          >
            <input
              type="radio"
              name="authMode"
              checked={authMode === "none"}
              onChange={() => setAuthMode("none")}
              style={{ marginTop: "0.2rem" }}
            />
            <span>
              <strong>Static secrets / headers</strong>
              <span className="hint" style={{ display: "block" }}>
                API keys or custom headers stored as encrypted secrets
              </span>
            </span>
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
            }}
          >
            <input
              type="radio"
              name="authMode"
              checked={authMode === "oauth"}
              onChange={() => setAuthMode("oauth")}
              style={{ marginTop: "0.2rem" }}
            />
            <span>
              <strong>OAuth</strong>
              <span className="hint" style={{ display: "block" }}>
                Recommended for Linear and other OAuth MCP servers
              </span>
            </span>
          </label>
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
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
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

      <div className="row-actions" style={{ marginTop: "0.5rem" }}>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Create MCP"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
