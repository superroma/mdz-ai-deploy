export interface SyncConfig {
  repoDir: string;
  remote: string;
  branch: string;
  botName: string;
  botEmail: string;
  excludePaths: string[];
  commitDebounceMs: number;
  pollIntervalMs: number;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const repoDir = env.SYNC_REPO_DIR;
  if (!repoDir) throw new Error("SYNC_REPO_DIR is required");
  const excludeRaw = env.SYNC_EXCLUDE ?? ".auth/";
  return {
    repoDir,
    remote: env.SYNC_REMOTE ?? "origin",
    branch: env.SYNC_BRANCH ?? "main",
    botName: env.SYNC_BOT_NAME ?? "mdz-bot",
    botEmail: env.SYNC_BOT_EMAIL ?? "bot@mdz.local",
    excludePaths: excludeRaw.split(",").map((s) => s.trim()).filter(Boolean),
    commitDebounceMs: Number(env.SYNC_DEBOUNCE_MS ?? 5000),
    pollIntervalMs: Number(env.SYNC_POLL_MS ?? 45000),
  };
}
