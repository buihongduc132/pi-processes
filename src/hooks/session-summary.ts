import { Registry } from "../registry";
import { HeartbeatManager } from "../heartbeat";
import { ProcessLister, type ProcessSummary } from "./process-list";
import { type WatchSubscription, SubscriberIndex } from "../subscriber-index";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Count total running processes across current and sibling sessions.
 */
function countRunning(summary: ProcessSummary): number {
  return summary.current.running.length + summary.siblings.running.length;
}

/**
 * Count total completed/terminated processes across current and sibling sessions.
 */
function countCompleted(summary: ProcessSummary): number {
  return (
    summary.siblings.recentCompleted.length +
    (summary.current.lastCompleted ? 1 : 0)
  );
}

/**
 * Build a human-readable multi-line summary string from a ProcessSummary.
 *
 * Output format:
 * ```
 * Process Summary (N running, M terminated):
 *   Running: proc-a, proc-b
 *   Completed: proc-c (exited)
 *   Siblings: sibling-1, sibling-2
 * ```
 */
function formatSummary(summary: ProcessSummary): string {
  const runningCount = countRunning(summary);
  const completedCount = countCompleted(summary);

  const lines: string[] = [
    `Process Summary (${runningCount} running, ${completedCount} terminated):`,
  ];

  if (summary.current.running.length > 0) {
    lines.push(
      `  Running: ${summary.current.running.map((p) => p.name).join(", ")}`,
    );
  }

  if (summary.current.lastCompleted) {
    const p = summary.current.lastCompleted;
    lines.push(`  Completed: ${p.name} (${p.status})`);
  }

  if (
    summary.siblings.running.length > 0 ||
    summary.siblings.recentCompleted.length > 0
  ) {
    const names = [
      ...summary.siblings.running.map((p) => p.name),
      ...summary.siblings.recentCompleted.map((p) => p.name),
    ];
    lines.push(`  Siblings: ${names.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SessionSummaryHook
// ---------------------------------------------------------------------------

/**
 * Hook that produces a human-readable process summary at session lifecycle
 * events (start and turn-end).
 *
 * Responsibilities:
 * - **onSessionStart**: fetches the current process summary and optionally
 *   registers a watch subscription for tag/label-based notifications.
 * - **onTurnEnd**: delegates to {@link ProcessLister.getSummary} which
 *   restores the current session's terminated processes, refreshes the
 *   heartbeat, and prunes stale sessions before summarizing.
 */
export class SessionSummaryHook {
  constructor(
    private readonly registry: Registry,
    private readonly heartbeatManager: HeartbeatManager,
    private readonly processLister: ProcessLister,
    private readonly subscriberIndex: SubscriberIndex,
  ) {}

  /**
   * Called when a session starts. Registers an optional watch subscription
   * and returns a formatted summary of all processes in the same cwd.
   *
   * @param cwd         - Absolute working directory to scope the query.
   * @param sessionId   - Unique session identifier.
   * @param watchConfig - Optional watch subscription to register for this session.
   * @returns Formatted multi-line process summary string.
   */
  onSessionStart(
    cwd: string,
    sessionId: string,
    watchConfig?: WatchSubscription,
  ): string {
    try {
      if (!cwd) return 'Process Summary unavailable.';

      if (watchConfig) {
        this.subscriberIndex.subscribe(sessionId, cwd, watchConfig);
      }

      const summary = this.processLister.getSummary(cwd, sessionId);
      return formatSummary(summary);
    } catch {
      return 'Process Summary unavailable.';
    }
  }

  /**
   * Called after each agent turn. Delegates to {@link ProcessLister.getSummary}
   * which handles heartbeat refresh, stale-session pruning, and process
   * restoration before returning the formatted summary.
   *
   * @param cwd       - Absolute working directory to scope the query.
   * @param sessionId - Unique session identifier.
   * @returns Formatted multi-line process summary string.
   */
  onTurnEnd(cwd: string, sessionId: string): string {
    try {
      if (!cwd) return 'Process Summary unavailable.';

      const summary = this.processLister.getSummary(cwd, sessionId);
      return formatSummary(summary);
    } catch {
      return 'Process Summary unavailable.';
    }
  }
}
