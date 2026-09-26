import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi } from "../api";
import type { AuthMeResponse, HealthResponse } from "../api/types";
import { ThemeToggle } from "../lib/theme";

type SetupPageProps = {
  setupRequired: boolean;
  onSuccess: () => void;
};

export function SetupPage({ setupRequired, onSuccess }: SetupPageProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => authApi.setup({ username, password }),
    onSuccess: (me: AuthMeResponse) => {
      qc.setQueryData<HealthResponse>(["health"], (prev) =>
        prev ? { ...prev, setupRequired: false } : prev,
      );
      qc.setQueryData(["auth", "me"], me);
      onSuccess();
      void navigate("/mcps", { replace: true });
    },
  });

  if (!setupRequired) {
    return <Navigate to="/login" replace />;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (username.trim().length < 3) {
      setLocalError("Username must be at least 3 characters.");
      return;
    }
    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setLocalError("Passwords do not match.");
      return;
    }
    mutation.mutate();
  }

  const error =
    localError ??
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? "Sign up failed."
        : null);

  return (
    <div className="auth-layout">
      <ThemeToggle className="auth-theme-toggle" />
      <div className="auth-card">
        <img
          className="auth-logo"
          src="/yusetu-mark.png"
          alt=""
        />
        <div className="auth-brand-name">Yūsetu</div>
        <p className="auth-brand-tag">One Gateway. Every MCP.</p>
        <h1 className="auth-heading">Create admin account</h1>
        <p>Sign up to manage this gateway install. There is no default admin.</p>
        <form className="form" onSubmit={handleSubmit}>
          {error ? <div className="alert alert-error">{error}</div> : null}
          <div className="field">
            <label htmlFor="setup-username">Username</label>
            <input
              id="setup-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="setup-password">Password</label>
            <input
              id="setup-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="setup-confirm">Confirm password</label>
            <input
              id="setup-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Sign up"}
          </button>
        </form>
      </div>
    </div>
  );
}
