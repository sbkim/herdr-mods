// Harness for done-blink/omo-extension/done-blink-stall.ts: a fake pi (event
// bus + fake hc), a fake ctx carrying a getPauseState snapshot, and the
// hardened scratch home from tools/harness-runner. Every fixture path
// derives from the armed home; the suite never touches a real HOME.
// Handlers await the serialized mutation queue before returning, so awaiting
// each emit is enough — no sleeps.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arm, load, makeScratch } from "./harness-runner";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const home = makeScratch("done-blink-stall-");
arm(home);
const modPath = new URL("../done-blink/omo-extension/done-blink-stall.ts", import.meta.url).pathname;
const mod = (await load(modPath)) as { default: (pi: unknown) => void };

type Handler = (event: unknown, ctx: unknown) => unknown;
type ExecResult = { code: number; stdout: string };
interface FakePi {
  sessionKind?: string;
  sessionContext?: { role?: string };
  on(name: string, handler: Handler): void;
  exec(cmd: string, args: string[], opts?: { timeout?: number }): Promise<ExecResult>;
}

// The fake herdr core: ls lists terminals, and get reports this harness
// process as the foreground program of every listed terminal (the extension
// matches foreground.pid against its own process.pid).
let lsTerminals: Array<{ address: string; agent: string; cwd?: string; state: string }> = [
  { address: "t9", agent: "omo", cwd: process.cwd(), state: "running" },
];
let lsFails = false;

function makePi(opts?: { role?: string; sessionKind?: string }): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const pi: FakePi = {
    sessionKind: opts?.sessionKind ?? "tui",
    sessionContext: opts?.role ? { role: opts.role } : undefined,
    on(name, handler) {
      handlers.set(name, handler);
    },
    async exec(cmd, args) {
      if (cmd !== "hc") return { code: 1, stdout: "" };
      if (lsFails) return { code: 1, stdout: "" };
      if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ terminals: lsTerminals }) };
      if (args[0] === "get") {
        const t = lsTerminals.find((x) => x.address === args[1]);
        if (t) return { code: 0, stdout: JSON.stringify({ foreground: { pid: process.pid } }) };
      }
      return { code: 1, stdout: "" };
    },
  };
  mod.default(pi);
  return handlers;
}

const snapCtx = (holds: unknown) => ({ getPauseState: () => ({ pauseSeq: 1, holds }) });
const noSnapCtx = () => ({});
const emit = async (handlers: Map<string, Handler>, name: string, event: unknown, ctx: unknown) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`no handler for ${name}`);
  await h(event, ctx);
};

const stallDir = join(home, ".config/herdr-app/data/stall");
const markerOf = (addr: string) => join(stallDir, encodeURIComponent(addr) + ".json");
const UNATTENDED = { kind: "unattended", key: "unattended" };
const USER_STOP = { kind: "session_hold", key: "default" };

console.log("done-blink-stall harness — scratch home:", home);

// 0. naming rule: never match herdr-* (builtin reporter deferral)
{
  const base = modPath.split("/").pop()!;
  check("0 file name does not match herdr-*.ts/.js/.mjs", !/^herdr-.*\.(ts|js|mjs)$/.test(base), base);
}

// 1. stall enter: paused + unattended hold -> marker with shape and modes
{
  console.log("case 1: stall enter");
  const handlers = makePi();
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED] }, snapCtx([UNATTENDED]));
  const file = markerOf("t9");
  check("1.1 marker file exists", existsSync(file), file);
  const j = JSON.parse(readFileSync(file, "utf8"));
  check("1.2 v=1", j.v === 1);
  check("1.3 address=t9 canonical", j.address === "t9");
  check("1.4 state=waiting_human", j.state === "waiting_human");
  check("1.5 since is ISO", !Number.isNaN(Date.parse(j.since)), String(j.since));
  check("1.6 pid recorded", j.pid === process.pid, String(j.pid));
  check("1.7 file mode 0600", (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
  check("1.8 dir mode 0700", (statSync(stallDir).mode & 0o777) === 0o700, (statSync(stallDir).mode & 0o777).toString(8));
  check("1.9 no tmp leftovers", !existsSync(file + "." + process.pid + ".tmp"));
}

// 2. resume clears the marker
{
  console.log("case 2: resume clears");
  const handlers = makePi();
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 2, holds: [UNATTENDED] }, snapCtx([UNATTENDED]));
  check("2.1 marker present before resume", existsSync(markerOf("t9")));
  await emit(handlers, "session_hold_changed", { change: "resumed", pauseSeq: 3, holds: [] }, snapCtx([]));
  check("2.2 marker gone after resume", !existsSync(markerOf("t9")));
}

// 3. user stop (session_hold only) never lights
{
  console.log("case 3: user stop is not a stall");
  const handlers = makePi();
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [USER_STOP] }, snapCtx([USER_STOP]));
  check("3.1 no marker for a user Stop", !existsSync(markerOf("t9")));
}

// 4. the ctx snapshot wins over the event payload, both directions
{
  console.log("case 4: snapshot precedence");
  const a = makePi();
  await emit(a, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [USER_STOP] }, snapCtx([UNATTENDED]));
  check("4.1 snapshot unattended lights despite event session_hold", existsSync(markerOf("t9")));
  await emit(a, "session_hold_changed", { change: "resumed", pauseSeq: 2, holds: [] }, snapCtx([]));
  const b = makePi();
  await emit(b, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED] }, snapCtx([USER_STOP]));
  check("4.2 snapshot session_hold stays dark despite event unattended", !existsSync(markerOf("t9")));
  const c = makePi();
  await emit(c, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED] }, noSnapCtx());
  check("4.3 event payload used when ctx has no snapshot", existsSync(markerOf("t9")));
  await emit(c, "session_hold_changed", { change: "resumed", pauseSeq: 2 }, noSnapCtx());
}

