import { count } from "drizzle-orm";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { getDb } from "./index.js";
import { upstreamOauth, upstreamSecrets } from "./schema.js";

/**
 * Fail fast if encrypted secrets exist but GATEWAY_MASTER_KEY is missing.
 */
export function assertMasterKeyIfNeeded(config: GatewayConfig): void {
  const db = getDb();
  const [{ value: secretCount } = { value: 0 }] = db
    .select({ value: count() })
    .from(upstreamSecrets)
    .all();

  const oauthRows = db.select().from(upstreamOauth).all();
  const oauthTokenCount = oauthRows.filter((r) => r.tokensJson).length;

  if ((secretCount > 0 || oauthTokenCount > 0) && !config.masterKeyBase64) {
    const log = getLogger("control");
    log.fatal(
      { secretCount, oauthTokenCount },
      "Encrypted upstream secrets/OAuth tokens exist but GATEWAY_MASTER_KEY is not set. Set a base64-encoded 32-byte key in the environment (see .env.example).",
    );
    throw new Error(
      "GATEWAY_MASTER_KEY is required because encrypted secrets exist in the database",
    );
  }
}
