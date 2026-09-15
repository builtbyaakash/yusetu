import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { playgroundApi, toolsApi } from "../api";
import type { PlaygroundCallResponse } from "../api/types";
import { formatSampleArgs } from "../lib/sampleArgs";

export function PlaygroundPage() {
  const toolsQuery = useQuery({
    queryKey: ["tools", "all"],
    queryFn: () => toolsApi.list(),
  });

  const enabledTools = useMemo(
    () => (toolsQuery.data ?? []).filter((t) => t.enabled),
    [toolsQuery.data],
  );

  const [tool, setTool] = useState("");
  const [argsText, setArgsText] = useState("{\n  \n}");
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaygroundCallResponse | null>(null);

  const selectedTool = useMemo(
    () => enabledTools.find((t) => t.exposedName === tool),
    [enabledTools, tool],
  );

  useEffect(() => {
    if (!tool && enabledTools[0]) {
      setTool(enabledTools[0].exposedName);
    }
  }, [enabledTools, tool]);

  useEffect(() => {
    if (!selectedTool) return;
    setArgsText(formatSampleArgs(selectedTool.inputSchema));
    // Only when the selected tool identity changes — not on list refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [selectedTool?.id, selectedTool?.exposedName]);

  const callMutation = useMutation({
    mutationFn: (body: { tool: string; arguments: Record<string, unknown> }) =>
      playgroundApi.call(body),
    onSuccess: (data) => {
      setResult(data);
      setLocalError(null);
    },
    onError: (err) => {
      setResult(null);
      setLocalError(err instanceof ApiError ? err.message : "Call failed.");
    },
  });

  function resetSample() {
    if (!selectedTool) return;
    setArgsText(formatSampleArgs(selectedTool.inputSchema));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(argsText) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        setLocalError("Arguments must be a JSON object.");
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      setLocalError("Invalid JSON in arguments.");
      return;
    }
    if (!tool) {
      setLocalError("Select a tool.");
      return;
    }
    callMutation.mutate({ tool, arguments: parsed });
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Playground</h1>
          <p>Invoke an exposed tool through the gateway admin API.</p>
        </div>
      </div>

      <form className="form" onSubmit={handleSubmit} style={{ maxWidth: 720 }}>
        {(localError || toolsQuery.error) && (
          <div className="alert alert-error">
            {localError ??
              (toolsQuery.error instanceof ApiError
                ? toolsQuery.error.message
                : "Failed to load tools.")}
          </div>
        )}

        <div className="field">
          <label htmlFor="playground-tool">Tool</label>
          <select
            id="playground-tool"
            className="select mono"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            disabled={toolsQuery.isLoading || enabledTools.length === 0}
          >
            {enabledTools.length === 0 ? (
              <option value="">No enabled tools</option>
            ) : (
              enabledTools.map((t) => (
                <option key={t.id} value={t.exposedName}>
                  {t.exposedName}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="field">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <label htmlFor="playground-args" style={{ margin: 0 }}>
              Arguments (JSON)
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={resetSample}
              disabled={!selectedTool}
            >
              Reset sample
            </button>
          </div>
          <p className="hint">
            Sample from this tool&apos;s input schema — edit before calling.
          </p>
          <textarea
            id="playground-args"
            className="textarea"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={callMutation.isPending || !tool}
        >
          {callMutation.isPending ? "Calling…" : "Call tool"}
        </button>
      </form>

      {result ? (
        <div className="stack" style={{ marginTop: "1.5rem", maxWidth: 720 }}>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            {result.ok ? (
              <span className="badge badge-success">ok</span>
            ) : (
              <span className="badge badge-danger">error</span>
            )}
            <span className="badge">{result.latencyMs} ms</span>
          </div>
          {result.error ? (
            <div className="alert alert-error">{result.error}</div>
          ) : null}
          <div className="result-box">
            {JSON.stringify(result.result ?? result, null, 2)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
