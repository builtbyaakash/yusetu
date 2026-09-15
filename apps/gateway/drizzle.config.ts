import { defineConfig } from "drizzle-kit";
import path from "node:path";

const dataDir = process.env.YUSETU_DATA_DIR ?? path.resolve("../../data");
const dbPath = path.join(dataDir, "gateway.db");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
