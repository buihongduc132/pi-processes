import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "./registry";
import { HeartbeatManager } from "./heartbeat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-hb-test-"));
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("HeartbeatManager", () => {
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
  // a) COMPLEX: session crash mid-heartbeat — stale entry persists but is
  //    detected and cleaned on next prune
  // -------------------------------------------------------------------------
  it("detects and cleans stale entry after session crash mid-heartbeat", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session A writes processes and heartbeat
    reg.write("ses_crash", cwd, {
      proc_1: makeProcess({ name: "crashed-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 5000 });
    hb.heartbeat("ses_crash", cwd);

    // Simulate crash: the session entry still exists but no further heartbeats
    // Advance time beyond TTL
    const crashTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(crashTime + 10_000)); // 10s later, past the 5s TTL

    try {
      const result = hb.pruneStale(cwd);

      // The crashed session should be detected as stale
      expect(result.prunedSessions).toContain("ses_crash");
      expect(result.terminatedProcesses).toContain("proc_1");

      // Verify the process is marked terminated in the registry
      const session = reg.readSession(cwd, "ses_crash");
      expect(session).not.toBeNull();
      expect(session!.processes.proc_1.status).toBe("terminated");
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // b) COMPLEX: clock skew between sessions causes false expiry — session
  //    with old heartbeat gets pruned even though it was just active
  // -------------------------------------------------------------------------
  it("prunes session with skewed old heartbeat despite recent activity", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session A: heartbeat written with "old" clock
    reg.write("ses_skewed", cwd, {
      proc_1: makeProcess({ name: "skewed-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 30_000 });

    // Write heartbeat at an artificially old time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000)); // epoch+1s — very old
    hb.heartbeat("ses_skewed", cwd);

    // Now "real" time is current — the heartbeat appears 55+ years stale
    vi.setSystemTime(new Date()); // restore to real current time
    vi.useRealTimers();

    const result = hb.pruneStale(cwd);

    // Despite being "just active" from the skewed session's perspective,
    // the heartbeat timestamp is ancient, so it gets pruned
    expect(result.prunedSessions).toContain("ses_skewed");
    expect(result.terminatedProcesses).toContain("proc_1");
  });

  // =========================================================================
  // CORE
  // =========================================================================

  // -------------------------------------------------------------------------
  // c) write heartbeat updates lastHeartbeatAt for session
  // -------------------------------------------------------------------------
  it("updates lastHeartbeatAt when heartbeat is written", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_001", cwd, {
      proc_1: makeProcess({ name: "my-proc" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    const before = Date.now();
    hb.heartbeat("ses_001", cwd);
    const after = Date.now();

    const session = reg.readSession(cwd, "ses_001");
    expect(session).not.toBeNull();
    expect(session!.lastHeartbeatAt).toBeGreaterThanOrEqual(before);
    expect(session!.lastHeartbeatAt).toBeLessThanOrEqual(after);
  });

  // -------------------------------------------------------------------------
  // d) prune removes sessions with heartbeat older than TTL
  // -------------------------------------------------------------------------
  it("removes sessions with heartbeat older than TTL", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session with processes but no heartbeat — should be pruned
    reg.write("ses_stale", cwd, {
      proc_1: makeProcess({ name: "stale-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 1000 });

    // Advance time past TTL
    const baseTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime + 5000));

    try {
      const result = hb.pruneStale(cwd);
      expect(result.prunedSessions).toContain("ses_stale");
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // e) prune keeps sessions with heartbeat within TTL
  // -------------------------------------------------------------------------
  it("keeps sessions with heartbeat within TTL", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_fresh", cwd, {
      proc_1: makeProcess({ name: "fresh-proc" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
    hb.heartbeat("ses_fresh", cwd);

    const result = hb.pruneStale(cwd);
    expect(result.prunedSessions).not.toContain("ses_fresh");
    expect(result.terminatedProcesses).toHaveLength(0);

    // Session still exists
    const session = reg.readSession(cwd, "ses_fresh");
    expect(session).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // f) prune marks running processes as terminated in stale sessions
  // -------------------------------------------------------------------------
  it("marks running processes as terminated in stale sessions", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_stale", cwd, {
      proc_1: makeProcess({ name: "running-proc", status: "running" }),
      proc_2: makeProcess({ name: "exited-proc", status: "exited" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 1000 });

    // No heartbeat written — session is immediately stale

    const baseTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime + 5000));

    try {
      const result = hb.pruneStale(cwd);
      expect(result.terminatedProcesses).toContain("proc_1");

      // Already-exited processes should NOT be in terminated list
      expect(result.terminatedProcesses).not.toContain("proc_2");

      // Verify registry state: running process is now terminated
      const session = reg.readSession(cwd, "ses_stale");
      expect(session!.processes.proc_1.status).toBe("terminated");
      // Already-exited process stays exited
      expect(session!.processes.proc_2.status).toBe("exited");
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // g) prune removes entire session entry when no processes remain
  // -------------------------------------------------------------------------
  it("removes entire session entry when no processes remain after prune", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    // Session with no processes — effectively empty
    reg.write("ses_empty", cwd, {});

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 1000 });

    const baseTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime + 5000));

    try {
      const result = hb.pruneStale(cwd);
      expect(result.prunedSessions).toContain("ses_empty");
      expect(result.terminatedProcesses).toHaveLength(0);

      // Session should be fully removed from registry
      const session = reg.readSession(cwd, "ses_empty");
      expect(session).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // h) prune is idempotent
  // -------------------------------------------------------------------------
  it("is idempotent: calling prune twice gives same result", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_stale", cwd, {
      proc_1: makeProcess({ name: "stale-proc", status: "running" }),
    });

    const hb = new HeartbeatManager(reg, { defaultTtlMs: 1000 });

    const baseTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime + 5000));

    try {
      const result1 = hb.pruneStale(cwd);
      const result2 = hb.pruneStale(cwd);

      // First prune: session pruned, process terminated
      expect(result1.prunedSessions).toContain("ses_stale");
      expect(result1.terminatedProcesses).toContain("proc_1");

      // Second prune: session already gone, no new work
      expect(result2.prunedSessions).toHaveLength(0);
      expect(result2.terminatedProcesses).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // i) custom TTL is respected
  // -------------------------------------------------------------------------
  it("respects custom TTL from constructor", () => {
    const cwd = "/abs/project-a";
    const reg = new Registry(registryPath);

    reg.write("ses_custom", cwd, {
      proc_1: makeProcess({ name: "custom-proc" }),
    });

    // Very short TTL: 100ms
    const hb = new HeartbeatManager(reg, { defaultTtlMs: 100 });
    hb.heartbeat("ses_custom", cwd);

    const baseTime = Date.now();
    vi.useFakeTimers();

    // 50ms later — still within TTL
    vi.setSystemTime(new Date(baseTime + 50));
    try {
      const result1 = hb.pruneStale(cwd);
      expect(result1.prunedSessions).toHaveLength(0);
    } finally {
      // continue with fake timers for next check
    }

    // 200ms later — past TTL
    vi.setSystemTime(new Date(baseTime + 200));
    try {
      const result2 = hb.pruneStale(cwd);
      expect(result2.prunedSessions).toContain("ses_custom");
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // j) prune on empty registry returns empty result
  // -------------------------------------------------------------------------
  it("returns empty result when pruning empty registry", () => {
    const reg = new Registry(registryPath);
    const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });

    const result = hb.pruneStale("/abs/nonexistent");
    expect(result.prunedSessions).toEqual([]);
    expect(result.terminatedProcesses).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Edge case fixes — guard heartbeat() for non-existent sessions
  // -------------------------------------------------------------------------

  describe('Edge case fixes', () => {
    it('heartbeat on unknown session is a no-op (does not create entry)', () => {
      const reg = new Registry(registryPath);
      const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });

      // Call heartbeat on a session that was never written
      hb.heartbeat('ses_unknown', '/abs/project-a');

      // Should NOT have created a session entry
      expect(reg.readSession('/abs/project-a', 'ses_unknown')).toBeNull();
    });

    it('heartbeat after removeProcess is a no-op (does not re-create zombie)', () => {
      const cwd = '/abs/project-a';
      const reg = new Registry(registryPath);

      reg.write('ses_001', cwd, { proc_1: makeProcess() });
      reg.removeProcess(cwd, 'ses_001', 'proc_1');

      // Session is now gone
      expect(reg.readSession(cwd, 'ses_001')).toBeNull();

      const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });
      hb.heartbeat('ses_001', cwd);

      // Should NOT re-create the session
      expect(reg.readSession(cwd, 'ses_001')).toBeNull();
    });

    it('heartbeat does not create zombie session with empty processes', () => {
      const cwd = '/abs/project-a';
      const reg = new Registry(registryPath);
      const hb = new HeartbeatManager(reg, { defaultTtlMs: 60_000 });

      // heartbeat on a completely unknown session
      hb.heartbeat('ses_ghost', cwd);

      // No entry should exist in the registry at all
      const cwdGroup = reg.readCwd(cwd);
      expect(cwdGroup).toBeNull();
    });
  });
});
