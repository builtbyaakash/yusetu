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

type FormStep = "connection" | "runtime" | "secrets" | "review";

const STEPS: { id: FormStep; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "runtime", label: "Runtime" },
  { id: "secrets", label: "Secrets" },
  { id: "review", label: "Review" },
];

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

function stepIndex(step: FormStep): number {
  return STEPS.findIndex((s) => s.id === step);
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
  const [step, setStep] = useState<FormStep>("connection");
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
  const [stepError, setStepError] = useState<string | null>(null);

  const needsUrl = sourceMode === "http";
  const isGithub = sourceMode === "github";
  const useOauth = needsUrl && authMode === "oauth";
  const slugPreview = slugifyUpstreamName(name);
  const currentIdx = stepIndex(step);

  function setSource(mode: SourceMode) {
    setSourceMode(mode);
    if (mode === "stdio" || mode === "github") {
      setTransport("stdio");
    } else {
      setTransport("streamable-http");
    }
    if (mode === "github" && !isEdit) {
      setIsolation("docker");
    }
  }

  function validateStep(target: FormStep): boolean {
    setStepError(null);
    if (target === "runtime" || stepIndex(target) > 0) {
      if (!name.trim()) {
        setStepError("Name is required.");
        return false;
      }
      if (needsUrl && !url.trim()) {
        setStepError("URL is required for HTTP.");
        return false;
      }
      if (isGithub && !gitUrl.trim()) {
        setStepError("Git URL is required.");
        return false;
      }
      if ((sourceMode === "stdio" || isGithub) && !command.trim()) {
        setStepError("Run command is required.");
        return false;
      }
    }
    return true;
  }

  function goNext() {
    const next = STEPS[currentIdx + 1];
    if (!next) return;
    if (!validateStep(next.id)) return;
    setStep(next.id);
  }

  function goBack() {
    const prev = STEPS[currentIdx - 1];
    if (!prev) return;
    setStepError(null);
    setStep(prev.id);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    if (step !== "review") {
      goNext();
      return;
    }
    if (!validateStep("review")) return;

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

  const reviewLines = [
    `Name: ${name.trim() || "—"}`,
    `Slug: ${slugPreview || "—"}`,
    `Source: ${sourceMode}`,
    needsUrl ? `URL: ${url.trim() || "—"}` : null,
    isGithub ? `Git: ${gitUrl.trim() || "—"} @ ${gitRef || "main"}` : null,
    !needsUrl ? `Command: ${command.trim() || "—"} ${argsText}`.trim() : null,
    isGithub ? `Isolation: ${isolation}` : null,
    needsUrl ? `Auth: ${authMode}` : null,
    `Timeout: ${timeoutMs} ms`,
    `Enabled: ${enabled ? "yes" : "no"}`,
  ].filter(Boolean) as string[];

  return (
    <form className="form" onSubmit={handleSubmit}>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {stepError ? <div className="alert alert-error">{stepError}</div> : null}
      {readOnly ? (
        <div className="alert alert-info">
          Shared team MCP — definition is read-only. Connect OAuth or use
          credentials when your admin enables overlays.
        </div>
      ) : null}

      {!readOnly ? (
        <div className="form-steps" aria-label="Form steps">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`form-step-pill${
                s.id === step ? " is-active" : ""
              }${i < currentIdx ? " is-done" : ""}`}
            >
              {i + 1}. {s.label}
            </span>
          ))}
        </div>
      ) : null}

      <fieldset disabled={readOnly} className="bare-fieldset">
        {(readOnly || step === "connection") && (
          <>
            <div className="field">
              <label htmlFor="upstream-name">Name</label>
              <input
                id="upstream-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={step === "connection"}
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
                  required={step === "connection"}
                />
                <span className="hint">
                  Transport (streamable-http or SSE) is detected from the URL.
                </span>
              </div>
            ) : isGithub ? (
              <>
                <div className="alert alert-info">
                  Clones the repo on the gateway, then runs install/runtime in a
                  slim Docker container by default.
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
                    required={step === "connection"}
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
                    required={step === "connection"}
                  />
                  <datalist id="upstream-github-command-presets">
                    <option value="uv" />
                    <option value="node" />
                    <option value="npx" />
                  </datalist>
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
                </div>
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
                    required={step === "connection"}
                  />
                  <datalist id="upstream-command-presets">
                    <option value="npx" />
                    <option value="uvx" />
                    <option value="node" />
                    <option value="docker" />
                  </datalist>
                </div>
                <div className="field">
                  <label htmlFor="upstream-args">Args</label>
                  <input
                    id="upstream-args"
                    className="input mono"
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder="space-separated arguments"
                  />
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
          </>
        )}

        {(readOnly || step === "runtime") && (
          <>
            {isGithub && !readOnly ? (
              <>
                <div className="field">
                  <label htmlFor="upstream-install-command">Install command</label>
                  <input
                    id="upstream-install-command"
                    className="input mono"
                    value={installCommand}
                    onChange={(e) => setInstallCommand(e.target.value)}
                    placeholder="npm install or uv sync"
                  />
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
                        <option value="none">none — no egress</option>
                        <option value="bridge">bridge — allow egress</option>
                      </select>
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
                        placeholder="Leave blank to auto-pick"
                      />
                    </div>
                  </>
                ) : (
                  <div className="alert alert-error">
                    Host isolation runs third-party code on the gateway process.
                  </div>
                )}
              </>
            ) : null}

            {readOnly && isGithub ? (
              <div className="field">
                <label>Isolation</label>
                <span className="hint">{isolation}</span>
              </div>
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
          </>
        )}

        {(readOnly || step === "secrets") && (
          <>
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

            {useOauth ? (
              <p className="hint">
                OAuth credentials are managed separately. After saving, use
                Connect OAuth from the MCP detail panel.
              </p>
            ) : (
              <SecretFields
                secrets={secrets}
                onChange={setSecrets}
                hint={
                  isEdit
                    ? "Write-only env vars. Leave blank to keep, enter a new value to overwrite, or remove a key."
                    : "Env vars for the MCP process. Encrypted at rest; values are never returned."
                }
              />
            )}
          </>
        )}

        {!readOnly && step === "review" ? (
          <div className="mcp-detail-grid">
            {reviewLines.map((line) => (
              <div key={line} className="mcp-detail-row">
                <span className="mcp-detail-value mono">{line}</span>
              </div>
            ))}
          </div>
        ) : null}
      </fieldset>

      <div className="row-actions form-actions">
        {!readOnly && currentIdx > 0 ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={goBack}
            disabled={submitting}
          >
            Back
          </button>
        ) : null}
        {!readOnly && step !== "review" ? (
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            Next
          </button>
        ) : null}
        {!readOnly && step === "review" ? (
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create MCP"}
          </button>
        ) : null}
        {readOnly ? null : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
        )}
        {readOnly ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Close
          </button>
        ) : null}
      </div>
    </form>
  );
}
