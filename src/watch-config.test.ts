import { describe, expect, it } from "vitest";
import { parseWatchConfig } from "./watch-config";
import type { NamedWatchConfigMap } from "./watch-config";

// ─── Worst-first: complex integration scenarios ───────────────────

describe("parseWatchConfig – worst-first", () => {
  // (a) Legacy array config auto-migrated to dict without data loss
  it("migrates legacy array format to dict without data loss", () => {
    const legacy = [
      { pattern: "ready on port 3000" },
      { pattern: "ERROR", stream: "stderr" as const, repeat: true },
      {
        pattern: "started",
        stream: "both" as const,
        repeat: false,
      },
    ];

    const result: NamedWatchConfigMap = parseWatchConfig(legacy);

    // Should have exactly 3 entries with auto-generated keys
    const keys = Object.keys(result);
    expect(keys).toHaveLength(3);

    // All auto-generated keys should be unique and follow a stable convention
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).toMatch(/^watch_\d+$/);
    }

    // First entry: pattern carried over, defaults applied
    const first = result[keys[0]];
    expect(first.pattern).toBe("ready on port 3000");
    expect(first.stream).toBe("both"); // default stream
    expect(first.repeat).toBe(false); // default repeat
    expect(first.tags).toEqual([]); // default empty tags
    expect(first.labels).toEqual([]); // default empty labels

    // Second entry: explicit stream and repeat preserved
    const second = result[keys[1]];
    expect(second.pattern).toBe("ERROR");
    expect(second.stream).toBe("stderr");
    expect(second.repeat).toBe(true);
    expect(second.tags).toEqual([]);
    expect(second.labels).toEqual([]);

    // Third entry: all explicit fields preserved
    const third = result[keys[2]];
    expect(third.pattern).toBe("started");
    expect(third.stream).toBe("both");
    expect(third.repeat).toBe(false);
    expect(third.tags).toEqual([]);
    expect(third.labels).toEqual([]);
  });

  // (b) Dict with overlapping tag+label combos resolves correctly
  it("resolves dict watches with overlapping tag+label combos correctly", () => {
    const dict = {
      "server-lifecycle": {
        pattern: "listening on",
        tags: ["backend", "server"],
        labels: ["lifecycle"],
      },
      "server-errors": {
        pattern: "ERROR|FATAL",
        stream: "stderr",
        repeat: true,
        tags: ["backend", "server", "critical"],
        labels: ["error"],
      },
      "api-health": {
        pattern: "health check",
        tags: ["backend", "api"],
        labels: ["lifecycle", "health"],
      },
    };

    const result = parseWatchConfig(dict);

    expect(Object.keys(result)).toHaveLength(3);

    // "server-lifecycle" — defaults filled
    const sl = result["server-lifecycle"];
    expect(sl.pattern).toBe("listening on");
    expect(sl.stream).toBe("both");
    expect(sl.repeat).toBe(false);
    expect(sl.tags).toEqual(["backend", "server"]);
    expect(sl.labels).toEqual(["lifecycle"]);

    // "server-errors" — explicit stream and repeat
    const se = result["server-errors"];
    expect(se.pattern).toBe("ERROR|FATAL");
    expect(se.stream).toBe("stderr");
    expect(se.repeat).toBe(true);
    expect(se.tags).toEqual(["backend", "server", "critical"]);
    expect(se.labels).toEqual(["error"]);

    // "api-health" — overlapping "backend" tag with server-lifecycle
    const ah = result["api-health"];
    expect(ah.pattern).toBe("health check");
    expect(ah.stream).toBe("both");
    expect(ah.repeat).toBe(false);
    expect(ah.tags).toEqual(["backend", "api"]);
    expect(ah.labels).toEqual(["lifecycle", "health"]);

    // Ensure overlapping tags are independent copies (no shared reference)
    expect(sl.tags).not.toBe(se.tags);
    expect(sl.tags).not.toBe(ah.tags);
  });
});

// ─── Core validation cases ────────────────────────────────────────

describe("parseWatchConfig – core cases", () => {
  // (c) Parse valid dict watch config
  it("parses valid dict watch config", () => {
    const input = {
      "backend-ready": {
        pattern: "ready on http://localhost:3000",
        stream: "stdout",
        repeat: false,
        tags: ["backend", "server"],
        labels: ["lifecycle"],
      },
    };

    const result = parseWatchConfig(input);

    expect(result).toEqual({
      "backend-ready": {
        pattern: "ready on http://localhost:3000",
        stream: "stdout",
        repeat: false,
        tags: ["backend", "server"],
        labels: ["lifecycle"],
      },
    });
  });

  // (d) Parse watch with all optional fields defaulting correctly
  it("applies defaults for optional fields (stream, repeat, tags, labels)", () => {
    const input = {
      "minimal-watch": {
        pattern: "started",
      },
    };

    const result = parseWatchConfig(input);

    expect(result["minimal-watch"]).toEqual({
      pattern: "started",
      stream: "both",
      repeat: false,
      tags: [],
      labels: [],
    });
  });

  // (e) Reject watch with missing pattern
  it("throws on watch with missing pattern", () => {
    const input = {
      "no-pattern": {
        stream: "stdout",
        tags: ["test"],
      },
    };

    expect(() => parseWatchConfig(input)).toThrowError(
      /pattern.*required|missing.*pattern/i,
    );
  });

  // (f) Reject watch with invalid stream value
  it("throws on invalid stream value", () => {
    const input = {
      "bad-stream": {
        pattern: "test",
        stream: "invalid",
      },
    };

    expect(() => parseWatchConfig(input)).toThrowError(
      /invalid.*stream|stream.*must be/i,
    );
  });

  // (g) Reject watch with invalid regex pattern
  it("throws on invalid regex pattern", () => {
    const input = {
      "bad-regex": {
        pattern: "([unclosed",
      },
    };

    expect(() => parseWatchConfig(input)).toThrowError(
      /invalid.*pattern|invalid.*regex/i,
    );
  });

  // (h) Empty logWatches returns empty result
  it("returns empty map for empty dict input", () => {
    const result = parseWatchConfig({});
    expect(result).toEqual({});
  });

  // (i) Non-array tags throws
  it('throws on non-array tags value', () => {
    const input = {
      'bad-tags': {
        pattern: 'error',
        tags: 'not-array' as any,
      },
    };
    expect(() => parseWatchConfig(input)).toThrow(/tags must be an array/);
  });
});
