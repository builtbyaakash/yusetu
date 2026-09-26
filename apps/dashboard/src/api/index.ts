import { apiFetch } from "./client";
import type {
  ApiKey,
  AuthMeResponse,
  CreateApiKey,
  CreateApiKeyResponse,
  CreateInvite,
  CreateInviteResponse,
  CreateUpstream,
  HealthResponse,
  JoinBody,
  JoinResponse,
  PatchMemberRole,
  PlaygroundCall,
  PlaygroundCallResponse,
  TeamInvite,
  TeamMember,
  Tool,
  UpdateTool,
  UpdateUpstream,
  Upstream,
  UpstreamOauthStartResponse,
  UpstreamOauthStatusResponse,
  UsageAnalytics,
} from "./types";

export const authApi = {
  me: () => apiFetch<AuthMeResponse>("/api/auth/me"),
  setup: (body: { username: string; password: string }) =>
    apiFetch<AuthMeResponse>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: { username: string; password: string }) =>
    apiFetch<AuthMeResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () =>
    apiFetch<void>("/api/auth/logout", {
      method: "POST",
    }),
  join: (body: JoinBody) =>
    apiFetch<JoinResponse>("/api/auth/join", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const teamApi = {
  createInvite: (body: CreateInvite) =>
    apiFetch<CreateInviteResponse>("/api/team/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listInvites: () => apiFetch<TeamInvite[]>("/api/team/invites"),
  revokeInvite: (id: string) =>
    apiFetch<void>(`/api/team/invites/${id}`, {
      method: "DELETE",
    }),
  listMembers: () => apiFetch<TeamMember[]>("/api/team/members"),
  patchMemberRole: (userId: string, body: PatchMemberRole) =>
    apiFetch<TeamMember>(`/api/team/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeMember: (userId: string) =>
    apiFetch<void>(`/api/team/members/${userId}`, {
      method: "DELETE",
    }),
};

export const healthApi = {
  get: () => apiFetch<HealthResponse>("/api/health"),
};

export const upstreamsApi = {
  list: () => apiFetch<Upstream[]>("/api/upstreams"),
  get: (id: string) => apiFetch<Upstream>(`/api/upstreams/${id}`),
  create: (body: CreateUpstream) =>
    apiFetch<Upstream>("/api/upstreams", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: UpdateUpstream) =>
    apiFetch<Upstream>(`/api/upstreams/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/upstreams/${id}`, {
      method: "DELETE",
    }),
  removeSecret: (id: string, key: string) =>
    apiFetch<Upstream>(
      `/api/upstreams/${id}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    ),
  discover: (id: string) =>
    apiFetch<Upstream>(`/api/upstreams/${id}/discover`, {
      method: "POST",
    }),
  startOauth: (id: string) =>
    apiFetch<UpstreamOauthStartResponse>(`/api/upstreams/${id}/oauth/start`, {
      method: "POST",
    }),
  oauthStatus: (id: string) =>
    apiFetch<UpstreamOauthStatusResponse>(
      `/api/upstreams/${id}/oauth/status`,
    ),
  disconnectOauth: (id: string) =>
    apiFetch<void>(`/api/upstreams/${id}/oauth/disconnect`, {
      method: "POST",
    }),
};

export const toolsApi = {
  list: (upstreamId?: string) => {
    const qs = upstreamId
      ? `?upstreamId=${encodeURIComponent(upstreamId)}`
      : "";
    return apiFetch<Tool[]>(`/api/tools${qs}`);
  },
  update: (id: string, body: UpdateTool) =>
    apiFetch<Tool>(`/api/tools/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

export const playgroundApi = {
  call: (body: PlaygroundCall) =>
    apiFetch<PlaygroundCallResponse>("/api/playground/call", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const apiKeysApi = {
  list: () => apiFetch<ApiKey[]>("/api/api-keys"),
  create: (body: CreateApiKey) =>
    apiFetch<CreateApiKeyResponse>("/api/api-keys", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/api-keys/${id}`, {
      method: "DELETE",
    }),
};

export const analyticsApi = {
  usage: () => apiFetch<UsageAnalytics>("/api/analytics/usage"),
};
