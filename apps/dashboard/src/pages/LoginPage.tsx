import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi } from "../api";

type LoginPageProps = {
  setupRequired: boolean;
  authenticated: boolean;
  onSuccess: () => void;
};

export function LoginPage({
  setupRequired,
  authenticated,
  onSuccess,
}: LoginPageProps) {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => authApi.login({ username, password }),
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
    mutation.mutate();
  }

  const error =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? "Login failed."
        : null;

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <img
          className="auth-logo"
          src="/yusetu-mark.png"
          alt=""
        />
        <div className="auth-brand-name">Yūsetu</div>
        <p className="auth-brand-tag">One Gateway. Every MCP.</p>
        <p>Sign in to manage MCPs and tools.</p>
        <form className="form" onSubmit={handleSubmit}>
          {error ? <div className="alert alert-error">{error}</div> : null}
          <div className="field">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
