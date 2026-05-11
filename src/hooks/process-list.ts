import { ProcessEntry, Registry, SessionData } from "../registry";
import { HeartbeatManager } from "../heartbeat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated view of processes for a session and its siblings in the same cwd. */
export interface ProcessSummary {
  /** Processes owned by the requesting session. */
  current: { running: ProcessEntry[]; lastCompleted: ProcessEntry | null };
  /** Processes owned by other sessions sharing the same cwd. */
  siblings: { running: ProcessEntry[]; recentCompleted: ProcessEntry[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Terminal statuses that represent a finished process. */
const COMPLETED_STATUSES: ReadonlySet<string> = new Set(["exited", "terminated", "killed"]);

/** Live statuses that represent an active (non-completed) process. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "terminating", "terminate_timeout"]);

/** Whether a process is in a terminal (non-running) state. */
function isCompleted(proc: ProcessEntry): boolean {
  return COMPLETED_STATUSES.has(proc.status);
}

/**
 * Restore any processes marked "terminated" back to "running" for a live session.
 *
 * When a session is detected as stale, its processes are marked "terminated".
 * If the session is actually alive (e.g. it restarted), this flips them back.
 */
function restoreTerminated(
  processes: Record<string, ProcessEntry>,
): Record<string, ProcessEntry> {
  const result: Record<string, ProcessEntry> = {};
  for (const [id, proc] of Object.entries(processes)) {
    result[id] = proc.status === "terminated"
      ? { ...proc, status: "running" }
      : proc;
  }
  return result;
}

/** The most recently started process among completed entries, or null. */
function findLatestCompleted(
  processes: ProcessEntry[],
): ProcessEntry | null {
  let latest: ProcessEntry | null = null;
  for (const proc of processes) {
    if (isCompleted(proc) && (!latest || proc.startTime > latest.startTime)) {
      latest = proc;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// ProcessLister
// ---------------------------------------------------------------------------

/**
 * Provides a aggregated view of running and completed processes for a given
 * session and its sibling sessions within the same working directory.
 *
 * On each {@link ProcessLister.getSummary} call:
 * 1. Restores any "terminated" processes in the current session to "running".
 * 2. Prunes stale sessions via the heartbeat manager.
 * 3. Partitions remaining processes into current vs sibling buckets.
 */
export class ProcessLister {
  constructor(
    private readonly registry: Registry,
    private readonly heartbeatManager: HeartbeatManager,
  ) {}

  /**
   * Build a process summary for the given session within its cwd group.
   *
   * @param cwd       - Absolute working directory to scope the query.
   * @param sessionId - The requesting session's identifier.
   * @returns A {@link ProcessSummary} partitioning processes by ownership and status.
   */
  getSummary(cwd: string, sessionId: string): ProcessSummary {
    this.restoreCurrentSession(cwd, sessionId);
    this.heartbeatManager.pruneStale(cwd);

    const group = this.registry.readCwd(cwd);
    if (!group) {
      return emptySummary();
    }

    return this.partitionProcesses(group.sessions, sessionId);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Restore terminated processes in the current session and bump its heartbeat. */
  private restoreCurrentSession(cwd: string, sessionId: string): void {
    const currentSession = this.registry.readSession(cwd, sessionId);
    if (!currentSession) return;

    const restored = restoreTerminated(currentSession.processes);
    this.registry.write(sessionId, cwd, restored, {
      lastHeartbeatAt: Date.now(),
    });
  }

  /**
   * Split all processes in a cwd group into current vs sibling buckets.
   *
   * - Current session: running processes + the single latest completed process.
   * - Sibling sessions: all running + all completed processes.
   */
  private partitionProcesses(
    sessions: Record<string, SessionData>,
    sessionId: string,
  ): ProcessSummary {
    const currentRunning: ProcessEntry[] = [];
    const siblingsRunning: ProcessEntry[] = [];
    const siblingsCompleted: ProcessEntry[] = [];

    for (const [sid, session] of Object.entries(sessions)) {
      const processes = Object.values(session.processes);

      if (sid === sessionId) {
        for (const proc of processes) {
          if (LIVE_STATUSES.has(proc.status)) currentRunning.push(proc);
        }
      } else {
        for (const proc of processes) {
          if (LIVE_STATUSES.has(proc.status)) {
            siblingsRunning.push(proc);
          } else if (isCompleted(proc)) {
            siblingsCompleted.push(proc);
          }
        }
      }
    }

    return {
      current: {
        running: currentRunning,
        lastCompleted: findLatestCompleted(
          Object.values(sessions[sessionId]?.processes ?? {}),
        ),
      },
      siblings: { running: siblingsRunning, recentCompleted: siblingsCompleted.slice(-50) },
    };
  }
}

/** Returns a summary with zero processes in all buckets. */
function emptySummary(): ProcessSummary {
  return {
    current: { running: [], lastCompleted: null },
    siblings: { running: [], recentCompleted: [] },
  };
}
