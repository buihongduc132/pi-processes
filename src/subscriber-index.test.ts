import { describe, expect, it } from "vitest";
import { SubscriberIndex } from "./subscriber-index";
import type { WatchSubscription } from "./subscriber-index";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpDir(): string {
  const dir = join(tmpdir(), `subscriber-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ---------------------------------------------------------------------------
// Edge case fixes — cross-CWD isolation + excludeLabels
// ---------------------------------------------------------------------------

describe('SubscriberIndex – Edge case fixes', () => {
  it('cross-CWD exclusion does not contaminate other cwds', () => {
    const cwdA = createTmpDir();
    const cwdB = createTmpDir();
    try {
      const index = new SubscriberIndex();

      // session-X subscribes in BOTH cwds:
      //   cwdA: includeTagsAny [backend], excludeTagsAny [noise]
      //   cwdB: includeTagsAny [backend] (no exclusion)
      index.subscribe('session-X', cwdA, {
        includeTagsAny: ['backend'],
        excludeTagsAny: ['noise'],
      });
      index.subscribe('session-X', cwdB, {
        includeTagsAny: ['backend'],
      });

      // Resolve for cwdA with tag "noise": session-X should be excluded
      let targetsA = index.resolveTargets(cwdA, ['backend', 'noise'], []);
      expect(targetsA).toEqual([]);

      // Resolve for cwdB with tag "noise": session-X should STILL match
      // because the cwdA exclusion must not leak into cwdB resolution
      let targetsB = index.resolveTargets(cwdB, ['backend', 'noise'], []);
      expect(targetsB).toEqual(['session-X']);
    } finally {
      cleanupTmpDir(cwdA);
      cleanupTmpDir(cwdB);
    }
  });

  it('excludeLabels filters out sessions when watch has a matching label', () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe('session-A', cwd, {
        includeTagsAny: ['backend'],
        excludeLabels: ['debug'],
      });
      index.subscribe('session-B', cwd, {
        includeTagsAny: ['backend'],
      });

      // Watch with label "debug" → session-A excluded
      let targets = index.resolveTargets(cwd, ['backend'], ['debug']);
      expect(targets).toEqual(['session-B']);

      // Without "debug" → both match
      targets = index.resolveTargets(cwd, ['backend'], []);
      expect(targets.sort()).toEqual(['session-A', 'session-B']);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  it('excludeLabels combined with excludeTagsAny both apply', () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe('session-A', cwd, {
        includeTagsAny: ['backend'],
        excludeTagsAny: ['noise'],
        excludeLabels: ['debug'],
      });

      // Tag "noise" present → excluded
      let targets = index.resolveTargets(cwd, ['backend', 'noise'], []);
      expect(targets).toEqual([]);

      // Label "debug" present → excluded
      targets = index.resolveTargets(cwd, ['backend'], ['debug']);
      expect(targets).toEqual([]);

      // Neither exclusion trigger → matched
      targets = index.resolveTargets(cwd, ['backend'], []);
      expect(targets).toEqual(['session-A']);
    } finally {
      cleanupTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Worst-first tests
// ---------------------------------------------------------------------------

describe("SubscriberIndex – worst-first", () => {
  // (a) includeTagsAll + excludeTagsAny: complex set intersection
  //     Session subscribes to tags ALL [backend,api] AND labels [error],
  //     EXCLUDING tag [noise].
  //     Watch with tags [backend,api,noise] → EXCLUDED.
  //     Watch with tags [backend,api] (no noise) → MATCHED.
  it("applies includeTagsAll + excludeTagsAny: excluded when watch has noise, matched when not", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      const sub: WatchSubscription = {
        includeTagsAll: ["backend", "api"],
        includeLabels: ["error"],
        excludeTagsAny: ["noise"],
      };

      index.subscribe("session-1", cwd, sub);

      // Watch has tags [backend, api, noise] and labels [error]
      // includeTagsAll [backend, api] — both present ✓
      // includeLabels [error] — present ✓
      // BUT excludeTagsAny [noise] — watch has "noise" → EXCLUDED
      let targets = index.resolveTargets(cwd, ["backend", "api", "noise"], ["error"]);
      expect(targets).toEqual([]);

      // Watch has tags [backend, api] and labels [error] — no "noise" → MATCHED
      targets = index.resolveTargets(cwd, ["backend", "api"], ["error"]);
      expect(targets).toEqual(["session-1"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (b) Concurrent subscribe/unsubscribe during active resolve
  //     Simulated with interleaved calls: subscribe A, resolve, unsubscribe A,
  //     subscribe B, resolve — verify B is found and A is gone.
  it("handles interleaved subscribe/unsubscribe/resolve without corruption", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-A", cwd, { includeTagsAny: ["alpha"] });
      let targets = index.resolveTargets(cwd, ["alpha"], []);
      expect(targets).toEqual(["session-A"]);

      index.unsubscribe("session-A");
      targets = index.resolveTargets(cwd, ["alpha"], []);
      expect(targets).toEqual([]);

      index.subscribe("session-B", cwd, { includeTagsAny: ["beta"] });
      targets = index.resolveTargets(cwd, ["beta"], []);
      expect(targets).toEqual(["session-B"]);

      // Verify A is truly gone
      targets = index.resolveTargets(cwd, ["alpha"], []);
      expect(targets).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (c) Performance: 10 sessions × 20 watches × 100 matchLine calls under 50ms
  it("resolves 10 sessions × 20 tag combinations × 100 calls under 50ms", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      // 10 sessions, each subscribing to different tag sets
      for (let s = 0; s < 10; s++) {
        const sub: WatchSubscription = {
          includeTagsAny: [`tag-${s}`, `shared`],
        };
        index.subscribe(`session-${s}`, cwd, sub);
      }

      const start = performance.now();

      // 20 different watch tag combinations × 100 calls each
      for (let w = 0; w < 20; w++) {
        const watchTags = [`tag-${w % 10}`, `extra-${w}`];
        for (let c = 0; c < 100; c++) {
          index.resolveTargets(cwd, watchTags, []);
        }
      }

      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    } finally {
      cleanupTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Core functionality tests
// ---------------------------------------------------------------------------

describe("SubscriberIndex – core cases", () => {
  // (d) Subscribe session with includeTagsAny
  it("subscribes a session with includeTagsAny and returns it on tag match", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-1", cwd, { includeTagsAny: ["backend", "frontend"] });

      // Match on "backend"
      let targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets).toEqual(["session-1"]);

      // Match on "frontend"
      targets = index.resolveTargets(cwd, ["frontend"], []);
      expect(targets).toEqual(["session-1"]);

      // No match on unrelated tag
      targets = index.resolveTargets(cwd, ["database"], []);
      expect(targets).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (e) Subscribe session with includeLabels
  it("subscribes a session with includeLabels and returns it on label match", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-1", cwd, { includeLabels: ["error", "warning"] });

      // Match on "error" label
      let targets = index.resolveTargets(cwd, [], ["error"]);
      expect(targets).toEqual(["session-1"]);

      // Match on "warning" label
      targets = index.resolveTargets(cwd, [], ["warning"]);
      expect(targets).toEqual(["session-1"]);

      // No match on unrelated label
      targets = index.resolveTargets(cwd, [], ["info"]);
      expect(targets).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (f) Unsubscribe removes session from all indexes
  it("unsubscribes a session so it no longer appears in resolveTargets", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-1", cwd, { includeTagsAny: ["backend"] });
      index.subscribe("session-1", cwd, { includeLabels: ["error"] });

      // Verify present before unsubscribe
      let targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets).toEqual(["session-1"]);

      index.unsubscribe("session-1");

      // Verify absent after unsubscribe — tag index
      targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets).toEqual([]);

      // Verify absent after unsubscribe — label index
      targets = index.resolveTargets(cwd, [], ["error"]);
      expect(targets).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (g) resolveTargets returns sessions matching tag ANY
  it("returns all sessions whose includeTagsAny overlaps with watch tags", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-A", cwd, { includeTagsAny: ["backend"] });
      index.subscribe("session-B", cwd, { includeTagsAny: ["frontend"] });
      index.subscribe("session-C", cwd, { includeTagsAny: ["backend", "frontend"] });

      // Only "backend" tag → A and C
      let targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets.sort()).toEqual(["session-A", "session-C"]);

      // Only "frontend" tag → B and C
      targets = index.resolveTargets(cwd, ["frontend"], []);
      expect(targets.sort()).toEqual(["session-B", "session-C"]);

      // Both tags → A, B, and C (union)
      targets = index.resolveTargets(cwd, ["backend", "frontend"], []);
      expect(targets.sort()).toEqual(["session-A", "session-B", "session-C"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (h) resolveTargets returns sessions matching label
  it("returns sessions whose includeLabels overlaps with watch labels", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-A", cwd, { includeLabels: ["error"] });
      index.subscribe("session-B", cwd, { includeLabels: ["warning"] });

      const targets = index.resolveTargets(cwd, [], ["error", "warning"]);
      expect(targets.sort()).toEqual(["session-A", "session-B"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (i) resolveTargets with excludeTagsAny filters out matching sessions
  it("filters out sessions when watch has a tag in the session's excludeTagsAny", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-A", cwd, {
        includeTagsAny: ["backend"],
        excludeTagsAny: ["noisy"],
      });
      index.subscribe("session-B", cwd, {
        includeTagsAny: ["backend"],
      });

      // Watch tags include "noisy" → session-A excluded
      let targets = index.resolveTargets(cwd, ["backend", "noisy"], []);
      expect(targets).toEqual(["session-B"]);

      // Without "noisy" → both match
      targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets.sort()).toEqual(["session-A", "session-B"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (j) resolveTargets with includeTagsAll requires ALL tags present
  it("only returns sessions when ALL includeTagsAll tags are present in watch tags", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-A", cwd, { includeTagsAll: ["backend", "api"] });

      // Missing "api" → no match
      let targets = index.resolveTargets(cwd, ["backend"], []);
      expect(targets).toEqual([]);

      // Both present → match
      targets = index.resolveTargets(cwd, ["backend", "api"], []);
      expect(targets).toEqual(["session-A"]);

      // Extra tags are fine → match
      targets = index.resolveTargets(cwd, ["backend", "api", "v2"], []);
      expect(targets).toEqual(["session-A"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (k) Empty subscription matches all watches
  it("matches all watches when subscription has no tag/label filters", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-wildcard", cwd, {});

      // Any tags
      let targets = index.resolveTargets(cwd, ["anything"], []);
      expect(targets).toEqual(["session-wildcard"]);

      // Any labels
      targets = index.resolveTargets(cwd, [], ["any-label"]);
      expect(targets).toEqual(["session-wildcard"]);

      // No tags or labels
      targets = index.resolveTargets(cwd, [], []);
      expect(targets).toEqual(["session-wildcard"]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });

  // (l) resolveTargets for non-existent tag returns empty
  it("returns empty array for tags/labels with no subscribers", () => {
    const cwd = createTmpDir();
    try {
      const index = new SubscriberIndex();

      index.subscribe("session-1", cwd, { includeTagsAny: ["backend"] });

      const targets = index.resolveTargets(cwd, ["nonexistent"], []);
      expect(targets).toEqual([]);
    } finally {
      cleanupTmpDir(cwd);
    }
  });


});
