import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
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

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["auth", "me"] });
      void qc.invalidateQueries({ queryKey: ["health"] });
    },
  });

  const setupRequired = healthQuery.data?.setupRequired ?? false;
  const user = meQuery.data ?? null;
  const authenticated = Boolean(user);
  const booting = healthQuery.isLoading || meQuery.isLoading;
  const bootError = healthQuery.error ?? meQuery.error;

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
              void meQuery.refetch();
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
            <Navigate to="/login" replace />
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
