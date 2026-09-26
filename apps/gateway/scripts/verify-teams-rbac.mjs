/**
 * Verifies team invites, upstream RBAC, and API key scoping.
 * Run: pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-rbac.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(gatewayRoot, "../..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cookieFromResponse(res) {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const line of setCookie) {
    const m = line.match(/^yusetu_session=([^;]+)/);
    if (m) return `yusetu_session=${m[1]}`;
  }
  const raw = res.headers.get("set-cookie");
  if (raw) {
    const m = raw.match(/yusetu_session=([^;]+)/);
    if (m) return `yusetu_session=${m[1]}`;
  }
  return null;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-rbac-"));
  process.env.YUSETU_DATA_DIR = dataDir;

  const { openDb, closeDb } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  const { hashPassword } = await import(
    path.join(gatewayRoot, "src/auth/crypto.ts")
  );
  const { createApp } = await import(path.join(gatewayRoot, "src/app.ts"));
  const { loadConfig } = await import(path.join(gatewayRoot, "src/config.ts"));
  const { UpstreamPool } = await import(
    path.join(gatewayRoot, "src/upstreams/pool.ts")
  );
  const { ToolRouter } = await import(
    path.join(gatewayRoot, "src/mcp/router.ts")
  );
  const { getDb } = await import(path.join(gatewayRoot, "src/db/index.ts"));
  const { users, upstreams } = await import(
    path.join(gatewayRoot, "src/db/schema.ts")
  );

  openDb(path.join(dataDir, "gateway.db"));
  const db = getDb();
  const now = new Date();
  const ownerId = "owner-1";
  const ownerHash = await hashPassword("owner-pass-12");
  db.insert(users)
    .values({
      id: ownerId,
      username: "owner",
      passwordHash: ownerHash,
      role: "owner",
      createdAt: now,
      lastLoginAt: now,
    })
    .run();

  const sharedUpstreamId = "up-shared";
  db.insert(upstreams)
    .values({
      id: sharedUpstreamId,
      slug: "team-mcp",
      name: "Team MCP",
      transport: "stdio",
      command: "echo",
      enabled: false,
      timeoutMs: 30_000,
      authMode: "none",
      visibility: "shared",
      ownerUserId: null,
      createdAt: now,
      createdByUserId: ownerId,
    })
    .run();

  const config = loadConfig();
  config.dataDir = dataDir;
  config.dbPath = path.join(dataDir, "gateway.db");
  config.requireMcpAuth = false;
  const pool = new UpstreamPool(config);
  const router = new ToolRouter(pool);
  const app = createApp(config, pool, router);

  const loginOwner = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "owner-pass-12" }),
  });
  assert(loginOwner.status === 200, `owner login ${loginOwner.status}`);
  const ownerCookie = cookieFromResponse(loginOwner);
  assert(ownerCookie, "owner session cookie");

  const inviteRes = await app.request("/api/team/invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ role: "member" }),
  });
  assert(inviteRes.status === 201, `create invite ${inviteRes.status}`);
  const inviteBody = await inviteRes.json();
  assert(inviteBody.token, "invite token present");

  const joinRes = await app.request("/api/auth/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: inviteBody.token,
      username: "member1",
      password: "member-pass-12",
    }),
  });
  assert(joinRes.status === 201, `join ${joinRes.status}`);
  const memberCookie = cookieFromResponse(joinRes);
  assert(memberCookie, "member session cookie");
  const joinJson = await joinRes.json();
  assert(joinJson.role === "member", "joined as member");

  const patchShared = await app.request(`/api/upstreams/${sharedUpstreamId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: memberCookie,
    },
    body: JSON.stringify({ name: "Hijacked" }),
  });
  assert(patchShared.status === 403, `member patch shared ${patchShared.status}`);

  const keyRes = await app.request("/api/api-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: memberCookie,
    },
    body: JSON.stringify({ name: "member-key" }),
  });
  assert(keyRes.status === 201, `member create key ${keyRes.status}`);
  const keyBody = await keyRes.json();

  const ownerKeys = await app.request("/api/api-keys", {
    headers: { cookie: ownerCookie },
  });
  assert(ownerKeys.status === 200, `owner list keys ${ownerKeys.status}`);
  const ownerKeyList = await ownerKeys.json();
  assert(
    !ownerKeyList.some((k) => k.id === keyBody.id),
    "owner must not see member api key",
  );

  const ownerDelete = await app.request(`/api/api-keys/${keyBody.id}`, {
    method: "DELETE",
    headers: { cookie: ownerCookie },
  });
  assert(ownerDelete.status === 404, `owner delete member key ${ownerDelete.status}`);

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("verify-teams-rbac: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
