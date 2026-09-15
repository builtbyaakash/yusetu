import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { CreateApiKeySchema } from "@yusetu/shared";
import { generateApiKey } from "../auth/crypto.js";
import { getDb } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { getLogger } from "../logger.js";

export async function listApiKeys(c: Context) {
  const db = getDb();
  const rows = db.select().from(apiKeys).all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.prefix,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    })),
  );
}

export async function createApiKey(c: Context) {
  const parsed = CreateApiKeySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const { raw, prefix, hash } = generateApiKey();
  const id = crypto.randomUUID();
  const now = new Date();
  const db = getDb();

  db.insert(apiKeys)
    .values({
      id,
      name: parsed.data.name,
      keyHash: hash,
      prefix,
      createdAt: now,
      enabled: true,
    })
    .run();

  getLogger("control").info({ apiKeyId: id, prefix }, "api key created");

  return c.json(
    {
      id,
      name: parsed.data.name,
      keyPrefix: prefix,
      key: raw,
      createdAt: now.toISOString(),
    },
    201,
  );
}

export async function deleteApiKey(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);
  const db = getDb();
  const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!row) return c.json({ error: "Not found" }, 404);
  db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return c.body(null, 204);
}
