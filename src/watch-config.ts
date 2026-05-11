import type { LogWatchStream } from "./constants/types";

/**
 * A fully-resolved watch configuration entry.
 * All optional fields are filled with defaults after parsing.
 */
export interface NamedWatchConfig {
  /** Regex pattern to match against process output lines. */
  pattern: string;
  /** Which output stream(s) to watch. Defaults to `"both"`. */
  stream: LogWatchStream;
  /** Whether to keep matching after the first hit. Defaults to `false`. */
  repeat: boolean;
  /** Arbitrary string tags for categorization. Defaults to `[]`. */
  tags: string[];
  /** Arbitrary string labels for categorization. Defaults to `[]`. */
  labels: string[];
}

/** Map of named watch configs keyed by watch name. */
export type NamedWatchConfigMap = Record<string, NamedWatchConfig>;

const VALID_STREAMS: ReadonlySet<string> = new Set(["stdout", "stderr", "both"]);

/** Check whether a string is a valid regular expression. */
function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that `value` is an array of strings (or absent), and return
 * a defensive copy or the empty default.
 */
function toStringArray(value: unknown, field: string, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array (${context})`);
  }
  return [...(value as string[])];
}

/**
 * Validate a single watch config entry and fill in defaults.
 *
 * @param entry  - Raw config value to validate.
 * @param context - Human-readable label for error messages (e.g. `watch "my-watch"`).
 * @returns A fully-resolved {@link NamedWatchConfig}.
 * @throws If required fields are missing or values are invalid.
 */
function validateEntry(entry: unknown, context: string): NamedWatchConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`Invalid watch config: ${context} must be an object`);
  }

  const obj = entry as Record<string, unknown>;

  // pattern is required
  if (typeof obj.pattern !== "string" || obj.pattern.length === 0) {
    throw new Error(
      `pattern is required and must be a non-empty string (${context})`,
    );
  }

  if (!isValidRegex(obj.pattern)) {
    throw new Error(
      `Invalid regex pattern "${obj.pattern}" (${context})`,
    );
  }

  // stream validation
  if (obj.stream !== undefined && !VALID_STREAMS.has(obj.stream as string)) {
    throw new Error(
      `Invalid stream value "${obj.stream}" – must be stdout, stderr, or both (${context})`,
    );
  }

  return {
    pattern: obj.pattern,
    stream: (obj.stream as LogWatchStream) ?? "both",
    repeat: (obj.repeat as boolean) ?? false,
    tags: toStringArray(obj.tags, "tags", context),
    labels: toStringArray(obj.labels, "labels", context),
  };
}

/**
 * Parse a raw watch config value into a normalized {@link NamedWatchConfigMap}.
 *
 * Accepts two input formats:
 * - **Dict format** (preferred): `Record<string, { pattern, stream?, repeat?, tags?, labels? }>`
 * - **Legacy array format**: `Array<{ pattern, stream?, repeat? }>` — auto-migrated with `watch_N` keys.
 *
 * Returns an empty map for `null`, `undefined`, or empty inputs.
 *
 * @throws If any entry has an invalid or missing `pattern`, an invalid `stream`,
 *         or non-array `tags`/`labels`.
 */
export function parseWatchConfig(input: unknown): NamedWatchConfigMap {
  if (input == null || (typeof input === "object" && Object.keys(input as object).length === 0)) {
    return {};
  }

  // Dict format
  if (typeof input === "object" && !Array.isArray(input)) {
    const result: NamedWatchConfigMap = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = validateEntry(value, `watch "${key}"`);
    }
    return result;
  }

  // Legacy array format
  if (Array.isArray(input)) {
    const result: NamedWatchConfigMap = {};
    for (let i = 0; i < input.length; i++) {
      result[`watch_${i}`] = validateEntry(input[i], `watch at index ${i}`);
    }
    return result;
  }

  return {};
}
