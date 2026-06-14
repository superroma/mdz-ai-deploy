import chokidar from "chokidar";
import { join, sep } from "node:path";
import { loadConfigFromEnv } from "./config.js";
import { ensureExclusions, createSyncer } from "./sync.js";

async function main() {
  const cfg = loadConfigFromEnv();
  await ensureExclusions(cfg);
  const syncer = createSyncer(cfg);

  console.log(`[sidecar] watching ${cfg.repoDir} (debounce ${cfg.commitDebounceMs}ms, poll ${cfg.pollIntervalMs}ms)`);

  // initial reconcile on startup
  await syncer.request();

  // poll the remote
  setInterval(() => { void syncer.request(); }, cfg.pollIntervalMs);

  // watch local changes (ignore the .git dir), debounce, then sync
  let timer: NodeJS.Timeout | undefined;
  const gitDir = join(cfg.repoDir, ".git");
  const watcher = chokidar.watch(cfg.repoDir, {
    ignored: (p: string) => p === gitDir || p.startsWith(gitDir + sep),
    ignoreInitial: true,
  });
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncer.request(); }, cfg.commitDebounceMs);
  });

  const shutdown = () => {
    if (timer) clearTimeout(timer); // don't let a debounced sync race process.exit
    void watcher.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error("[sidecar] fatal", err); process.exit(1); });
