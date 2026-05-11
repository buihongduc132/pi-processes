import type { NamedWatchConfigMap } from "./watch-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A watch config entry compiled into an executable RegExp with routing info. */
export interface CompiledWatch {
  name: string;
  regex: RegExp;
  stream: "stdout" | "stderr" | "both";
  repeat: boolean;
  tags: string[];
  labels: string[];
}

/** A single line match produced by {@link WatchIndex.matchLine}. */
export interface WatchMatch {
  name: string;
  line: string;
  regex: RegExp;
  tags: string[];
  labels: string[];
  repeat: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compile a single watch config entry into a {@link CompiledWatch}.
 * Returns `null` if the regex pattern is invalid (graceful degradation).
 */
function compileWatch(
  name: string,
  config: NamedWatchConfigMap[string],
): CompiledWatch | null {
  let regex: RegExp;
  try {
    regex = new RegExp(config.pattern);
  } catch {
    return null;
  }

  return {
    name,
    regex,
    stream: config.stream,
    repeat: config.repeat,
    tags: config.tags,
    labels: config.labels,
  };
}

/**
 * Route a compiled watch into the correct stream buckets.
 * Watches with `stream: "both"` are added to both buckets.
 */
function routeToStreams(
  watch: CompiledWatch,
  stdout: CompiledWatch[],
  stderr: CompiledWatch[],
): void {
  if (watch.stream === "stdout" || watch.stream === "both") {
    stdout.push(watch);
  }
  if (watch.stream === "stderr" || watch.stream === "both") {
    stderr.push(watch);
  }
}

// ---------------------------------------------------------------------------
// WatchIndex
// ---------------------------------------------------------------------------

/**
 * Pre-compiled index of named watch patterns, partitioned by output stream.
 *
 * Constructed once from a {@link NamedWatchConfigMap} and then used for
 * efficient line matching against stdout/stderr. Invalid regex entries are
 * silently skipped.
 */
export class WatchIndex {
  private readonly stdoutWatches: CompiledWatch[];
  private readonly stderrWatches: CompiledWatch[];

  constructor(watches: NamedWatchConfigMap) {
    const stdout: CompiledWatch[] = [];
    const stderr: CompiledWatch[] = [];

    for (const [name, config] of Object.entries(watches)) {
      const compiled = compileWatch(name, config);
      if (compiled) routeToStreams(compiled, stdout, stderr);
    }

    this.stdoutWatches = stdout;
    this.stderrWatches = stderr;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Return all compiled watches that target the given stream. */
  getWatchesForStream(stream: "stdout" | "stderr"): CompiledWatch[] {
    return stream === "stdout" ? this.stdoutWatches : this.stderrWatches;
  }

  /**
   * Test a line against all watches for the given stream.
   * Returns one {@link WatchMatch} per matching watch.
   */
  matchLine(stream: "stdout" | "stderr", line: string): WatchMatch[] {
    const watches = this.getWatchesForStream(stream);
    const matches: WatchMatch[] = [];

    for (const w of watches) {
      if (w.regex.test(line)) {
        matches.push(this.toMatch(w, line));
      }
    }

    return matches;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Build a {@link WatchMatch} from a compiled watch and the matched line. */
  private toMatch(watch: CompiledWatch, line: string): WatchMatch {
    return {
      name: watch.name,
      line,
      regex: watch.regex,
      tags: watch.tags,
      labels: watch.labels,
      repeat: watch.repeat,
    };
  }
}
