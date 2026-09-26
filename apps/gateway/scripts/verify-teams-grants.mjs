/**
 * Verifies grant-gated shared catalog visibility and /api/tools filtering.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-grants.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-grants-"));
  process.env.YUSETU_DATA_DIR = dataDir;
  process.env.GATEWAY_MASTER_KEY = crypto.randomBytes(32).toString("base64");

  const { openDb, closeDb, getDb, getSqlite } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  const { hashPassword } = await import(
    path.join(gatewayRoot, "src/auth/crypto.ts")
  );
  const { catalogToolsForUser, visibleUpstreamIdsForUser } = await import(
    path.join(gatewayRoot, "src/upstreams/catalog.ts")
  );
  const { runtimeSnapshot } = await import(
    path.join(gatewayRoot, "src/mcp/snapshot.ts")
  );
  const { createApp } = await import(path.join(gatewayRoot, "src/app.ts"));
  const { loadConfig } = await import(path.join(gatewayRoot, "src/config.ts"));
  const { UpstreamPool } = await import(
    path.join(gatewayRoot, "src/upstreams/pool.ts")
  );
  const { ToolRouter } = await import(
    path.join(gatewayRoot, "src/mcp/router.ts")
  );
  const { users, upstreams, tools, upstreamGrants } = await import(
    path.join(gatewayRoot, "src/db/schema.ts")
  );

  openDb(path.join(dataDir, "gateway.db"));
  const db = getDb();
  const sqlite = getSqlite();
  const now = new Date();

  const ownerId = "owner-1";
  const memberA = "member-a";
  const memberB = "member-b";
  const sharedId = "up-shared";
  const personalAId = "up-personal-a";

  const table = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upstream_grants'`,
    )
    .get();
  assert(table, "upstream_grants table exists after migrate");
  const grantCount = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM upstream_grants`)
    .get().n;
  assert(grantCount === 0, "migrate leaves upstream_grants empty");

  const flag = sqlite
    .prepare(`SELECT value FROM settings WHERE key = 'schema_grants_v1'`)
    .get();
  assert(flag?.value === "1", "schema_grants_v1 flagged");

  db.insert(users)
    .values([
      {
        id: ownerId,
        username: "owner",
        passwordHash: await hashPassword("owner-pass-12"),
        role: "owner",
        createdAt: now,
        lastLoginAt: now,
      },
      {
        id: memberA,
        username: "alice",
        passwordHash: await hashPassword("alice-pass-12"),
        role: "member",
        createdAt: now,
        lastLoginAt: now,
      },
      {
        id: memberB,
        username: "bob",
        passwordHash: await hashPassword("bob-pass-12"),
        role: "member",
        createdAt: now,
        lastLoginAt: now,
      },
    ])
    .run();

  db.insert(upstreams)
    .values([
      {
        id: sharedId,
        slug: "shared-mcp",
        name: "Shared",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "shared",
        ownerUserId: null,
        createdAt: now,
        createdByUserId: ownerId,
      },
      {
        id: personalAId,
        slug: "alice-private",
        name: "Alice personal",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: memberA,
        createdAt: now,
        createdByUserId: memberA,
      },
    ])
    .run();

  db.insert(tools)
    .values([
      {
        id: "tool-shared",
        upstreamId: sharedId,
        originalName: "ping",
        exposedName: "shared-mcp__ping",
        enabled: true,
        lastSeenAt: now,
      },
      {
        id: "tool-a",
        upstreamId: personalAId,
        originalName: "secret",
        exposedName: "alice-private__secret",
        enabled: true,
        lastSeenAt: now,
      },
    ])
    .run();

  runtimeSnapshot.swap([
    {
      upstreamId: sharedId,
      originalName: "ping",
      slug: "shared-mcp",
      exposedName: "shared-mcp__ping",
      description: null,
      inputSchema: null,
    },
    {
      upstreamId: personalAId,
      originalName: "secret",
      slug: "alice-private",
      exposedName: "alice-private__secret",
      description: null,
      inputSchema: null,
    },
  ]);

  const ownerVisible = visibleUpstreamIdsForUser(ownerId);
  assert(ownerVisible.has(sharedId), "elevated bypass: owner sees shared");
  assert(
    !ownerVisible.has(personalAId),
    "owner does not see alice personal",
  );

  const aliceEmpty = visibleUpstreamIdsForUser(memberA);
  assert(aliceEmpty.has(personalAId), "alice sees own personal");
  assert(
    !aliceEmpty.has(sharedId),
    "empty grants: alice does not see shared",
  );
  const aliceCatalogEmpty = catalogToolsForUser(memberA);
  assert(
    !aliceCatalogEmpty.some((t) => t.exposedName === "shared-mcp__ping"),
    "empty grants: alice catalog omits shared tool",
  );
  assert(
    aliceCatalogEmpty.some((t) => t.exposedName === "alice-private__secret"),
    "alice catalog keeps personal tool",
  );

  const bobVisible = visibleUpstreamIdsForUser(memberB);
  assert(!bobVisible.has(personalAId), "personal still private from bob");
  assert(!bobVisible.has(sharedId), "bob has no shared without grant");

  const config = loadConfig();
  config.dataDir = dataDir;
  config.dbPath = path.join(dataDir, "gateway.db");
  config.requireMcpAuth = false;
  const pool = new UpstreamPool(config);
  const router = new ToolRouter(pool);
  const app = createApp(config, pool, router);

  const loginAlice = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice-pass-12" }),
  });
  assert(loginAlice.status === 200, `alice login ${loginAlice.status}`);
  const aliceCookie = cookieFromResponse(loginAlice);
  assert(aliceCookie, "alice cookie");

  const toolsEmpty = await app.request("/api/tools", {
    headers: { cookie: aliceCookie },
  });
  assert(toolsEmpty.status === 200, `alice tools ${toolsEmpty.status}`);
  const toolsEmptyBody = await toolsEmpty.json();
  assert(
    !toolsEmptyBody.some((t) => t.upstreamId === sharedId),
    "tools list filter: no ungranted shared",
  );
  assert(
    toolsEmptyBody.some((t) => t.upstreamId === personalAId),
    "tools list filter: personal still present",
  );

  db.insert(upstreamGrants)
    .values({
      id: "grant-1",
      upstreamId: sharedId,
      userId: memberA,
      createdAt: now,
    })
    .run();

  const aliceGranted = visibleUpstreamIdsForUser(memberA);
  assert(aliceGranted.has(sharedId), "grant unlocks shared for alice");
  assert(
    catalogToolsForUser(memberA).some(
      (t) => t.exposedName === "shared-mcp__ping",
    ),
    "grant unlocks shared tool in catalog",
  );

  const toolsGranted = await app.request("/api/tools", {
    headers: { cookie: aliceCookie },
  });
  const toolsGrantedBody = await toolsGranted.json();
  assert(
    toolsGrantedBody.some((t) => t.upstreamId === sharedId),
    "tools list shows granted shared",
  );

  assert(
    !visibleUpstreamIdsForUser(memberB).has(sharedId),
    "bob still lacks shared after alice grant",
  );

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("verify-teams-grants: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
