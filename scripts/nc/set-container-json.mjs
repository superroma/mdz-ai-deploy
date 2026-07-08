// Usage: NC_DIR=<nanoclaw checkout> node set-container-json.mjs <agentGroupId> <field> <json-value>
// Run with the nanoclaw checkout's build present (its own /setup builds dist). Imports
// nanoclaw's DB API and writes the central DB directly (WAL — safe alongside the running host).
import { pathToFileURL } from "node:url";
import path from "node:path";

const [, , agentGroupId, field, jsonValue] = process.argv;
if (!agentGroupId || !field || jsonValue === undefined) {
  console.error("usage: set-container-json.mjs <agentGroupId> <field> <json-value>");
  process.exit(1);
}
const ncDir = process.env.NC_DIR;
if (!ncDir) { console.error("NC_DIR (nanoclaw checkout) is required"); process.exit(1); }

const imp = (rel) => import(pathToFileURL(path.join(ncDir, rel)).href);

// The DB layer needs initDb() before getDb() works in a standalone process. The central DB
// lives under the nanoclaw checkout at <NC_DIR>/data/v2.db (do NOT use config.DATA_DIR — it
// is CWD-relative and would point at a spurious empty DB when we run from elsewhere).
const conn = await imp("dist/db/connection.js");
conn.initDb(path.join(ncDir, "data", "v2.db"));

const mod = await imp("dist/db/container-configs.js");
// nanoclaw v2 creates the container_configs row lazily (on first spawn), so a freshly
// created group has none — and updateContainerConfigJson is an UPDATE (a silent no-op on a
// missing row). Ensure it exists first (idempotent INSERT OR IGNORE).
mod.ensureContainerConfig(agentGroupId);
mod.updateContainerConfigJson(agentGroupId, field, JSON.parse(jsonValue));
console.error(`set ${field} for ${agentGroupId}`);
