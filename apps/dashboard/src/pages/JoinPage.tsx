import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi } from "../api";
import { ThemeToggle } from "../lib/theme";

type JoinPageProps = {
  setupRequired: boolean;
  authenticated: boolean;
  onSuccess: () => void;
};

export function JoinPage({
  setupRequired,
  authenticated,
  onSuccess,
}: JoinPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useMemo(
    () => searchParams.get("token")?.trim() ?? "",
    [searchParams],
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      authApi.join({
        token,
        username: username.trim(),
        password,
      }),
    onSuccess: () => {
      onSuccess();
      void navigate("/mcps", { replace: true });
    },
  });

  if (setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  if (authenticated) {
    return <Navigate to="/mcps" replace />;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    mutation.mutate();
  }

  const error =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? "Join failed."
        : null;

  return (
    <div className="auth-layout">
      <ThemeToggle className="auth-theme-toggle" />
      <div className="auth-card">
        <img className="auth-logo" src="/yusetu-mark.png" alt="" />
        <div className="auth-brand-name">Yūsetu</div>
        <p className="auth-brand-tag">One Gateway. Every MCP.</p>
        <p>Create your account to join this team.</p>
        {!token ? (
          <div className="alert alert-error">
            Missing invite token. Open the join link you received from your
            admin.
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            {error ? <div className="alert alert-error">{error}</div> : null}
            <div className="field">
              <label htmlFor="join-username">Username</label>
              <input
                id="join-username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                minLength={3}
              />
            </div>
            <div className="field">
              <label htmlFor="join-password">Password</label>
              <input
                id="join-password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
              <span className="hint">At least 8 characters.</span>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Creating account…" : "Join team"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
