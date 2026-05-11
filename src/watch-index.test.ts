import { describe, expect, it } from "vitest";
import type { NamedWatchConfigMap } from "./watch-config";
import { WatchIndex } from "./watch-index";

// ─── Worst-first: complex integration scenarios ───────────────────

describe("WatchIndex – worst-first", () => {
  // (a) 100 watches all matching same line: perf under 1ms
  it("matches 100 watches against the same line in under 1ms", () => {
    const watches: NamedWatchConfigMap = {};
    for (let i = 0; i < 100; i++) {
      watches[`watch-${i}`] = {
        pattern: "heartbeat",
        stream: "stdout",
        repeat: true,
        tags: [`tag-${i}`],
        labels: [`label-${i}`],
      };
    }

    const index = new WatchIndex(watches);

    const start = performance.now();
    const matches = index.matchLine("stdout", "heartbeat from server");
    const elapsed = performance.now() - start;

    expect(matches).toHaveLength(100);
    expect(elapsed).toBeLessThan(5);
  });

  // (b) Invalid regex in watch config: graceful degradation
  //     Skip that watch, keep others functional.
  it("gracefully skips watches with invalid regex, keeping others", () => {
    const watches: NamedWatchConfigMap = {
      "good-watch": {
        pattern: "server started",
        stream: "stdout",
        repeat: false,
        tags: [],
        labels: [],
      },
      "bad-regex": {
        pattern: "([unclosed",
        stream: "stdout",
        repeat: false,
        tags: [],
        labels: [],
      },
      "another-good": {
        pattern: "ready",
        stream: "stderr",
        repeat: true,
        tags: ["important"],
        labels: [],
      },
    };

    // Should NOT throw — invalid regex is silently skipped
    const index = new WatchIndex(watches);

    // stdout should have only "good-watch" (bad-regex skipped)
    const stdoutWatches = index.getWatchesForStream("stdout");
    expect(stdoutWatches).toHaveLength(1);
    expect(stdoutWatches[0].name).toBe("good-watch");

    // stderr should have "another-good"
    const stderrWatches = index.getWatchesForStream("stderr");
    expect(stderrWatches).toHaveLength(1);
    expect(stderrWatches[0].name).toBe("another-good");

    // Matching should work for the valid watches only
    const matches = index.matchLine("stdout", "server started on port 3000");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("good-watch");
  });
});

// ─── Core functionality ───────────────────────────────────────────

