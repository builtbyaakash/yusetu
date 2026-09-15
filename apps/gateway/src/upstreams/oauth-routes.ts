import type { Context } from "hono";
import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { getPublicOrigin } from "../oauth/metadata.js";
import type { UpstreamPool } from "./pool.js";
import {
  clearUpstreamOauthTokens,
  completeUpstreamOAuth,
  createUpstreamOAuthProvider,
  findUpstreamOauthByState,
  getUpstreamOauthRow,
  requireHttpOauthUpstream,
  resolvePublicOrigin,
  setUpstreamOauthStatus,
  startUpstreamOAuth,
} from "./oauth-provider.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { upstreams } from "../db/schema.js";

export function createUpstreamOauthHandlers(
  config: GatewayConfig,
  pool: UpstreamPool,
) {
  const log = getLogger("control");

  return {
    async start(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);

      const checked = requireHttpOauthUpstream(id);
      if (!checked.ok) {
        return c.json({ error: checked.error }, checked.status);
      }
      const { upstream } = checked;

      let provider;
      try {
        const publicOrigin = resolvePublicOrigin(config, getPublicOrigin(c));
        provider = createUpstreamOAuthProvider(id, publicOrigin, config);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      try {
        const { result, authorizationUrl } = await startUpstreamOAuth(
          provider,
          upstream.url,
        );
        if (result === "AUTHORIZED") {
          setUpstreamOauthStatus(id, "connected");
          await pool.invalidate(id);
          return c.json({ authorizationUrl: "", status: "connected" });
        }
        return c.json({ authorizationUrl: authorizationUrl! });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setUpstreamOauthStatus(id, "error", message);
        log.error({ upstreamId: id, err: message }, "oauth start failed");
        return c.json({ error: message }, 502);
      }
    },

    async status(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);

      const upstream = getDb()
        .select()
        .from(upstreams)
        .where(eq(upstreams.id, id))
        .get();
      if (!upstream) return c.json({ error: "Not found" }, 404);

      const row = getUpstreamOauthRow(id);
      const status = row?.status ?? "disconnected";
      return c.json({
        status,
        errorMessage: row?.errorMessage ?? undefined,
        connected: status === "connected",
      });
    },

    async disconnect(c: Context) {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "Missing id" }, 400);

      const upstream = getDb()
        .select()
        .from(upstreams)
        .where(eq(upstreams.id, id))
        .get();
      if (!upstream) return c.json({ error: "Not found" }, 404);

      clearUpstreamOauthTokens(id);
      await pool.invalidate(id);
      log.info({ upstreamId: id }, "upstream oauth disconnected");
      return c.json({ status: "disconnected", connected: false });
    },
  };
}

/**
 * Browser callback — no admin session required (user returns from AS).
 * Renders a close-this-tab page so the Yusetu dashboard tab can stay open.
 */
export function createUpstreamOauthCallbackHandler(
  config: GatewayConfig,
  pool: UpstreamPool,
) {
  const log = getLogger("control");

  return async (c: Context) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    const requestOrigin = getPublicOrigin(c);

    const redirectDone = (outcome: "connected" | "error") =>
      c.html(oauthPopupDoneHtml(outcome), 200);

    if (oauthError) {
      log.warn({ oauthError }, "upstream oauth callback error from AS");
      if (state) {
        const row = findUpstreamOauthByState(state);
        if (row) {
          setUpstreamOauthStatus(
            row.upstreamId,
            "error",
            c.req.query("error_description") ?? oauthError,
          );
        }
      }
      return redirectDone("error");
    }

    if (!code || !state) {
      return redirectDone("error");
    }

    const oauthRow = findUpstreamOauthByState(state);
    if (!oauthRow) {
      log.warn({ state }, "upstream oauth callback unknown state");
      return redirectDone("error");
    }

    const checked = requireHttpOauthUpstream(oauthRow.upstreamId);
    if (!checked.ok) {
      setUpstreamOauthStatus(
        oauthRow.upstreamId,
        "error",
        "Upstream missing or not configured for OAuth",
      );
      return redirectDone("error");
    }

    try {
      const publicOrigin = resolvePublicOrigin(config, requestOrigin);
      const provider = createUpstreamOAuthProvider(
        oauthRow.upstreamId,
        publicOrigin,
        config,
      );
      await completeUpstreamOAuth(provider, checked.upstream.url, code);
      await pool.invalidate(oauthRow.upstreamId);
      log.info(
        { upstreamId: oauthRow.upstreamId },
        "upstream oauth connected",
      );
      return redirectDone("connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUpstreamOauthStatus(oauthRow.upstreamId, "error", message);
      log.error(
        { upstreamId: oauthRow.upstreamId, err: message },
        "upstream oauth callback failed",
      );
      return redirectDone("error");
    }
  };
}

function oauthPopupDoneHtml(outcome: "connected" | "error"): string {
  const ok = outcome === "connected";
  const title = ok ? "Connected" : "Authorization failed";
  const body = ok
    ? "OAuth succeeded. You can close this tab and return to Yūsetu."
    : "OAuth did not complete. Close this tab and try Connect OAuth again in Yūsetu.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Yūsetu — ${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a192f; color: #e8eef5;
      display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { max-width: 28rem; padding: 1.75rem; border-radius: 12px;
      background: #0f2137; border: 1px solid #1e3a5f; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #8b9cb3; margin: 0 0 1rem; line-height: 1.45; }
    button { background: #1e5eff; color: #fff; border: 0; border-radius: 8px;
      padding: 0.55rem 1rem; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    <button type="button" onclick="window.close()">Close tab</button>
  </div>
  <script>
    try { if (window.opener) window.opener.focus(); } catch (e) {}
  </script>
</body>
</html>`;
}

