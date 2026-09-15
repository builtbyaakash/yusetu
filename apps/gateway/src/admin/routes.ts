import { count, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { HealthResponse } from "@yusetu/shared";
import { VERSION } from "../config.js";
import { userCount } from "../auth/routes.js";
import { getDb } from "../db/index.js";
import { tools, upstreams } from "../db/schema.js";
import type { UpstreamPool } from "../upstreams/pool.js";

export function createHealthHandler(pool: UpstreamPool) {
  return async (c: Context) => {
    const db = getDb();
    const rows = db.select().from(upstreams).all();

    await Promise.all(
      rows.map(async (row) => {
        if (!row.enabled) {
          pool.setDisabled(row.id);
          return;
        }
        if (pool.getStatus(row.id).status === "unknown") {
          await pool.ensureStatus(row.id);
        }
      }),
    );

    const upstreamStatuses: HealthResponse["upstreams"] = rows.map((row) => {
      const toolCount =
        db
          .select({ value: count() })
          .from(tools)
          .where(eq(tools.upstreamId, row.id))
          .get()?.value ?? 0;

      if (!row.enabled) {
        return {
          id: row.id,
          slug: row.slug,
          status: "disabled" as const,
          toolCount,
        };
      }

      const st = pool.getStatus(row.id);
      return {
        id: row.id,
        slug: row.slug,
        status: st.status,
        toolCount,
      };
    });

    const body: HealthResponse = {
      ok: true,
      version: VERSION,
      setupRequired: userCount() === 0,
      upstreams: upstreamStatuses,
    };
    return c.json(body);
  };
}
