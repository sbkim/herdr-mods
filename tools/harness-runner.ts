// Hardened test runner for the rename-history extension. Order is the whole
// safety contract: (1) locate a scratch home under canonical /tmp, (2) verify
// it by realpath (no symlink indirection), (3) set HOME, (4) only then
// dynamically import the module under test. The suite must derive every
// fixture and cleanup path from the returned home.
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

const CANON = realpathSync("/tmp"); // one canonical root on macOS (/private/tmp)
export function makeScratch(prefix = "rh-hardened-"): string {
  const home = mkdtempSync(CANON + "/" + prefix);
  const realHome = realpathSync(home);
  if (realHome !== home) throw new Error("scratch home is a symlink: refusing");
  return home;
}
export function arm(home: string): void {
  if (realpathSync(home) !== home || !home.startsWith(CANON + "/")) throw new Error("scratch home not under canonical /tmp: refusing");
  if (home === homedir()) throw new Error("refusing to run against the real HOME");
  process.env.HOME = home;
}
export async function load(modPath: string): Promise<unknown> {
  if (!process.env.HOME || realpathSync(process.env.HOME) !== process.env.HOME || !process.env.HOME.startsWith(CANON + "/")) {
    throw new Error("HOME not armed; refusing to import");
  }
  return await import(modPath);
}
