/**
 * Seed / ensure UI test member `uitest` against YUSETU_DATA_DIR.
 *
 * Usage:
 *   YUSETU_DATA_DIR=/tmp/yusetu-ui-data GATEWAY_MASTER_KEY=... \
 *     bash scripts/with-node22.sh node scripts/seed-ui-test-user.mjs
 *
 * Credentials: uitest / uitest-pass-12345
 * Requires an existing owner (run setup first). Creates invite + joins as member
 * when uitest is missing; no-ops if already present.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const USERNAME = "uitest";
const PASSWORD = "uitest-pass-12345";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const dataDir = process.env.YUSETU_DATA_DIR;
  assert(dataDir, "YUSETU_DATA_DIR is required");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!process.env.GATEWAY_MASTER_KEY) {
    process.env.GATEWAY_MASTER_KEY = crypto.randomBytes(32).toString("base64");
  }

  const gatewayRoot = path.join(root, "apps/gateway");
  const { openDb, closeDb, getSqlite } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  const { createApp } = await import(path.join(gatewayRoot, "src/app.ts"));
  const { loadConfig } = await import(path.join(gatewayRoot, "src/config.ts"));
  const { UpstreamPool } = await import(
    path.join(gatewayRoot, "src/upstreams/pool.ts")
  );
  const { ToolRouter } = await import(
    path.join(gatewayRoot, "src/mcp/router.ts")
  );

  const dbPath = path.join(dataDir, "gateway.db");
  openDb(dbPath);
  const config = loadConfig();
  config.dataDir = dataDir;
  config.dbPath = dbPath;
  config.requireMcpAuth = false;
  const pool = new UpstreamPool(config);
  const router = new ToolRouter(pool);
  const app = createApp(config, pool, router);

  const existing = getSqlite()
    .prepare(`SELECT id, username, role FROM users WHERE username = ?`)
    .get(USERNAME);
  if (existing) {
    console.log(
      JSON.stringify({
        ok: true,
        action: "exists",
        username: USERNAME,
        password: PASSWORD,
        role: existing.role,
        dataDir,
      }),
    );
    closeDb();
    return;
  }

  const owner = getSqlite()
    .prepare(`SELECT id, username FROM users WHERE role = 'owner' LIMIT 1`)
    .get();
  assert(owner, "No owner found — run /api/auth/setup first");

  // Login as owner via password from env or create invite with direct DB session.
  // Prefer owner password from env OWNER_PASSWORD; else use setup if only bootstrap.
  const ownerPassword = process.env.OWNER_PASSWORD;
  assert(
    ownerPassword,
    "OWNER_PASSWORD required to invite uitest (owner login)",
  );

  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: owner.username,
      password: ownerPassword,
    }),
  });
  assert(login.status === 200, `owner login ${login.status}`);
  const setCookie = login.headers.getSetCookie?.() ?? [];
  let cookie = null;
  for (const line of setCookie) {
    const m = line.match(/^yusetu_session=([^;]+)/);
    if (m) cookie = `yusetu_session=${m[1]}`;
  }
  if (!cookie) {
    const raw = login.headers.get("set-cookie");
    const m = raw?.match(/yusetu_session=([^;]+)/);
    if (m) cookie = `yusetu_session=${m[1]}`;
  }
  assert(cookie, "owner session cookie");

  const inviteRes = await app.request("/api/team/invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ role: "member" }),
  });
  assert(inviteRes.status === 201, `invite ${inviteRes.status}`);
  const invite = await inviteRes.json();

  const joinRes = await app.request("/api/auth/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: invite.token,
      username: USERNAME,
      password: PASSWORD,
    }),
  });
  assert(joinRes.status === 201, `join ${joinRes.status}`);

  console.log(
    JSON.stringify({
      ok: true,
      action: "created",
      username: USERNAME,
      password: PASSWORD,
      role: "member",
      dataDir,
    }),
  );
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
