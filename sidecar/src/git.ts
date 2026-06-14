import { execa } from "execa";

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await execa("git", ["-C", cwd, "merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}
