import type {
  AuthMeResponse,
  CreateApiKey,
  CreateInvite,
  CreateUpstream as SharedCreateUpstream,
  CreateUpstreamGrant,
  HealthResponse,
  JoinBody,
  PatchMemberRole,
  PlaygroundCall,
  Role,
  UpdateTool,
  UpdateUpstream as SharedUpdateUpstream,
  UpstreamGrant,
  UpstreamTransport,
  UpstreamVisibility,
} from "@yusetu/shared";

export type {
  AuthMeResponse,
  CreateApiKey,
  CreateInvite,
  CreateUpstreamGrant,
  HealthResponse,
  JoinBody,
  PatchMemberRole,
  PlaygroundCall,
  Role,
  UpdateTool,
  UpstreamGrant,
  UpstreamTransport,
  UpstreamVisibility,
};

export type UpstreamAuthMode = "none" | "oauth";

export type UpstreamIsolation = "host" | "docker";
export type UpstreamIsolationNetwork = "none" | "bridge";

export type UpstreamOauthStatus =
  | "disconnected"
  | "pending"
  | "connected"
  | "error";

/** Git-sourced stdio fields — extend shared CreateUpstream when available. */
type UpstreamGitFields = {
  gitUrl?: string;
  gitRef?: string;
  installCommand?: string;
  isolation?: UpstreamIsolation;
  isolationNetwork?: UpstreamIsolationNetwork;
  isolationImage?: string;
};

/** Dashboard create body — includes OAuth authMode ahead of shared schema. */
export type CreateUpstream = SharedCreateUpstream &
  UpstreamGitFields & {
    authMode?: UpstreamAuthMode;
  };

/** Dashboard update body — includes OAuth authMode ahead of shared schema. */
export type UpdateUpstream = SharedUpdateUpstream &
  UpstreamGitFields & {
    authMode?: UpstreamAuthMode;
  };

export type UpstreamStatus = "healthy" | "unhealthy" | "unknown" | "disabled";

export type Upstream = {
  id: string;
  name: string;
  slug: string;
  transport: UpstreamTransport;
  command?: string | null;
  argsJson?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  /** Present when MCP is sourced from a git checkout on the gateway. */
  gitUrl?: string | null;
  gitRef?: string | null;
  installCommand?: string | null;
  /** host = gateway process; docker = slim container (recommended for Git). */
  isolation?: UpstreamIsolation | null;
  isolationNetwork?: UpstreamIsolationNetwork | null;
  isolationImage?: string | null;
  enabled: boolean;
  timeoutMs: number;
  status?: UpstreamStatus;
  toolCount?: number;
  secretKeys?: string[];
  authMode?: UpstreamAuthMode;
  oauthStatus?: UpstreamOauthStatus;
  oauthError?: string | null;
  visibility?: UpstreamVisibility;
  ownerUserId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Present on create/update when auto-discover ran successfully. */
  discovered?: number;
  /** Present on create/update when auto-discover soft-failed. */
  discoveryError?: string;
};

export type UpstreamOauthStartResponse = {
  authorizationUrl: string;
};

export type UpstreamOauthStatusResponse = {
  status: UpstreamOauthStatus;
  connected: boolean;
  errorMessage?: string;
};

export type Tool = {
  id: string;
  upstreamId: string;
  upstreamSlug: string;
  upstreamName?: string;
  originalName: string;
  exposedName: string;
  description?: string | null;
  enabled: boolean;
  inputSchema?: unknown;
};

export type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
};

export type CreateApiKeyResponse = ApiKey & {
  key: string;
};

export type PlaygroundCallResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
  latencyMs: number;
};

export type UsageAnalytics = {
  totalCalls: number;
  tokensViaYusetu: number;
  tokensIfDirect: number;
  tokensSaved: number;
  savingsPercent: number | null;
  /** Tool-definition catalog exposure (meta list vs full union). */
  catalogTokensVia?: number;
  catalogTokensIfDirect?: number;
  catalogTokensSaved?: number;
  catalogSavingsPercent?: number | null;
  discoveryTokensVia?: number;
  discoveryTokensIfDirect?: number;
  invokeTokensVia?: number;
  invokeTokensIfDirect?: number;
  eventCount?: number;
  mcpCount: number;
  catalogToolCount: number;
  byMcp: Array<{
    slug: string;
    name: string;
    calls: number;
    tokensViaYusetu: number;
    tokensIfDirect: number;
    catalogTokens: number;
    toolCount: number;
  }>;
};

export type ApiErrorBody = {
  error?: string;
  message?: string;
};

export type TeamInvite = {
  id: string;
  role: "admin" | "member";
  createdByUserId: string;
  expiresAt: string;
  usedAt: string | null;
  usedByUserId: string | null;
  createdAt: string;
};

export type CreateInviteResponse = {
  invite: TeamInvite;
  token: string;
  joinPath: string;
};

export type TeamMember = {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
};

export type JoinResponse = {
  id: string;
  username: string;
  role: Role;
};
