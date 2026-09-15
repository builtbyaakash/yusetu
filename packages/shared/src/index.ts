import { z } from "zod";

export const UpstreamTransportSchema = z.enum([
  "stdio",
  "sse",
  "streamable-http",
]);
export type UpstreamTransport = z.infer<typeof UpstreamTransportSchema>;

export const SetupBodySchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});
export type SetupBody = z.infer<typeof SetupBodySchema>;

export const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const UpstreamAuthModeSchema = z.enum(["none", "oauth"]);
export type UpstreamAuthMode = z.infer<typeof UpstreamAuthModeSchema>;

/** Derive a URL-safe slug from an upstream display name (max 64 chars). */
export function slugifyUpstreamName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "mcp";
}

const CreateUpstreamObjectSchema = z.object({
  name: z.string().min(1).max(128),
  transport: UpstreamTransportSchema,
  command: z.string().optional(),
  argsJson: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  /** HTTPS git URL for stdio MCPs backed by a git checkout (prefer github.com). */
  gitUrl: z.union([z.string().url(), z.literal("")]).optional(),
  /** Branch/tag/commit; gateway defaults to `"main"` when `gitUrl` is set. */
  gitRef: z.union([z.string().max(128), z.literal("")]).optional(),
  /** Space-separated argv for one-shot install (e.g. `npm install`); omit/empty = skip. */
  installCommand: z.union([z.string().max(512), z.literal("")]).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  authMode: UpstreamAuthModeSchema.default("none"),
  secrets: z.record(z.string(), z.string()).optional(),
});

function refineGitSourceUpstream(
  data: {
    gitUrl?: string;
    transport?: UpstreamTransport;
    command?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (!data.gitUrl) return;
  if (data.transport !== "stdio") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "gitUrl requires transport to be stdio",
      path: ["transport"],
    });
  }
  if (!data.command?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "gitUrl requires command to run the MCP",
      path: ["command"],
    });
  }
}

export const CreateUpstreamSchema = CreateUpstreamObjectSchema.superRefine(
  refineGitSourceUpstream,
);
export type CreateUpstream = z.infer<typeof CreateUpstreamSchema>;

export const UpdateUpstreamSchema = CreateUpstreamObjectSchema.partial()
  .extend({
    /** Secret key names to delete (values are never returned by the API). */
    removeSecrets: z.array(z.string().min(1)).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.gitUrl) return;
    // Partial update: transport/command may already live on the row.
    if (data.transport !== undefined && data.transport !== "stdio") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gitUrl requires transport to be stdio",
        path: ["transport"],
      });
    }
  });
export type UpdateUpstream = z.infer<typeof UpdateUpstreamSchema>;

export const UpdateToolSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateTool = z.infer<typeof UpdateToolSchema>;

export const PlaygroundCallSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});
export type PlaygroundCall = z.infer<typeof PlaygroundCallSchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(128),
});
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>;

/** Exposed tool name: `{slug}__{originalName}` */
export function exposedToolName(slug: string, originalName: string): string {
  return `${slug}__${originalName}`;
}

export function parseExposedToolName(
  name: string,
): { slug: string; originalName: string } | null {
  const idx = name.indexOf("__");
  if (idx <= 0) return null;
  const slug = name.slice(0, idx);
  const originalName = name.slice(idx + 2);
  if (!slug || !originalName) return null;
  return { slug, originalName };
}

export type HealthResponse = {
  ok: boolean;
  version: string;
  setupRequired: boolean;
  upstreams: Array<{
    id: string;
    slug: string;
    status: "healthy" | "unhealthy" | "unknown" | "disabled";
    toolCount: number;
  }>;
};

export type AuthMeResponse = {
  id: string;
  username: string;
};
