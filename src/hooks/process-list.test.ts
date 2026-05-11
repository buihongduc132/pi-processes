import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "../registry";
import { HeartbeatManager } from "../heartbeat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-pl-test-"));
}

function makeProcess(overrides: Partial<{
  name: string;
  command: string;
  status: string;
  pid: number;
  startTime: number;
  tags: string[];
  labels: string[];
}> = {}) {
  return {
    name: overrides.name ?? "test-proc",
    command: overrides.command ?? "echo hi",
    status: overrides.status ?? "running",
    pid: overrides.pid ?? 12345,
    startTime: overrides.startTime ?? Date.now(),
    tags: overrides.tags ?? [],
    labels: overrides.labels ?? [],
  };
}

// Lazy import so tests register with vitest even though module doesn't exist
// yet. Each test will FAIL at the assertion level because ProcessLister
// cannot be imported.
let ProcessLister: any;
let ProcessSummary: any;
try {
  const mod = await import("./process-list");
  ProcessLister = mod.ProcessLister;
} catch {
  ProcessLister = undefined;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ProcessLister", () => {
  let tmp: string;
  let registryPath: string;

  beforeEach(() => {
    tmp = makeTempDir();
    registryPath = join(tmp, "registry.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // =========================================================================
  // WORST-FIRST (complex)
  // =========================================================================

  // -------------------------------------------------------------------------
  // a) WORST-FIRST: session_start with stale registry entries from crashed
  //    session — should show stale as terminated, current as running
  // -------------------------------------------------------------------------
  it("shows stale crashed-session processes as terminated, current session as running", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session "crashed" has a running process but NO heartbeat (stale)
    reg.write("ses_crashed", cwd, {
      proc_old: makeProcess({ name: "old-server", status: "running" }),
    });

    // Current session has a running process with heartbeat
    reg.write("ses_current", cwd, {
      proc_new: makeProcess({ name: "new-server", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 5000 });
    hb.heartbeat("ses_current", cwd);

    // Prune stale — crashed session processes become terminated
    const originalNow = Date.now;
    const baseTime = Date.now();
    // eslint-disable-next-line no-global-assign
    Date.now = () => baseTime + 10_000;

    try {
      hb.pruneStale(cwd);

      const lister = new ProcessLister(reg, hb);
      const summary = lister.getSummary(cwd, "ses_current");

      // Current session: running process visible
      expect(summary.current.running).toHaveLength(1);
      expect(summary.current.running[0].name).toBe("new-server");

      // Sibling (crashed): its process should appear as terminated
      expect(summary.siblings.running).toHaveLength(0);
      expect(summary.siblings.recentCompleted).toHaveLength(1);
      expect(summary.siblings.recentCompleted[0].name).toBe("old-server");
      expect(summary.siblings.recentCompleted[0].status).toBe("terminated");
    } finally {
      // eslint-disable-next-line no-global-assign
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // b) WORST-FIRST: multiple sessions in same cwd returning different views
  //    — session A sees its processes + sibling B's processes
  // -------------------------------------------------------------------------
  it("returns different views for different sessions in same cwd", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session A: 1 running, 1 completed
    reg.write("ses_A", cwd, {
      proc_a1: makeProcess({ name: "a-server", status: "running" }),
      proc_a2: makeProcess({ name: "a-build", status: "exited" }),
    });

    // Session B: 1 running
    reg.write("ses_B", cwd, {
      proc_b1: makeProcess({ name: "b-test", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_A", cwd);
    hb.heartbeat("ses_B", cwd);

    const lister = new ProcessLister(reg, hb);

    // View from session A
    const summaryA = lister.getSummary(cwd, "ses_A");
    expect(summaryA.current.running).toHaveLength(1);
    expect(summaryA.current.running[0].name).toBe("a-server");
    expect(summaryA.current.lastCompleted).not.toBeNull();
    expect(summaryA.current.lastCompleted!.name).toBe("a-build");

    // Siblings for A = B's processes
    expect(summaryA.siblings.running).toHaveLength(1);
    expect(summaryA.siblings.running[0].name).toBe("b-test");
    expect(summaryA.siblings.recentCompleted).toHaveLength(0);

    // View from session B
    const summaryB = lister.getSummary(cwd, "ses_B");
    expect(summaryB.current.running).toHaveLength(1);
    expect(summaryB.current.running[0].name).toBe("b-test");
    expect(summaryB.current.lastCompleted).toBeNull();

    // Siblings for B = A's processes
    expect(summaryB.siblings.running).toHaveLength(1);
    expect(summaryB.siblings.running[0].name).toBe("a-server");
    // A's completed process should appear in siblings.recentCompleted
    expect(summaryB.siblings.recentCompleted).toHaveLength(1);
    expect(summaryB.siblings.recentCompleted[0].name).toBe("a-build");
  });

  // =========================================================================
  // CORE
  // =========================================================================

  // -------------------------------------------------------------------------
  // c) returns empty summary for session with no processes
  // -------------------------------------------------------------------------
  it("returns empty summary for session with no processes", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    const lister = new ProcessLister(reg, hb);

    const summary = lister.getSummary(cwd, "ses_empty");

    expect(summary.current.running).toEqual([]);
    expect(summary.current.lastCompleted).toBeNull();
    expect(summary.siblings.running).toEqual([]);
    expect(summary.siblings.recentCompleted).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // d) returns running processes for current session
  // -------------------------------------------------------------------------
  it("returns running processes for current session", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_001", cwd, {
      proc_1: makeProcess({ name: "dev-server", status: "running" }),
      proc_2: makeProcess({ name: "watcher", status: "running" }),
      proc_3: makeProcess({ name: "build-done", status: "exited" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_001", cwd);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwd, "ses_001");

    expect(summary.current.running).toHaveLength(2);
    const names = summary.current.running.map((p: any) => p.name);
    expect(names).toContain("dev-server");
    expect(names).toContain("watcher");
  });

  // -------------------------------------------------------------------------
  // e) returns last completed process for current session
  // -------------------------------------------------------------------------
  it("returns last completed process for current session", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    const earlier = Date.now() - 5000;
    const later = Date.now() - 1000;

    reg.write("ses_001", cwd, {
      proc_old: makeProcess({ name: "old-build", status: "exited", startTime: earlier }),
      proc_new: makeProcess({ name: "new-build", status: "exited", startTime: later }),
      proc_run: makeProcess({ name: "server", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_001", cwd);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwd, "ses_001");

    // lastCompleted = the most recently exited process (by startTime)
    expect(summary.current.lastCompleted).not.toBeNull();
    expect(summary.current.lastCompleted!.name).toBe("new-build");
  });

  // -------------------------------------------------------------------------
  // f) includes sibling session processes in same cwd
  // -------------------------------------------------------------------------
  it("includes sibling session processes in same cwd", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_A", cwd, {
      proc_a: makeProcess({ name: "a-proc", status: "running" }),
    });

    reg.write("ses_B", cwd, {
      proc_b: makeProcess({ name: "b-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_A", cwd);
    hb.heartbeat("ses_B", cwd);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwd, "ses_A");

    expect(summary.siblings.running).toHaveLength(1);
    expect(summary.siblings.running[0].name).toBe("b-proc");
  });

  // -------------------------------------------------------------------------
  // g) excludes processes from other cwds
  // -------------------------------------------------------------------------
  it("excludes processes from other cwds", () => {
    const cwdA = "/abs/project-a";
    const cwdB = "/abs/project-b";
    const reg = new Registry(registryPath);

    reg.write("ses_A", cwdA, {
      proc_a: makeProcess({ name: "a-proc", status: "running" }),
    });

    reg.write("ses_B", cwdB, {
      proc_b: makeProcess({ name: "b-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_A", cwdA);
    hb.heartbeat("ses_B", cwdB);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwdA, "ses_A");

    // Only cwdA processes should appear
    expect(summary.current.running).toHaveLength(1);
    expect(summary.current.running[0].name).toBe("a-proc");
    expect(summary.siblings.running).toHaveLength(0);
    expect(summary.siblings.recentCompleted).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // h) handles session with no registered entry (new session)
  // -------------------------------------------------------------------------
  it("handles session with no registered entry (new session)", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Other session exists in same cwd
    reg.write("ses_existing", cwd, {
      proc_x: makeProcess({ name: "existing-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_existing", cwd);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwd, "ses_new_unregistered");

    // Current session has nothing
    expect(summary.current.running).toEqual([]);
    expect(summary.current.lastCompleted).toBeNull();

    // But can still see sibling
    expect(summary.siblings.running).toHaveLength(1);
    expect(summary.siblings.running[0].name).toBe("existing-proc");
  });

  // -------------------------------------------------------------------------
  // i) returns terminated processes from stale sessions
  // -------------------------------------------------------------------------
  it("returns terminated processes from stale sessions as sibling completed", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Stale session with running process (no heartbeat)
    reg.write("ses_stale", cwd, {
      proc_stale: makeProcess({ name: "stale-runner", status: "running" }),
    });

    // Current session is alive
    reg.write("ses_current", cwd, {
      proc_cur: makeProcess({ name: "current-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 5000 });
    hb.heartbeat("ses_current", cwd);

    // Advance time past TTL
    const originalNow = Date.now;
    const baseTime = Date.now();
    // eslint-disable-next-line no-global-assign
    Date.now = () => baseTime + 10_000;

    try {
      hb.pruneStale(cwd);

      const lister = new ProcessLister(reg, hb);
      const summary = lister.getSummary(cwd, "ses_current");

      // Stale session's process should now be terminated and appear in
      // siblings.recentCompleted
      expect(summary.siblings.recentCompleted).toHaveLength(1);
      expect(summary.siblings.recentCompleted[0].name).toBe("stale-runner");
      expect(summary.siblings.recentCompleted[0].status).toBe("terminated");
    } finally {
      // eslint-disable-next-line no-global-assign
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // j) summary includes process count and status breakdown
  // -------------------------------------------------------------------------
  it("summary includes process count and status breakdown", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_001", cwd, {
      proc_1: makeProcess({ name: "server", status: "running" }),
      proc_2: makeProcess({ name: "build", status: "exited" }),
      proc_3: makeProcess({ name: "lint", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_001", cwd);

    const lister = new ProcessLister(reg, hb);
    const summary = lister.getSummary(cwd, "ses_001");

    // Verify counts
    expect(summary.current.running).toHaveLength(2);
    expect(summary.current.lastCompleted).not.toBeNull();
    expect(summary.current.lastCompleted!.name).toBe("build");

    // Status breakdown via the running array
    const runningStatuses = summary.current.running.map((p: any) => p.status);
    expect(runningStatuses.every((s: string) => s === "running")).toBe(true);
    expect(summary.current.lastCompleted!.status).toBe("exited");
  });
});
