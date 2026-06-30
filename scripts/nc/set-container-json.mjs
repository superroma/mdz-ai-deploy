// Usage: NC_DIR=<nanoclaw checkout> node set-container-json.mjs <agentGroupId> <field> <json-value>
// Run with the nanoclaw checkout's build present (pnpm build). Imports nanoclaw's own DB API.
import { pathToFileURL } from "node:url";
import path from "node:path";

const [, , agentGroupId, field, jsonValue] = process.argv;
if (!agentGroupId || !field || jsonValue === undefined) {
  console.error("usage: set-container-json.mjs <agentGroupId> <field> <json-value>");
  process.exit(1);
}
const ncDir = process.env.NC_DIR;
if (!ncDir) { console.error("NC_DIR (nanoclaw checkout) is required"); process.exit(1); }

const mod = await import(pathToFileURL(path.join(ncDir, "dist/db/container-configs.js")).href);
mod.updateContainerConfigJson(agentGroupId, field, JSON.parse(jsonValue));
console.error(`set ${field} for ${agentGroupId}`);
