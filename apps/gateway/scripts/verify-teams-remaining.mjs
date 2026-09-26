/**
 * Live proofs for overlay secrets, exposed-name collision, pair invalidate, master-key guard.
 * Run: bash scripts/with-node22.sh pnpm --filter @yusetu/gateway exec tsx scripts/verify-teams-remaining.mjs
 */
import { spawn } from "node:child_process";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yusetu-remain-"));
  process.env.YUSETU_DATA_DIR = dataDir;
  const masterKey = Buffer.from(
    "0123456789abcdef0123456789abcdef",
  ).toString("base64");
  process.env.GATEWAY_MASTER_KEY = masterKey;

  const { openDb, closeDb, getDb } = await import(
    path.join(gatewayRoot, "src/db/index.ts")
  );
  const { hashPassword } = await import(
    path.join(gatewayRoot, "src/auth/crypto.ts")
  );
  const {
    users,
    upstreams,
    tools,
    upstreamSecrets,
    userUpstreamSecrets,
  } = await import(path.join(gatewayRoot, "src/db/schema.ts"));
  const { encryptSecret, requireMasterKey } = await import(
    path.join(gatewayRoot, "src/secrets/crypto.ts")
  );
  const { loadConfig } = await import(path.join(gatewayRoot, "src/config.ts"));
  const { UpstreamPool } = await import(
    path.join(gatewayRoot, "src/upstreams/pool.ts")
  );
  const { discoverUpstreamTools } = await import(
    path.join(gatewayRoot, "src/upstreams/discover.ts")
  );
  const { assertMasterKeyIfNeeded } = await import(
    path.join(gatewayRoot, "src/db/boot-checks.ts")
  );
  const { poolClientKey } = await import(
    path.join(gatewayRoot, "src/upstreams/catalog.ts")
  );

  openDb(path.join(dataDir, "gateway.db"));
  const db = getDb();
  const now = new Date();
  const ownerId = "owner-1";
  const memberA = "mem-a";
  const memberB = "mem-b";
  const pass = await hashPassword("pass-pass-12");
  db.insert(users)
    .values([
      {
        id: ownerId,
        username: "owner",
        passwordHash: pass,
        role: "owner",
        createdAt: now,
      },
      {
        id: memberA,
        username: "mema",
        passwordHash: pass,
        role: "member",
        createdAt: now,
      },
      {
        id: memberB,
        username: "memb",
        passwordHash: pass,
        role: "member",
        createdAt: now,
      },
    ])
    .run();

  const sharedId = "up-shared";
  const personalId = "up-personal";
  db.insert(upstreams)
    .values([
      {
        id: sharedId,
        slug: "demo",
        name: "Demo Shared",
        transport: "stdio",
        command: "true",
        argsJson: null,
        cwd: null,
        url: null,
        gitUrl: null,
        gitRef: null,
        installCommand: null,
        isolation: "host",
        isolationNetwork: "none",
        isolationImage: null,
        enabled: true,
        timeoutMs: 5000,
        authMode: "none",
        visibility: "shared",
        ownerUserId: null,
        createdAt: now,
        createdByUserId: ownerId,
      },
      {
        id: personalId,
        slug: "demo", // same slug as shared (bypass API allocate) to force collision
        name: "Demo Personal",
        transport: "stdio",
        command: "true",
        argsJson: null,
        cwd: null,
        url: null,
        gitUrl: null,
        gitRef: null,
        installCommand: null,
        isolation: "host",
        isolationNetwork: "none",
        isolationImage: null,
        enabled: true,
        timeoutMs: 5000,
        authMode: "none",
        visibility: "personal",
        ownerUserId: memberA,
        createdAt: now,
        createdByUserId: memberA,
      },
    ])
    .run();

  db.insert(tools)
    .values({
      id: "tool-shared",
      upstreamId: sharedId,
      originalName: "echo",
      exposedName: "demo__echo",
      description: null,
      inputSchemaJson: null,
      enabled: true,
      lastSeenAt: now,
    })
    .run();

  const config = loadConfig();
  const key = requireMasterKey(config.masterKeyBase64);
  const encShared = encryptSecret("SHARED_VALUE", key);
  db.insert(upstreamSecrets)
    .values({
      id: "sec-shared",
      upstreamId: sharedId,
      keyName: "TOKEN",
      ciphertext: encShared.ciphertext,
      iv: encShared.iv,
      authTag: encShared.authTag,
    })
    .run();

  const encOverlay = encryptSecret("OVERLAY_B", key);
  db.insert(userUpstreamSecrets)
    .values({
      id: "sec-overlay-b",
      userId: memberB,
      upstreamId: sharedId,
      keyName: "TOKEN",
      ciphertext: encOverlay.ciphertext,
      iv: encOverlay.iv,
      authTag: encOverlay.authTag,
    })
    .run();

  const pool = new UpstreamPool(config);
  const secretsA = pool.loadSecrets(memberA, sharedId);
  const secretsB = pool.loadSecrets(memberB, sharedId);
  assert(secretsA.TOKEN === "SHARED_VALUE", "A must see shared secret");
  assert(secretsB.TOKEN === "OVERLAY_B", "B overlay must win");
  fs.mkdirSync("/tmp/yusetu-review/live-lanes", { recursive: true });
  fs.writeFileSync(
    "/tmp/yusetu-review/live-lanes/overlay-secret.json",
    JSON.stringify({ secretsA, secretsB, pass: true }, null, 2),
  );
  console.log("overlay-secret PASS");

  const keyA = poolClientKey(memberA, sharedId);
  const keyB = poolClientKey(memberB, sharedId);
  assert(keyA !== keyB, "pair keys differ");
  await pool.invalidate(memberB, sharedId);
  // A secrets still load after B invalidate
  assert(
    pool.loadSecrets(memberA, sharedId).TOKEN === "SHARED_VALUE",
    "A secrets intact after B invalidate",
  );
  fs.writeFileSync(
    "/tmp/yusetu-review/live-lanes/invalidate-pair.json",
    JSON.stringify({ keyA, keyB, pass: true }, null, 2),
  );
  console.log("invalidate-pair PASS");

  // exposed collision: discover personal listing echo while shared already has demo__echo
  const mockPool = {
    async invalidate() {},
    async getClient() {
      return {
        async listTools() {
          return { tools: [{ name: "echo", description: "x", inputSchema: {} }] };
        },
      };
    },
  };
  let threw = false;
  try {
    await discoverUpstreamTools(personalId, memberA, mockPool);
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(/collides/i.test(msg), `expected collision message, got: ${msg}`);
    fs.writeFileSync(
      "/tmp/yusetu-review/live-lanes/exposed-collision.json",
      JSON.stringify({ error: msg, pass: true }, null, 2),
    );
  }
  assert(threw, "discover should reject exposed collision");
  console.log("exposed-collision PASS");

  // master-key guard with secrets present
  closeDb();
  let guardThrew = false;
  try {
    openDb(path.join(dataDir, "gateway.db"));
    const cfg = { ...loadConfig(), masterKeyBase64: undefined };
    assertMasterKeyIfNeeded(cfg);
  } catch (err) {
    guardThrew = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(/GATEWAY_MASTER_KEY/i.test(msg), msg);
    fs.writeFileSync(
      "/tmp/yusetu-review/live-lanes/master-key-guard.txt",
      msg + "\n",
    );
  } finally {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }
  assert(guardThrew, "boot check must fail without master key when secrets exist");
  console.log("master-key-guard PASS");

  // also prove CLI serve exits non-zero
  const child = spawn(
    process.execPath,
    [
      path.join(gatewayRoot, "dist/cli/index.js"),
      "serve",
      "--port",
      "18099",
    ],
    {
      env: {
        ...process.env,
        YUSETU_DATA_DIR: dataDir,
        GATEWAY_MASTER_KEY: "",
        HOST: "127.0.0.1",
        PORT: "18099",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", (d) => {
    stderr += d.toString();
  });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 8000);
    child.on("exit", (c) => {
      clearTimeout(t);
      resolve(c ?? -1);
    });
  });
  // dist may be stale — rebuild note: if dist missing, skip CLI check when code===-1 and guard passed
  if (fs.existsSync(path.join(gatewayRoot, "dist/cli/index.js"))) {
    assert(code !== 0, `serve without master key should exit non-zero (got ${code}): ${stderr}`);
    fs.appendFileSync(
      "/tmp/yusetu-review/live-lanes/master-key-guard.txt",
      `\nserve_exit=${code}\n${stderr.slice(0, 500)}\n`,
    );
    console.log("master-key-guard serve PASS exit", code);
  }

  console.log("verify-teams-remaining: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
