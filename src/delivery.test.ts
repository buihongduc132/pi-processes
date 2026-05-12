import { describe, expect, it } from "vitest";
import { SubscriberIndex } from "./subscriber-index";
import type { WatchSubscription } from "./subscriber-index";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types under test (will be exported from delivery.ts)
// ---------------------------------------------------------------------------

interface MatchInput {
  processId: string;
  processName: string;
  source: "stdout" | "stderr";
  line: string;
  watchName: string;
  watchTags: string[];
  watchLabels: string[];
}

interface DeliveryReport {
  delivered: string[];
  failed: string[];
}

// ---------------------------------------------------------------------------
// Placeholder import — this module does NOT exist yet.  All tests MUST fail
// at import time, which is the desired RED state.
// ---------------------------------------------------------------------------

import { DeliveryManager } from "./delivery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpDir(): string {
  const dir = join(
    tmpdir(),
    `delivery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTmpDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in test
  }
}

function makeMatch(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    processId: "proc_1",
    processName: "backend-dev",
    source: "stdout",
    line: "Server ready on http://localhost:3000",
    watchName: "backend-ready",
    watchTags: ["backend", "server"],
    watchLabels: ["lifecycle"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Worst-first tests
// ---------------------------------------------------------------------------

describe("DeliveryManager – worst-first", () => {
  // (a) Target session crashed: message queued not lost — delivery returns
  //     list of failed deliveries with session info.
  it("returns failed delivery entries for sessions where sendMessage throws", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-crashed", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.subscribe("session-ok", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      // Simulate: session-crashed is unreachable.
      // DeliveryManager.deliver should attempt send and catch errors,
      // returning them in `failed`.
      manager.setSessionHealth("session-crashed", "crashed");

      const report: DeliveryReport = await manager.deliver(cwd, makeMatch());

      expect(report.delivered).toEqual(["session-ok"]);
      expect(report.failed).toEqual(["session-crashed"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (b) Fanout to 5 sessions: all receive correct message within 100ms of
  //     processing.
  it("delivers to 5 subscribed sessions within 100ms", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      const sessionIds = Array.from({ length: 5 }, (_, i) => `session-${i}`);

      for (const sid of sessionIds) {
        index.subscribe(sid, cwd, {
          includeTagsAny: ["backend"],
        } satisfies WatchSubscription);
      }

      const manager = new DeliveryManager(index);
      const match = makeMatch();
      const start = performance.now();

      const report: DeliveryReport = await manager.deliver(cwd, match);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(report.delivered.sort()).toEqual(sessionIds.sort());
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Core tests
// ---------------------------------------------------------------------------

describe("DeliveryManager – core cases", () => {
  // (c) Delivers match to single subscribed session in same cwd.
  it("delivers match to a single subscribed session in same cwd", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-1", cwd, {} satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(cwd, makeMatch());

      expect(report.delivered).toEqual(["session-1"]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (d) Delivers to multiple sessions matching tags.
  it("delivers to multiple sessions matching watch tags", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-A", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.subscribe("session-B", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.subscribe("session-C", cwd, {
        includeTagsAny: ["frontend"],
      } satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(
        cwd,
        makeMatch({ watchTags: ["backend"] }),
      );

      expect(report.delivered.sort()).toEqual(["session-A", "session-B"]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (e) Does NOT deliver to sessions in different cwd.
  it("does not deliver to sessions subscribed in a different cwd", async () => {
    const cwdA = createTmpDir();
    const cwdB = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-A", cwdA, {} satisfies WatchSubscription);
      index.subscribe("session-B", cwdB, {} satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(cwdA, makeMatch());

      expect(report.delivered).toEqual(["session-A"]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwdA);
      cleanupTmpDir(cwdB);
    }
  });

  // (f) Does NOT deliver to unsubscribed session.
  it("does not deliver to a session that has unsubscribed", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-1", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.subscribe("session-2", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.unsubscribe("session-2");

      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(
        cwd,
        makeMatch({ watchTags: ["backend"] }),
      );

      expect(report.delivered).toEqual(["session-1"]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (g) Delivers to session matching includeLabels.
  it("delivers to sessions matching includeLabels", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-A", cwd, {
        includeLabels: ["error"],
      } satisfies WatchSubscription);
      index.subscribe("session-B", cwd, {
        includeLabels: ["lifecycle"],
      } satisfies WatchSubscription);
      index.subscribe("session-C", cwd, {
        includeLabels: ["info"],
      } satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(
        cwd,
        makeMatch({ watchLabels: ["error"] }),
      );

      expect(report.delivered).toEqual(["session-A"]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (h) formatMessage includes process name, watch name, matched line, and tags.
  it("formatMessage includes process name, watch name, matched line, and tags", () => {
    const index = new SubscriberIndex();
    const manager = new DeliveryManager(index);
    const match = makeMatch();

    const msg: string = manager.formatMessage(match);

    expect(msg).toMatch(/^\[backend-dev\] backend-ready: Server ready on http:\/\/localhost:3000 \(tags: backend, server\)$/);
  });

  // (i) deliver returns delivery report with success/fail per session.
  it("returns delivery report with success and failure entries", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      index.subscribe("session-ok", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);
      index.subscribe("session-bad", cwd, {
        includeTagsAny: ["backend"],
      } satisfies WatchSubscription);

      const manager = new DeliveryManager(index);
      manager.setSessionHealth("session-bad", "crashed");

      const report: DeliveryReport = await manager.deliver(
        cwd,
        makeMatch({ watchTags: ["backend"] }),
      );

      expect(report.delivered).toEqual(["session-ok"]);
      expect(report.failed).toEqual(["session-bad"]);
      // Both arrays contain session IDs
      expect(report.delivered[0]).toBeTypeOf("string");
      expect(report.failed[0]).toBeTypeOf("string");
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (j) Empty subscriber index returns empty delivery report.
  it("returns empty delivery report when subscriber index is empty", async () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();
      const manager = new DeliveryManager(index);
      const report: DeliveryReport = await manager.deliver(cwd, makeMatch());

      expect(report.delivered).toEqual([]);
      expect(report.failed).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case fixes (Fix 9)
// ---------------------------------------------------------------------------

describe('DeliveryManager \u2013 Edge case fixes', () => {
  // Fix 9a: formatMessage strips newlines and control chars (EC-F7-03)
  it('formatMessage strips newlines and control characters from line', () => {
    const index = new SubscriberIndex();
    const manager = new DeliveryManager(index);
    const match = makeMatch({
      line: 'line with\nnewline and\rcarriage and\ttab and\x07bell',
    });

    const msg = manager.formatMessage(match);

    // Should NOT contain literal newlines or control chars
    expect(msg).not.toContain('\n');
    expect(msg).not.toContain('\r');
    expect(msg).not.toContain('\x07');
    // Should still contain the safe parts
    expect(msg).toContain('line with');
    expect(msg).toContain('newline and');
  });

  // Fix 9b: formatMessage truncates long lines to 500 chars (EC-F7-03)
  it('formatMessage truncates lines exceeding 500 chars with [truncated] suffix', () => {
    const index = new SubscriberIndex();
    const manager = new DeliveryManager(index);
    const longLine = 'A'.repeat(600);
    const match = makeMatch({ line: longLine });

    const msg = manager.formatMessage(match);

    // Should contain [truncated] indicator
    expect(msg).toContain('[truncated]');
    // Should not contain the full 600-char line
    expect(msg).not.toContain('A'.repeat(600));
  });

  // Fix V1-2: formatMessage strips ANSI escape codes (SEC-4)
  it('strips ANSI escape codes from line', () => {
    const index = new SubscriberIndex();
    const manager = new DeliveryManager(index);
    const match = makeMatch({
      line: '\x1b[31mERROR\x1b[0m: something failed',
    });

    const msg = manager.formatMessage(match);

    expect(msg).not.toContain('\x1b');
    expect(msg).toContain('ERROR: something failed');
  });
});
