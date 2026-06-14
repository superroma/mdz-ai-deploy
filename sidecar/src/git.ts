import { execa } from "execa";

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await execa("git", ["-C", cwd, "merge-base", "--is-ancestor", a, b]);
    return true;
  } catch (err: unknown) {
    // exit code 1 means "definitively not an ancestor"; any other code
    // (e.g. 128 for a bad ref) is a real error we must not swallow.
    if ((err as { exitCode?: number }).exitCode === 1) return false;
    throw err;
  }
}
