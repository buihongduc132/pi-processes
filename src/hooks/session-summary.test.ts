import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "../registry";
import { HeartbeatManager } from "../heartbeat";
import { ProcessLister } from "./process-list";
import { SubscriberIndex } from "../subscriber-index";
import type { WatchSubscription } from "../subscriber-index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ss-test-"));
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

// Lazy import — the implementation module does NOT exist yet.
// Each test will FAIL because SessionSummaryHook cannot be imported.
let SessionSummaryHook: any;
try {
  const mod = await import("./session-summary");
  SessionSummaryHook = mod.SessionSummaryHook;
} catch {
  SessionSummaryHook = undefined;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SessionSummaryHook", () => {
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
  // WORST-FIRST
  // =========================================================================

  // -------------------------------------------------------------------------
  // (a) WORST-FIRST: session_start with empty registry — clean slate,
  //     returns summary with empty arrays
  // -------------------------------------------------------------------------
  it("session_start with empty registry returns summary with empty arrays", () => {
    const cwd = "/abs/project-empty";
    const reg = new Registry(registryPath);
    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);
    const result = hook.onSessionStart(cwd, "ses_new");

    // Clean slate: no current or sibling processes
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");

    // Parse the summary back from the formatted string to verify content
    expect(result).toContain("0 running");
    expect(result).toContain("0 terminated");
    expect(result).not.toContain("sibling");
  });

  // -------------------------------------------------------------------------
  // (b) WORST-FIRST: turn_end with 3 stale + 2 active processes — correct
  //     summary showing 2 running + 3 terminated, heartbeat refreshed
  // -------------------------------------------------------------------------
  it("turn_end with 3 stale + 2 active processes: correct summary counts and heartbeat refresh", () => {
    const cwd = "/abs/project-mixed";
    const reg = new Registry(registryPath);

    // Current session with 2 active processes
    reg.write("ses_current", cwd, {
      proc_active_1: makeProcess({ name: "dev-server", status: "running" }),
      proc_active_2: makeProcess({ name: "watcher", status: "running" }),
    });

    // 3 stale sessions each with one running process (no heartbeat → stale)
    reg.write("ses_stale_1", cwd, {
      proc_stale_1: makeProcess({ name: "old-server-1", status: "running" }),
    });
    reg.write("ses_stale_2", cwd, {
      proc_stale_2: makeProcess({ name: "old-server-2", status: "running" }),
    });
    reg.write("ses_stale_3", cwd, {
      proc_stale_3: makeProcess({ name: "old-server-3", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 5000 });

    // Heartbeat for current session only — stale sessions have none
    hb.heartbeat("ses_current", cwd);
    const heartbeatTime = Date.now();

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);

    // Advance time past TTL so stale sessions expire
    const originalNow = Date.now;
    const baseTime = Date.now();
    // eslint-disable-next-line no-global-assign
    Date.now = () => baseTime + 10_000;

    try {
      const result = hook.onTurnEnd(cwd, "ses_current");

      // Summary string should reflect: 2 running + 3 terminated
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain("2 running");
      expect(result).toContain("3 terminated");

      // Heartbeat should have been refreshed for the current session
      const session = reg.readSession(cwd, "ses_current");
      expect(session).not.toBeNull();
      expect(session!.lastHeartbeatAt).toBeGreaterThanOrEqual(heartbeatTime);
    } finally {
      // eslint-disable-next-line no-global-assign
      Date.now = originalNow;
    }
  });

  // =========================================================================
  // CORE
  // =========================================================================

  // -------------------------------------------------------------------------
  // (c) session_start returns ProcessSummary from ProcessLister
  // -------------------------------------------------------------------------
  it("session_start returns ProcessSummary from ProcessLister", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Pre-populate with one running process for this session
    reg.write("ses_001", cwd, {
      proc_1: makeProcess({ name: "dev-server", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_001", cwd);

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);
    const result = hook.onSessionStart(cwd, "ses_001");

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    // Should mention the running process
    expect(result).toContain("dev-server");
    expect(result).toContain("1 running");
  });

  // -------------------------------------------------------------------------
  // (d) turn_end refreshes heartbeat for current session
  // -------------------------------------------------------------------------
  it("turn_end refreshes heartbeat for current session", () => {
    const cwd = "/abs/project-b";
    const reg = new Registry(registryPath);

    reg.write("ses_002", cwd, {
      proc_1: makeProcess({ name: "build", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    const beforeTime = Date.now();
    hb.heartbeat("ses_002", cwd);

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);

    // Wait a tick so heartbeat timestamp advances
    const originalNow = Date.now;
    // eslint-disable-next-line no-global-assign
    Date.now = () => originalNow() + 100;

    try {
      hook.onTurnEnd(cwd, "ses_002");

      const session = reg.readSession(cwd, "ses_002");
      expect(session).not.toBeNull();
      expect(session!.lastHeartbeatAt).toBeGreaterThan(beforeTime);
    } finally {
      // eslint-disable-next-line no-global-assign
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // (e) turn_end prunes stale sessions before summarizing
  // -------------------------------------------------------------------------
  it("turn_end prunes stale sessions before summarizing", () => {
    const cwd = "/abs/project-c";
    const reg = new Registry(registryPath);

    // Stale session with running process
    reg.write("ses_stale", cwd, {
      proc_stale: makeProcess({ name: "stale-runner", status: "running" }),
    });

    // Current alive session
    reg.write("ses_alive", cwd, {
      proc_alive: makeProcess({ name: "alive-runner", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 5000 });
    hb.heartbeat("ses_alive", cwd);

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);

    // Advance time past TTL
    const originalNow = Date.now;
    const baseTime = Date.now();
    // eslint-disable-next-line no-global-assign
    Date.now = () => baseTime + 10_000;

    try {
      const result = hook.onTurnEnd(cwd, "ses_alive");

      // After pruning, stale session's process should be terminated
      expect(result).toBeDefined();
      expect(result).toContain("1 terminated");

      // Verify the stale process was marked terminated in registry
      const staleSession = reg.readSession(cwd, "ses_stale");
      if (staleSession) {
        const staleProc = staleSession.processes["proc_stale"];
        expect(staleProc.status).toBe("terminated");
      }
    } finally {
      // eslint-disable-next-line no-global-assign
      Date.now = originalNow;
    }
  });

  // -------------------------------------------------------------------------
  // (f) session_start registers watch subscription from config
  // -------------------------------------------------------------------------
  it("session_start registers watch subscription from config", () => {
    const cwd = "/abs/project-d";
    const reg = new Registry(registryPath);
    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const watchConfig: WatchSubscription = {
      includeTagsAny: ["backend", "api"],
      excludeTagsAny: ["noise"],
    };

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);
    hook.onSessionStart(cwd, "ses_003", watchConfig);

    // Verify subscription was registered in the subscriber index
    // Resolve targets matching the subscription's include criteria
    const targets = subIndex.resolveTargets(cwd, ["backend"], []);
    expect(targets).toContain("ses_003");
  });

  // -------------------------------------------------------------------------
  // (g) turn_end formats summary as readable string
  // -------------------------------------------------------------------------
  it("turn_end formats summary as readable string", () => {
    const cwd = "/abs/project-e";
    const reg = new Registry(registryPath);

    reg.write("ses_004", cwd, {
      proc_1: makeProcess({ name: "server", status: "running" }),
      proc_2: makeProcess({ name: "test", status: "exited" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_004", cwd);

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);
    const result = hook.onTurnEnd(cwd, "ses_004");

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);

    // The formatted string should mention process names or counts
    expect(result).toMatch(/running|terminated|completed|exited/);
  });

  // -------------------------------------------------------------------------
  // (h) session_start with existing processes shows current + sibling info
  // -------------------------------------------------------------------------
  it("session_start with existing processes shows current and sibling info", () => {
    const cwd = "/abs/project-f";
    const reg = new Registry(registryPath);

    // Existing sibling session with running process
    reg.write("ses_sibling", cwd, {
      proc_sib: makeProcess({ name: "sibling-server", status: "running" }),
    });

    // Current session with one running + one exited
    reg.write("ses_main", cwd, {
      proc_cur_run: makeProcess({ name: "my-server", status: "running" }),
      proc_cur_done: makeProcess({ name: "my-build", status: "exited" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_sibling", cwd);
    hb.heartbeat("ses_main", cwd);

    const lister = new ProcessLister(reg, hb);
    const subIndex = new SubscriberIndex();

    const hook = new SessionSummaryHook(reg, hb, lister, subIndex);
    const result = hook.onSessionStart(cwd, "ses_main");

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");

    // Should show current process info
    expect(result).toContain("my-server");
    // Should show sibling info
    expect(result).toContain("sibling-server");
  });
});
