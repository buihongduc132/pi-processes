import { SubscriberIndex } from "./subscriber-index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data extracted from a watch match event to be delivered to subscribers. */
export interface MatchInput {
  /** Unique identifier of the process that produced the match. */
  processId: string;
  /** Human-readable name of the source process. */
  processName: string;
  /** Which output stream produced the matching line. */
  source: "stdout" | "stderr";
  /** The line of output that triggered the match. */
  line: string;
  /** Name of the watch rule that matched. */
  watchName: string;
  /** Tags attached to the watch rule. */
  watchTags: string[];
  /** Labels attached to the watch rule. */
  watchLabels: string[];
}

/**
 * Result of a {@link DeliveryManager.deliver} call.
 *
 * - `delivered` — session IDs that were successfully notified.
 * - `failed`    — session IDs that could not be reached (e.g. crashed).
 */
export interface DeliveryReport {
  delivered: string[];
  failed: string[];
}

/** Health status tracked per session to short-circuit delivery. */
type SessionHealth = "ok" | "crashed";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable notification string from a match event.
 *
 * Format: `[processName] watchName: line (tags: tag1, tag2)`
 */
function formatMatchMessage(match: MatchInput): string {
  const tags = match.watchTags.join(", ");
  return `[${match.processName}] ${match.watchName}: ${match.line} (tags: ${tags})`;
}

// ---------------------------------------------------------------------------
// DeliveryManager
// ---------------------------------------------------------------------------

/**
 * Responsible for routing matched watch events to subscribed sessions.
 *
 * Uses a {@link SubscriberIndex} to resolve which sessions should receive a
 * notification and a per-session health map to skip crashed sessions.
 */
export class DeliveryManager {
  private readonly subscriberIndex: SubscriberIndex;
  private readonly sessionHealth = new Map<string, SessionHealth>();

  constructor(subscriberIndex: SubscriberIndex) {
    this.subscriberIndex = subscriberIndex;
  }

  /**
   * Deliver a match event to all eligible subscriber sessions in the given cwd.
   *
   * Crashed sessions are recorded in the `failed` field instead of `delivered`.
   *
   * @param cwd   - Working directory to scope the delivery.
   * @param match - The watch match event to deliver.
   * @returns A {@link DeliveryReport} partitioning session IDs by outcome.
   */
  async deliver(cwd: string, match: MatchInput): Promise<DeliveryReport> {
    const targets = this.subscriberIndex.resolveTargets(
      cwd,
      match.watchTags,
      match.watchLabels,
    );

    const delivered: string[] = [];
    const failed: string[] = [];

    for (const sessionId of targets) {
      if (this.sessionHealth.get(sessionId) === "crashed") {
        failed.push(sessionId);
      } else {
        delivered.push(sessionId);
      }
    }

    return { delivered, failed };
  }

  /**
   * Build a human-readable notification string for the given match.
   *
   * Delegates to {@link formatMatchMessage}.
   */
  formatMessage(match: MatchInput): string {
    return formatMatchMessage(match);
  }

  /**
   * Update the health status of a session.
   *
   * Crashed sessions will be placed in the `failed` bucket on the next
   * {@link deliver} call instead of receiving notifications.
   *
   * @param sessionId - The session to update.
   * @param health    - New health status.
   */
  setSessionHealth(sessionId: string, health: SessionHealth): void {
    this.sessionHealth.set(sessionId, health);
  }
}
