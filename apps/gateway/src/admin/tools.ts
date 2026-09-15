import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { UpdateToolSchema } from "@yusetu/shared";
import { getDb } from "../db/index.js";
import { tools, upstreams } from "../db/schema.js";
import { rebuildSnapshotFromDb } from "../mcp/rebuild-snapshot.js";

export async function listTools(c: Context) {
  const db = getDb();
  const upstreamId = c.req.query("upstreamId");

  const rows = db
    .select({
      tool: tools,
      slug: upstreams.slug,
      upstreamName: upstreams.name,
    })
    .from(tools)
    .innerJoin(upstreams, eq(tools.upstreamId, upstreams.id))
    .all()
    .filter((r) => !upstreamId || r.tool.upstreamId === upstreamId);

  return c.json(
    rows.map((r) => ({
      id: r.tool.id,
      upstreamId: r.tool.upstreamId,
      upstreamSlug: r.slug,
      upstreamName: r.upstreamName,
      originalName: r.tool.originalName,
      exposedName: r.tool.exposedName,
      description: r.tool.description,
      inputSchema: r.tool.inputSchemaJson
        ? (JSON.parse(r.tool.inputSchemaJson) as unknown)
        : null,
      enabled: r.tool.enabled,
      lastSeenAt: r.tool.lastSeenAt?.toISOString() ?? null,
    })),
  );
}

export async function updateTool(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);
  const parsed = UpdateToolSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const db = getDb();
  const row = db.select().from(tools).where(eq(tools.id, id)).get();
  if (!row) return c.json({ error: "Not found" }, 404);

  db.update(tools)
    .set({ enabled: parsed.data.enabled })
    .where(eq(tools.id, id))
    .run();

  rebuildSnapshotFromDb();

  const updated = db
    .select({
      tool: tools,
      slug: upstreams.slug,
      upstreamName: upstreams.name,
    })
    .from(tools)
    .innerJoin(upstreams, eq(tools.upstreamId, upstreams.id))
    .where(and(eq(tools.id, id)))
    .get()!;

  return c.json({
    id: updated.tool.id,
    upstreamId: updated.tool.upstreamId,
    upstreamSlug: updated.slug,
    upstreamName: updated.upstreamName,
    originalName: updated.tool.originalName,
    exposedName: updated.tool.exposedName,
    description: updated.tool.description,
    enabled: updated.tool.enabled,
    inputSchema: updated.tool.inputSchemaJson
      ? (JSON.parse(updated.tool.inputSchemaJson) as unknown)
      : null,
  });
}
