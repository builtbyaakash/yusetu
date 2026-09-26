/**
 * Verifies personal-first create, soft-migrate, promote, and unshare.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-personal-first.mjs
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-pf-"));
  process.env.YUSETU_DATA_DIR = dataDir;
  process.env.GATEWAY_MASTER_KEY = crypto.randomBytes(32).toString("base64");

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
  const { visibleUpstreamIdsForUser } = await import(
    path.join(gatewayRoot, "src/upstreams/catalog.ts")
  );

  openDb(path.join(dataDir, "gateway.db"));
  const flag = getSqlite()
    .prepare(`SELECT value FROM settings WHERE key = 'schema_personal_first_v1'`)
    .get();
  assert(flag?.value === "1", "schema_personal_first_v1 on fresh open");

  const config = loadConfig();
  config.dataDir = dataDir;
  config.dbPath = path.join(dataDir, "gateway.db");
  config.requireMcpAuth = false;
  const pool = new UpstreamPool(config);
  const router = new ToolRouter(pool);
  const app = createApp(config, pool, router);

  const setup = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "ownerpf",
      password: "owner-pass-12345",
    }),
  });
  assert(setup.status === 201 || setup.status === 200, `setup ${setup.status}`);
  const ownerCookie = cookieFromResponse(setup);
  assert(ownerCookie, "owner cookie");
  const owner = await setup.json();

  const createRes = await app.request("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({
      name: "Forced Personal",
      transport: "stdio",
      command: "true",
      args: [],
      visibility: "shared",
      enabled: true,
      timeoutMs: 2000,
      isolation: "host",
      isolationNetwork: "none",
      authMode: "none",
    }),
  });
  assert(createRes.status === 201, `create ${createRes.status}`);
  const mcp = await createRes.json();
  assert(mcp.visibility === "personal", "create ignores shared → personal");
  assert(mcp.ownerUserId === owner.id, "owner is creator");

  const inviteRes = await app.request("/api/team/invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ role: "member" }),
  });
  const invite = await inviteRes.json();
  const joinRes = await app.request("/api/auth/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: invite.token,
      username: "memberpf",
      password: "member-pass-12345",
    }),
  });
  assert(joinRes.status === 201, `join ${joinRes.status}`);
  const member = await joinRes.json();
  const memberCookie = cookieFromResponse(joinRes);

  const promote = await app.request(`/api/upstreams/${mcp.id}/promote`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert(promote.status === 200, `promote ${promote.status}`);
  const promoted = await promote.json();
  assert(promoted.visibility === "shared", "promote → shared");
  assert(promoted.ownerUserId == null, "promote clears owner");

  const grant = await app.request(`/api/upstreams/${mcp.id}/grants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ userId: member.id }),
  });
  assert(grant.status === 201, `grant ${grant.status}`);
  assert(visibleUpstreamIdsForUser(member.id).has(mcp.id), "member sees");

  const unshare = await app.request(`/api/upstreams/${mcp.id}/unshare`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert(unshare.status === 200, `unshare ${unshare.status}`);
  const mine = await unshare.json();
  assert(mine.visibility === "personal", "unshare → personal");
  assert(mine.ownerUserId === owner.id, "unshare owner = actor");
  assert(!visibleUpstreamIdsForUser(member.id).has(mcp.id), "member loses");

  const grantRows = getSqlite()
    .prepare(`SELECT COUNT(*) AS n FROM upstream_grants WHERE upstream_id = ?`)
    .get(mcp.id);
  assert(grantRows.n === 0, "grants deleted on unshare");

  const memberPromote = await app.request(`/api/upstreams/${mcp.id}/promote`, {
    method: "POST",
    headers: { cookie: memberCookie },
  });
  assert(memberPromote.status === 403, "member cannot promote");

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("verify-personal-first: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
