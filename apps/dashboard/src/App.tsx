import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ApiError } from "./api/client";
import { authApi, healthApi } from "./api";
import type { AuthMeResponse } from "./api/types";
import { Layout } from "./components/Layout";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { LoginPage } from "./pages/LoginPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { ToolsPage } from "./pages/ToolsPage";
import { UpstreamsPage } from "./pages/UpstreamsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function isAuthPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/setup";
}

function BootGate() {
  const location = useLocation();
  const qc = useQueryClient();

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => healthApi.get(),
  });

  const setupRequired = healthQuery.data?.setupRequired ?? false;

  // Skip /auth/me while setup is required so a stale cookie cannot mark us
  // authenticated or flash protected routes before the /setup redirect.
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    enabled: healthQuery.isSuccess && !setupRequired,
    queryFn: async (): Promise<AuthMeResponse | null> => {
      try {
        return await authApi.me();
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return null;
        }
        throw err;
      }
    },
  });

  // Drop any leftover session cookie once on a fresh (zero-user) install.
  // One-shot so we do not clear the cookie created by a successful signup.
  const clearedStaleSession = useRef(false);
  useEffect(() => {
    if (!setupRequired) {
      clearedStaleSession.current = false;
      return;
    }
    if (!healthQuery.isSuccess || clearedStaleSession.current) return;
    clearedStaleSession.current = true;
    void authApi.logout().catch(() => {
      /* ignore — best-effort cookie clear */
    });
    qc.setQueryData(["auth", "me"], null);
  }, [healthQuery.isSuccess, setupRequired, qc]);

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["auth", "me"] });
      void qc.invalidateQueries({ queryKey: ["health"] });
    },
  });

  const user = setupRequired ? null : (meQuery.data ?? null);
  const authenticated = Boolean(user);
  const needMe = healthQuery.isSuccess && !setupRequired;
  const booting =
    healthQuery.isLoading || (needMe && meQuery.isLoading);
  const bootError =
    healthQuery.error ?? (needMe ? meQuery.error : null);

  const refreshAuth = () => {
    void qc.invalidateQueries({ queryKey: ["auth", "me"] });
    void qc.invalidateQueries({ queryKey: ["health"] });
  };

  if (booting) {
    return <div className="loading-screen">Loading Yusetu…</div>;
  }

  if (bootError) {
    return (
      <div className="auth-layout">
        <div className="auth-card">
          <div className="brand-name">Yusetu</div>
          <div className="alert alert-error">
            {bootError instanceof ApiError
              ? bootError.message
              : "Cannot reach the gateway. Is it running on :8080?"}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void healthQuery.refetch();
              if (needMe) void meQuery.refetch();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (setupRequired && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }

  if (
    !setupRequired &&
    !authenticated &&
    !isAuthPublicPath(location.pathname)
  ) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppRoutes
      setupRequired={setupRequired}
      authenticated={authenticated}
      user={user}
      loggingOut={logoutMutation.isPending}
      onLogout={() => logoutMutation.mutate()}
      onAuthSuccess={refreshAuth}
    />
  );
}

type AppRoutesProps = {
  setupRequired: boolean;
  authenticated: boolean;
  user: AuthMeResponse | null;
  loggingOut: boolean;
  onLogout: () => void;
  onAuthSuccess: () => void;
};

function AppRoutes({
  setupRequired,
  authenticated,
  user,
  loggingOut,
  onLogout,
  onAuthSuccess,
}: AppRoutesProps) {
  const unauthRedirect = setupRequired ? "/setup" : "/login";

  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <SetupPage setupRequired={setupRequired} onSuccess={onAuthSuccess} />
        }
      />
      <Route
        path="/login"
        element={
          <LoginPage
            setupRequired={setupRequired}
            authenticated={authenticated}
            onSuccess={onAuthSuccess}
          />
        }
      />
      <Route
        element={
          user ? (
            <Layout user={user} loggingOut={loggingOut} onLogout={onLogout}>
              <Outlet />
            </Layout>
          ) : (
            <Navigate to={unauthRedirect} replace />
          )
        }
      >
        <Route path="/" element={<Navigate to="/mcps" replace />} />
        <Route path="/mcps" element={<UpstreamsPage />} />
        <Route path="/upstreams" element={<Navigate to="/mcps" replace />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/playground" element={<PlaygroundPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/mcps" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <BootGate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
