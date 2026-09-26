/**
 * Verifies elevated grant create/list/revoke API and member 403.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-grants-api.mjs
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-grants-api-"));
  process.env.YUSETU_DATA_DIR = dataDir;
  process.env.GATEWAY_MASTER_KEY = crypto.randomBytes(32).toString("base64");

  const { openDb, closeDb } = await import(
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
      username: "ownerapi",
      password: "owner-pass-12345",
    }),
  });
  assert(setup.status === 201 || setup.status === 200, `setup ${setup.status}`);
  const ownerCookie = cookieFromResponse(setup);
  assert(ownerCookie, "owner cookie");

  const sharedRes = await app.request("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({
      name: "Shared Grants API",
      slug: "shared-grants-api",
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
  assert(sharedRes.status === 201, `create ${sharedRes.status}`);
  const created = await sharedRes.json();
  assert(created.visibility === "personal", "create always personal");
  assert(created.ownerUserId, "create sets ownerUserId");

  const promoteRes = await app.request(`/api/upstreams/${created.id}/promote`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert(promoteRes.status === 200, `promote ${promoteRes.status}`);
  const shared = await promoteRes.json();
  assert(shared.visibility === "shared", "promoted to shared");
  assert(shared.ownerUserId == null, "shared owner null");
  const sharedId = shared.id;

  const inviteRes = await app.request("/api/team/invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
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
      username: "memberapi",
      password: "member-pass-12345",
    }),
  });
  assert(joinRes.status === 201, `join ${joinRes.status}`);
  const member = await joinRes.json();
  const memberCookie = cookieFromResponse(joinRes);
  assert(memberCookie, "member cookie");

  const emptyList = await app.request(`/api/upstreams/${sharedId}/grants`, {
    headers: { cookie: ownerCookie },
  });
  assert(emptyList.status === 200, `list empty ${emptyList.status}`);
  const emptyBody = await emptyList.json();
  assert(Array.isArray(emptyBody) && emptyBody.length === 0, "grants empty");

  const memberCreate = await app.request(`/api/upstreams/${sharedId}/grants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: memberCookie,
    },
    body: JSON.stringify({ userId: member.id }),
  });
  assert(memberCreate.status === 403, `member create ${memberCreate.status}`);

  const create = await app.request(`/api/upstreams/${sharedId}/grants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ userId: member.id }),
  });
  assert(create.status === 201, `create grant ${create.status}`);
  const grant = await create.json();
  assert(grant.userId === member.id, "grant userId");
  assert(grant.username === "memberapi", "grant username");
  assert(grant.upstreamId === sharedId, "grant upstreamId");

  const idempotent = await app.request(`/api/upstreams/${sharedId}/grants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ userId: member.id }),
  });
  assert(idempotent.status === 200, `idempotent create ${idempotent.status}`);

  assert(
    visibleUpstreamIdsForUser(member.id).has(sharedId),
    "member sees shared after grant",
  );

  const listed = await app.request(`/api/upstreams/${sharedId}/grants`, {
    headers: { cookie: ownerCookie },
  });
  const listedBody = await listed.json();
  assert(
    listedBody.some((g) => g.userId === member.id && g.username === "memberapi"),
    "roster includes member",
  );

  const memberList = await app.request("/api/upstreams", {
    headers: { cookie: memberCookie },
  });
  const memberUpstreams = await memberList.json();
  assert(
    memberUpstreams.some((u) => u.id === sharedId),
    "member list includes granted shared",
  );

  const revoke = await app.request(
    `/api/upstreams/${sharedId}/grants/${member.id}`,
    {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    },
  );
  assert(revoke.status === 204, `revoke ${revoke.status}`);

  assert(
    !visibleUpstreamIdsForUser(member.id).has(sharedId),
    "member loses shared after revoke",
  );

  const afterRevoke = await app.request("/api/upstreams", {
    headers: { cookie: memberCookie },
  });
  const afterBody = await afterRevoke.json();
  assert(
    !afterBody.some((u) => u.id === sharedId),
    "member list omits revoked shared",
  );

  const personalRes = await app.request("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({
      name: "Personal No Grants",
      slug: "personal-no-grants",
      transport: "stdio",
      command: "true",
      args: [],
      visibility: "personal",
      enabled: true,
      timeoutMs: 2000,
      isolation: "host",
      isolationNetwork: "none",
      authMode: "none",
    }),
  });
  assert(personalRes.status === 201, `personal ${personalRes.status}`);
  const personal = await personalRes.json();
  const personalGrant = await app.request(
    `/api/upstreams/${personal.id}/grants`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
      },
      body: JSON.stringify({ userId: member.id }),
    },
  );
  assert(personalGrant.status === 400, `personal grant ${personalGrant.status}`);

  // Unshare: shared → personal, grants wiped
  const regrant = await app.request(`/api/upstreams/${sharedId}/grants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
    },
    body: JSON.stringify({ userId: member.id }),
  });
  assert(regrant.status === 201, `regrant ${regrant.status}`);
  assert(
    visibleUpstreamIdsForUser(member.id).has(sharedId),
    "member sees before unshare",
  );

  const unshareRes = await app.request(`/api/upstreams/${sharedId}/unshare`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert(unshareRes.status === 200, `unshare ${unshareRes.status}`);
  const unshared = await unshareRes.json();
  assert(unshared.visibility === "personal", "unshared is personal");
  assert(unshared.ownerUserId, "unshare sets owner");
  assert(
    !visibleUpstreamIdsForUser(member.id).has(sharedId),
    "member loses after unshare",
  );
  const grantsAfterUnshare = await app.request(
    `/api/upstreams/${sharedId}/grants`,
    { headers: { cookie: ownerCookie } },
  );
  assert(
    grantsAfterUnshare.status === 400,
    `grants on personal ${grantsAfterUnshare.status}`,
  );

  const memberUnshare = await app.request(`/api/upstreams/${sharedId}/unshare`, {
    method: "POST",
    headers: { cookie: memberCookie },
  });
  assert(memberUnshare.status === 403, `member unshare ${memberUnshare.status}`);

  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("verify-teams-grants-api: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