// 5. resolution failure: no marker, retried on the next event (never cached)
{
  console.log("case 5: resolution miss retried");
  const handlers = makePi();
  lsFails = true;
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED] }, snapCtx([UNATTENDED]));
  check("5.1 no marker while unresolved", !existsSync(markerOf("t9")));
  lsFails = false;
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 2, holds: [UNATTENDED] }, snapCtx([UNATTENDED]));
  check("5.2 next event resolves and writes", existsSync(markerOf("t9")));
  await emit(handlers, "session_hold_changed", { change: "resumed", pauseSeq: 3, holds: [] }, snapCtx([]));
}

// 6. role guard: worker / child / dag_child / member never register handlers
{
  console.log("case 6: role guard");
  for (const opts of [{ role: "child" }, { role: "dag_child" }, { role: "member" }, { sessionKind: "worker" }]) {
    const handlers = makePi(opts);
    check(`6 guard ${JSON.stringify(opts)} registers no handlers`, handlers.size === 0, [...handlers.keys()].join(","));
  }
}

// 7. omo restart while stalled: session_start baseline rewrites the marker
{
  console.log("case 7: restart reconciliation");
  const stale = markerOf("t9");
  mkdirSync(stallDir, { recursive: true, mode: 0o700 });
  writeFileSync(stale, JSON.stringify({ v: 1, address: "t9", since: "2000-01-01T00:00:00.000Z", state: "waiting_human", pid: process.pid }) + "\n", { mode: 0o600 });
  const handlers = makePi();
  await emit(handlers, "session_start", { reason: "startup" }, snapCtx([UNATTENDED]));
  const j = JSON.parse(readFileSync(stale, "utf8"));
  check("7.1 baseline rewrites marker (since refreshed)", Date.parse(j.since) > Date.parse("2000-01-01T00:00:00.000Z"), String(j.since));
  await emit(handlers, "session_hold_changed", { change: "resumed", pauseSeq: 2, holds: [] }, snapCtx([]));
}

// 8. dead-writer sweep: markers of exited omos go, live writers stay
{
  console.log("case 8: dead-writer sweep");
  const exited = spawnSync("/bin/sh", ["-c", "exit 0"]); // its pid is gone after the call
  const live = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  const deadFile = markerOf("t8");
  const liveFile = markerOf("t7");
  const malformed = markerOf("t6");
  const noshape = markerOf("t5");
  const fixtures: [string, string][] = [
    [deadFile, JSON.stringify({ v: 1, address: "t8", since: "2000-01-01T00:00:00.000Z", state: "waiting_human", pid: exited.pid })],
    [liveFile, JSON.stringify({ v: 1, address: "t7", since: "2000-01-01T00:00:00.000Z", state: "waiting_human", pid: live.pid! })],
    [malformed, "{not json"],
    [noshape, JSON.stringify({ v: 1, address: "t5" })],
  ];
  for (const [f, body] of fixtures) writeFileSync(f, body + "\n", { mode: 0o600 });
  const handlers = makePi();
  await emit(handlers, "session_start", { reason: "startup" }, snapCtx([]));
  check("8.1 dead writer's marker removed", !existsSync(deadFile));
  check("8.2 live writer's marker kept", existsSync(liveFile));
  check("8.3 malformed marker kept", existsSync(malformed));
  check("8.4 marker without pid kept", existsSync(noshape));
  live.kill("SIGKILL");
}

// 9. message_end reconcile: partial release (unattended gone, Stop remains)
{
  console.log("case 9: message_end reconcile");
  const handlers = makePi();
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED, USER_STOP] }, snapCtx([UNATTENDED, USER_STOP]));
  check("9.1 unattended among other holds lights", existsSync(markerOf("t9")));
  // the prompt released the unattended hold; the Stop still pauses the
  // session, so no session_hold_changed fires — but a message_end does
  await emit(handlers, "message_end", { message: { role: "user", content: "go on" } }, snapCtx([USER_STOP]));
  check("9.2 message_end clears when no unattended hold remains", !existsSync(markerOf("t9")));
}

// 10. remote address encoding stays flat
{
  console.log("case 10: remote address encoding");
  lsTerminals = [{ address: "vps/t7", agent: "omo", cwd: process.cwd(), state: "running" }];
  const handlers = makePi();
  await emit(handlers, "session_hold_changed", { change: "paused", pauseSeq: 1, holds: [UNATTENDED] }, snapCtx([UNATTENDED]));
  check("10.1 remote address percent-encoded flat", existsSync(join(stallDir, "vps%2Ft7.json")));
  await emit(handlers, "session_hold_changed", { change: "resumed", pauseSeq: 2, holds: [] }, snapCtx([]));
  lsTerminals = [{ address: "t9", agent: "omo", cwd: process.cwd(), state: "running" }];
}

// 11. malformed event payloads never throw into the host
{
  console.log("case 11: malformed payloads");
  const handlers = makePi();
  let threw = false;
  try {
    await emit(handlers, "session_hold_changed", {}, snapCtx(undefined));
    await emit(handlers, "session_hold_changed", { change: "paused", holds: "not-an-array" }, noSnapCtx());
    await emit(handlers, "session_hold_changed", { change: 42 }, snapCtx([{}]));
    await emit(handlers, "session_start", null as unknown as {}, null);
    await emit(handlers, "message_end", { message: null }, undefined);
  } catch (e) {
    threw = true;
    console.log("    threw:", e);
  }
  check("11.1 malformed payloads never throw", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
