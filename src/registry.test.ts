import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "./registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-reg-test-"));
}

/** Minimal process info for write() calls — matches the design shape. */
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

describe("Registry", () => {
  let tmp: string;
  let registryPath: string;

  beforeEach(() => {
    tmp = makeTempDir();
    registryPath = join(tmp, "registry.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // d) write and read back process state for a cwd
  // -------------------------------------------------------------------------
  it("writes and reads back process state for a cwd", () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";
    const sessionId = "ses_001";

    reg.write(sessionId, cwd, {
      proc_1: makeProcess({ name: "backend-dev", command: "pnpm dev" }),
    });

    const byCwd = reg.readCwd(cwd);
    expect(byCwd).not.toBeNull();
    expect(byCwd!.sessions[sessionId]).toBeDefined();
    expect(byCwd!.sessions[sessionId].processes.proc_1.name).toBe("backend-dev");
    expect(byCwd!.sessions[sessionId].processes.proc_1.command).toBe("pnpm dev");
  });

  // -------------------------------------------------------------------------
  // e) group by cwd correctly: different cwds are isolated
  // -------------------------------------------------------------------------
  it("groups by cwd: different cwds are isolated", () => {
    const reg = new Registry(registryPath);
    const cwdA = "/abs/project-a";
    const cwdB = "/abs/project-b";

    reg.write("ses_a", cwdA, { p1: makeProcess({ name: "a-proc" }) });
    reg.write("ses_b", cwdB, { p2: makeProcess({ name: "b-proc" }) });

    const a = reg.readCwd(cwdA);
    const b = reg.readCwd(cwdB);

    expect(a!.sessions.ses_a.processes.p1.name).toBe("a-proc");
    expect(b!.sessions.ses_b.processes.p2.name).toBe("b-proc");

    // Cross-isolation
    expect(a!.sessions.ses_b).toBeUndefined();
    expect(b!.sessions.ses_a).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // f) update existing process status
  // -------------------------------------------------------------------------
  it("updates existing process status", () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";
    const sid = "ses_001";

    reg.write(sid, cwd, { proc_1: makeProcess({ status: "running" }) });
    reg.write(sid, cwd, { proc_1: makeProcess({ status: "exited" }) });

    const session = reg.readSession(cwd, sid);
    expect(session!.processes.proc_1.status).toBe("exited");
  });

  // -------------------------------------------------------------------------
  // g) remove process on end
  // -------------------------------------------------------------------------
  it("removes a specific process", () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";
    const sid = "ses_001";

    reg.write(sid, cwd, {
      proc_1: makeProcess({ name: "p1" }),
      proc_2: makeProcess({ name: "p2" }),
    });

    reg.removeProcess(cwd, sid, "proc_1");

    const session = reg.readSession(cwd, sid);
    expect(session!.processes.proc_1).toBeUndefined();
    expect(session!.processes.proc_2).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // h) remove session entry when session has no processes
  // -------------------------------------------------------------------------
  it("removes session entry when session has no processes left", () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";
    const sid = "ses_001";

    reg.write(sid, cwd, { proc_1: makeProcess() });
    reg.removeProcess(cwd, sid, "proc_1");

    // Session should be cleaned up (null) after last process removed
    const session = reg.readSession(cwd, sid);
    expect(session).toBeNull();

    // Also verify explicit removeSession works and cleans up cwd entry
    reg.write("ses_002", cwd, { p1: makeProcess() });
    reg.removeSession(cwd, "ses_002");
    expect(reg.readSession(cwd, "ses_002")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // i) create registry file on first write
  // -------------------------------------------------------------------------
  it("creates registry file on first write", () => {
    expect(existsSync(registryPath)).toBe(false);

    const reg = new Registry(registryPath);
    reg.write("ses_001", "/abs/project-a", { p1: makeProcess() });

    expect(existsSync(registryPath)).toBe(true);
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.cwdIndex).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // j) handle missing registry file on read
  // -------------------------------------------------------------------------
  it("returns null when reading from missing registry file", () => {
    const reg = new Registry(registryPath);
    expect(reg.readCwd("/nonexistent")).toBeNull();
    expect(reg.readSession("/nonexistent", "ses_001")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // k) overwrite stale data with fresh session data
  // -------------------------------------------------------------------------
  it("overwrites stale data with fresh session data", () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";
    const sid = "ses_001";

    // Write initial
    reg.write(sid, cwd, { proc_1: makeProcess({ name: "stale" }) });

    // Overwrite with fresh
    reg.write(sid, cwd, { proc_2: makeProcess({ name: "fresh" }) });

    const session = reg.readSession(cwd, sid);
    expect(session!.processes.proc_1).toBeUndefined();
    expect(session!.processes.proc_2.name).toBe("fresh");
  });

  // -------------------------------------------------------------------------
  // a) COMPLEX: concurrent writes from 2 sessions same cwd
  // -------------------------------------------------------------------------
  it("handles concurrent writes from 2 sessions in the same cwd", async () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";

    // Two sessions write concurrently to the same cwd
    const writes = [
      Promise.resolve().then(() =>
        reg.write("ses_A", cwd, {
          pa: makeProcess({ name: "from-A" }),
        }),
      ),
      Promise.resolve().then(() =>
        reg.write("ses_B", cwd, {
          pb: makeProcess({ name: "from-B" }),
        }),
      ),
    ];

    await Promise.all(writes);

    const byCwd = reg.readCwd(cwd);
    expect(byCwd).not.toBeNull();
    // Both sessions must be present
    expect(byCwd!.sessions.ses_A).toBeDefined();
    expect(byCwd!.sessions.ses_B).toBeDefined();
    expect(byCwd!.sessions.ses_A.processes.pa.name).toBe("from-A");
    expect(byCwd!.sessions.ses_B.processes.pb.name).toBe("from-B");
  });

  // -------------------------------------------------------------------------
  // b) COMPLEX: corrupt JSON file recovery
  // -------------------------------------------------------------------------
  it("recovers from corrupt JSON file", () => {
    // Pre-seed a corrupt file
    mkdirSync(join(registryPath, ".."), { recursive: true });
    writeFileSync(registryPath, "THIS IS NOT JSON{{{");

    const reg = new Registry(registryPath);
    // Write should succeed despite corrupt file — it replaces it
    reg.write("ses_001", "/abs/project-a", { p1: makeProcess() });

    const byCwd = reg.readCwd("/abs/project-a");
    expect(byCwd).not.toBeNull();
    expect(byCwd!.sessions.ses_001.processes.p1).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // c) COMPLEX: concurrent read during write
  // -------------------------------------------------------------------------
  it("handles concurrent read during write", async () => {
    const reg = new Registry(registryPath);
    const cwd = "/abs/project-a";

    // Write initial data
    reg.write("ses_001", cwd, { p1: makeProcess({ name: "initial" }) });

    // Read and write concurrently
    const [readResult] = await Promise.all([
      Promise.resolve().then(() => reg.readCwd(cwd)),
      Promise.resolve().then(() =>
        reg.write("ses_002", cwd, { p2: makeProcess({ name: "concurrent" }) }),
      ),
    ]);

    // Read should return valid data (either with or without ses_002)
    expect(readResult).not.toBeNull();
    expect(readResult!.sessions.ses_001.processes.p1).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // l) large registry: 100 cwds × 5 sessions each, perf under 50ms
  // -------------------------------------------------------------------------
  it("handles large registry: 100 cwds × 5 sessions under 50ms", () => {
    const reg = new Registry(registryPath);

    const start = performance.now();

    for (let c = 0; c < 100; c++) {
      const cwd = `/abs/project-${c}`;
      for (let s = 0; s < 5; s++) {
        const sid = `ses_${c}_${s}`;
        reg.write(sid, cwd, {
          [`proc_${c}_${s}`]: makeProcess({ name: `p-${c}-${s}` }),
        });
      }
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);

    // Spot-check a few entries
    const cwd90 = reg.readCwd("/abs/project-90");
    expect(cwd90).not.toBeNull();
    expect(Object.keys(cwd90!.sessions)).toHaveLength(5);

    const cwd0 = reg.readCwd("/abs/project-0");
    expect(cwd0!.sessions.ses_0_0.processes.proc_0_0.name).toBe("p-0-0");
  });

  // -------------------------------------------------------------------------
  // Edge case fixes — input validation
  // -------------------------------------------------------------------------

  describe('Edge case fixes', () => {
    it('rejects empty cwd with TypeError', () => {
      const reg = new Registry(registryPath);
      expect(() => reg.write('ses_001', '', { p1: makeProcess() })).toThrow(TypeError);
    });

    it('rejects empty sessionId with TypeError', () => {
      const reg = new Registry(registryPath);
      expect(() => reg.write('', '/abs/project-a', { p1: makeProcess() })).toThrow(TypeError);
    });

    it('rejects undefined sessionId with TypeError', () => {
      const reg = new Registry(registryPath);
      expect(() => reg.write(undefined as any, '/abs/project-a', { p1: makeProcess() })).toThrow(TypeError);
    });

    it('propagates non-SyntaxError from load (e.g. EACCES)', () => {
      // Write a valid registry file, then make it unreadable (chmod 000)
      // On non-Windows, readFileSync should throw EACCES, not be swallowed
      if (process.platform === 'win32') return; // skip on Windows

      const reg1 = new Registry(registryPath);
      reg1.write('ses_001', '/abs/project-a', { p1: makeProcess() });

      // Make the file unreadable
      const { chmodSync } = require('node:fs');
      chmodSync(registryPath, 0o000);

      try {
        // Constructing a new Registry triggers load() which should propagate EACCES
        expect(() => new Registry(registryPath)).toThrow();
        // Verify it is NOT a SyntaxError — it should be a system error (EACCES)
        try {
          new Registry(registryPath);
        } catch (err: any) {
          expect(err).not.toBeInstanceOf(SyntaxError);
          expect(err.code).toBe('EACCES');
        }
      } finally {
        // Restore permissions for cleanup
        chmodSync(registryPath, 0o644);
      }
    });
  });
});