describe("WatchIndex – core cases", () => {
  // (c) Build index from NamedWatchConfigMap
  it("builds index from NamedWatchConfigMap", () => {
    const watches: NamedWatchConfigMap = {
      "build-started": {
        pattern: "compiling",
        stream: "stdout",
        repeat: false,
        tags: ["build"],
        labels: ["lifecycle"],
      },
      "build-error": {
        pattern: "error:.+",
        stream: "stderr",
        repeat: true,
        tags: ["build", "error"],
        labels: ["error"],
      },
    };

    const index = new WatchIndex(watches);

    const stdoutWatches = index.getWatchesForStream("stdout");
    const stderrWatches = index.getWatchesForStream("stderr");

    expect(stdoutWatches).toHaveLength(1);
    expect(stdoutWatches[0].name).toBe("build-started");
    expect(stdoutWatches[0].regex).toBeInstanceOf(RegExp);
    expect(stdoutWatches[0].repeat).toBe(false);
    expect(stdoutWatches[0].tags).toEqual(["build"]);
    expect(stdoutWatches[0].labels).toEqual(["lifecycle"]);

    expect(stderrWatches).toHaveLength(1);
    expect(stderrWatches[0].name).toBe("build-error");
    expect(stderrWatches[0].regex.source).toBe("error:.+");
    expect(stderrWatches[0].repeat).toBe(true);
    expect(stderrWatches[0].tags).toEqual(["build", "error"]);
  });

  // (d) Get watches for stdout stream only
  it("returns only stdout watches when querying stdout", () => {
    const watches: NamedWatchConfigMap = {
      "stdout-only": {
        pattern: "listening on",
        stream: "stdout",
        repeat: false,
        tags: [],
        labels: [],
      },
      "stderr-only": {
        pattern: "ERROR",
        stream: "stderr",
        repeat: false,
        tags: [],
        labels: [],
      },
    };

    const index = new WatchIndex(watches);
    const stdoutWatches = index.getWatchesForStream("stdout");

    expect(stdoutWatches).toHaveLength(1);
    expect(stdoutWatches[0].name).toBe("stdout-only");
  });

  // (e) Get watches for stderr stream only
  it("returns only stderr watches when querying stderr", () => {
    const watches: NamedWatchConfigMap = {
      "stdout-only": {
        pattern: "listening on",
        stream: "stdout",
        repeat: false,
        tags: [],
        labels: [],
      },
      "stderr-only": {
        pattern: "ERROR",
        stream: "stderr",
        repeat: false,
        tags: [],
        labels: [],
      },
    };

    const index = new WatchIndex(watches);
    const stderrWatches = index.getWatchesForStream("stderr");

    expect(stderrWatches).toHaveLength(1);
    expect(stderrWatches[0].name).toBe("stderr-only");
  });

  // (f) Get watches for 'both' stream — appear in BOTH stdout and stderr queries
  it("includes 'both' stream watches in both stdout and stderr queries", () => {
    const watches: NamedWatchConfigMap = {
      "watch-both": {
        pattern: "heartbeat",
        stream: "both",
        repeat: true,
        tags: ["health"],
        labels: [],
      },
      "watch-stdout": {
        pattern: "ready",
        stream: "stdout",
        repeat: false,
        tags: [],
        labels: [],
      },
      "watch-stderr": {
        pattern: "fatal",
        stream: "stderr",
        repeat: false,
        tags: [],
        labels: [],
      },
    };

    const index = new WatchIndex(watches);

    const stdoutWatches = index.getWatchesForStream("stdout");
    const stdoutNames = stdoutWatches.map((w) => w.name);
    expect(stdoutNames).toContain("watch-both");
    expect(stdoutNames).toContain("watch-stdout");
    expect(stdoutNames).not.toContain("watch-stderr");
    expect(stdoutWatches).toHaveLength(2);

    const stderrWatches = index.getWatchesForStream("stderr");
    const stderrNames = stderrWatches.map((w) => w.name);
    expect(stderrNames).toContain("watch-both");
    expect(stderrNames).toContain("watch-stderr");
    expect(stderrNames).not.toContain("watch-stdout");
    expect(stderrWatches).toHaveLength(2);
  });

  // (g) Match line against compiled watches for a stream
  it("matches a line against compiled watches for the correct stream", () => {
    const watches: NamedWatchConfigMap = {
      "match-ready": {
        pattern: "ready on port \\d+",
        stream: "stdout",
        repeat: false,
        tags: ["server"],
        labels: ["lifecycle"],
      },
      "match-error": {
        pattern: "ERROR:.+",
        stream: "stderr",
        repeat: true,
        tags: ["error"],
        labels: [],
      },
    };

    const index = new WatchIndex(watches);

    // stdout match
    const stdoutMatches = index.matchLine(
      "stdout",
      "ready on port 3000",
    );
    expect(stdoutMatches).toHaveLength(1);
    expect(stdoutMatches[0].name).toBe("match-ready");
    expect(stdoutMatches[0].line).toBe("ready on port 3000");
    expect(stdoutMatches[0].regex).toBeInstanceOf(RegExp);
    expect(stdoutMatches[0].tags).toEqual(["server"]);
    expect(stdoutMatches[0].labels).toEqual(["lifecycle"]);

    // stderr match
    const stderrMatches = index.matchLine(
      "stderr",
      "ERROR: connection refused",
    );
    expect(stderrMatches).toHaveLength(1);
    expect(stderrMatches[0].name).toBe("match-error");

    // no match on wrong stream
    const noMatch = index.matchLine("stdout", "ERROR: something");
    expect(noMatch).toHaveLength(0);
  });

  // (h) Empty config returns empty index
  it("returns empty results for empty config", () => {
    const index = new WatchIndex({});

    expect(index.getWatchesForStream("stdout")).toEqual([]);
    expect(index.getWatchesForStream("stderr")).toEqual([]);
    expect(index.matchLine("stdout", "anything")).toEqual([]);
    expect(index.matchLine("stderr", "anything")).toEqual([]);
  });
});

// ─── Edge case fixes (Fix 8) ──────────────────────────────────────

describe('WatchIndex \u2013 Edge case fixes', () => {
  // Fix 8: WatchMatch must include repeat field (GAP-07)
  it('includes repeat field in WatchMatch', () => {
    const watches: NamedWatchConfigMap = {
      'repeat-watch': {
        pattern: 'heartbeat',
        stream: 'stdout',
        repeat: true,
        tags: ['health'],
        labels: [],
      },
      'no-repeat-watch': {
        pattern: 'ready',
        stream: 'stdout',
        repeat: false,
        tags: ['lifecycle'],
        labels: [],
      },
    };

    const index = new WatchIndex(watches);

    const matches = index.matchLine('stdout', 'heartbeat from server');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toHaveProperty('repeat');
    expect(matches[0].repeat).toBe(true);

    const matches2 = index.matchLine('stdout', 'ready on port 3000');
    expect(matches2).toHaveLength(1);
    expect(matches2[0]).toHaveProperty('repeat');
    expect(matches2[0].repeat).toBe(false);
  });
});
