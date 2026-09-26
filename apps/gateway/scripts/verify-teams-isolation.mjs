/**
 * Verifies per-user MCP pool keys, git checkout paths, and catalog visibility helpers.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-isolation.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { mcpSourceDir } = await import(
    path.join(gatewayRoot, "src/upstreams/git-source.ts")
  );
  const { poolClientKey, catalogToolsForUser, visibleUpstreamIdsForUser } =
    await import(path.join(gatewayRoot, "src/upstreams/catalog.ts"));
  const { runtimeSnapshot } = await import(
    path.join(gatewayRoot, "src/mcp/snapshot.ts")
  );

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-iso-"));
  const userA = "user-a-id";
  const userB = "user-b-id";
  const slug = "demo-mcp";

  const pathA = mcpSourceDir(dataDir, userA, slug);
  const pathB = mcpSourceDir(dataDir, userB, slug);
  assert(pathA !== pathB, "checkout paths must differ per user");
  assert(pathA.includes(userA), "path A must include user id");
  assert(pathB.includes(userB), "path B must include user id");

  const keyA = poolClientKey(userA, "upstream-1");
  const keyB = poolClientKey(userB, "upstream-1");
  assert(keyA !== keyB, "pool keys must differ per user for same upstream");
  assert(keyA === `${userA}:upstream-1`, "pool key format");

  process.env.YUSETU_DATA_DIR = dataDir;
  const dbPath = path.join(dataDir, "gateway.db");
  const { openDb, closeDb, getDb } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  openDb(dbPath);
  const db = getDb();
  const { hashPassword } = await import(
    path.join(gatewayRoot, "src/auth/crypto.ts")
  );
  const { users, upstreams, tools } = await import(
    path.join(gatewayRoot, "src/db/schema.ts")
  );

  const now = new Date();
  const passA = await hashPassword("pass-a");
  const passB = await hashPassword("pass-b");
  db.insert(users)
    .values([
      {
        id: userA,
        username: "alice",
        passwordHash: passA,
        role: "owner",
        createdAt: now,
      },
      {
        id: userB,
        username: "bob",
        passwordHash: passB,
        role: "member",
        createdAt: now,
      },
    ])
    .run();

  const sharedId = "up-shared";
  const personalBId = "up-personal-b";
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
        createdByUserId: userA,
      },
      {
        id: personalBId,
        slug: "private-b",
        name: "Bob personal",
        transport: "stdio",
        command: "echo",
        enabled: true,
        timeoutMs: 30_000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: userB,
        createdAt: now,
        createdByUserId: userB,
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
        id: "tool-b",
        upstreamId: personalBId,
        originalName: "secret",
        exposedName: "private-b__secret",
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
      upstreamId: personalBId,
      originalName: "secret",
      slug: "private-b",
      exposedName: "private-b__secret",
      description: null,
      inputSchema: null,
    },
  ]);

  const aliceCatalog = catalogToolsForUser(userA);
  const bobCatalog = catalogToolsForUser(userB);
  assert(
    aliceCatalog.some((t) => t.exposedName === "shared-mcp__ping"),
    "alice (owner) sees shared tool via elevated bypass",
  );
  assert(
    !aliceCatalog.some((t) => t.exposedName === "private-b__secret"),
    "alice must not see bob personal tool",
  );
  assert(
    bobCatalog.some((t) => t.exposedName === "private-b__secret"),
    "bob sees personal tool",
  );
  assert(
    !bobCatalog.some((t) => t.exposedName === "shared-mcp__ping"),
    "bob (member, no grant) must not see shared tool",
  );

  const aliceVisible = visibleUpstreamIdsForUser(userA);
  assert(aliceVisible.has(sharedId), "alice visible upstreams include shared");
  assert(!aliceVisible.has(personalBId), "alice must not see bob upstream id");

  const bobVisible = visibleUpstreamIdsForUser(userB);
  assert(bobVisible.has(personalBId), "bob visible includes own personal");
  assert(!bobVisible.has(sharedId), "bob without grant omits shared");

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log("verify-teams-isolation: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
