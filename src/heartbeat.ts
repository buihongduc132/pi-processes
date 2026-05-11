import { Registry, SessionData, ProcessEntry } from "./registry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default time-to-live for heartbeat entries (60 seconds). */
const DEFAULT_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a prune operation on one or more sessions. */
export interface PruneResult {
  prunedSessions: string[];
  terminatedProcesses: string[];
}

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

/**
 * Tracks session liveness via periodic heartbeat timestamps and prunes
 * stale sessions from the {@link Registry}.
 *
 * A session is considered **stale** when its last heartbeat is older than
 * the configured TTL (default 60 s) or when it has no heartbeat at all.
 * Pruning a stale session:
 * 1. Marks all its **running** processes as `"terminated"`.
 * 2. Removes the session entirely if it has no remaining processes.
 */
export class HeartbeatManager {
  private readonly registry: Registry;
  private readonly defaultTtlMs: number;

  constructor(registry: Registry, options?: { defaultTtlMs?: number }) {
    this.registry = registry;
    this.defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Write a heartbeat timestamp for the given session.
   * Preserves existing processes while updating `lastHeartbeatAt`.
   */
  heartbeat(sessionId: string, cwd: string): void {
    const existing = this.registry.readSession(cwd, sessionId);
    const processes = existing?.processes ?? {};
    this.registry.write(sessionId, cwd, processes, {
      lastHeartbeatAt: Date.now(),
    });
  }

  /**
   * Prune stale sessions for a specific cwd.
   *
   * - Sessions with heartbeat older than TTL (or no heartbeat) are stale.
   * - Running processes in stale sessions are marked `"terminated"`.
   * - Stale sessions with **no** processes are removed entirely.
   * - Stale sessions with **no running** processes are skipped (already pruned).
   */
  pruneStale(cwd: string): PruneResult {
    const result: PruneResult = {
      prunedSessions: [],
      terminatedProcesses: [],
    };

    const group = this.registry.readCwd(cwd);
    if (!group) return result;

    for (const sessionId of Object.keys(group.sessions)) {
      const session = this.registry.readSession(cwd, sessionId);
      if (!session || !this.isStale(session)) continue;

      this.pruneSession(cwd, sessionId, session, result);
    }

    return result;
  }

  /**
   * Prune stale sessions across **all** cwds.
   * Aggregates results from per-cwd pruning into a single result.
   */
  pruneAll(): PruneResult {
    const result: PruneResult = {
      prunedSessions: [],
      terminatedProcesses: [],
    };

    for (const cwd of this.registry.listCwds()) {
      const partial = this.pruneStale(cwd);
      result.prunedSessions.push(...partial.prunedSessions);
      result.terminatedProcesses.push(...partial.terminatedProcesses);
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Whether a session's heartbeat has expired or is missing entirely. */
  private isStale(session: SessionData): boolean {
    const lastHb = session.lastHeartbeatAt;
    return lastHb === undefined || Date.now() - lastHb > this.defaultTtlMs;
  }

  /**
   * Prune a single stale session: terminate running processes and optionally
   * remove the session entirely if it has no processes.
   */
  private pruneSession(
    cwd: string,
    sessionId: string,
    session: SessionData,
    result: PruneResult,
  ): void {
    const processIds = Object.keys(session.processes);

    // No processes — remove entire session.
    if (processIds.length === 0) {
      this.registry.removeSession(cwd, sessionId);
      result.prunedSessions.push(sessionId);
      return;
    }

    // Collect running process ids.
    const runningIds = processIds.filter(
      (id) => session.processes[id].status === "running",
    );

    // No running processes — already pruned, skip.
    if (runningIds.length === 0) return;

    // Terminate running processes and write back.
    result.prunedSessions.push(sessionId);
    const updated = this.terminateRunning(session.processes, runningIds, result);
    this.registry.write(sessionId, cwd, updated);
  }

  /**
   * Return a copy of `processes` with all `runningIds` set to `"terminated"`.
   * Appends terminated ids to `result.terminatedProcesses`.
   */
  private terminateRunning(
    processes: Record<string, ProcessEntry>,
    runningIds: string[],
    result: PruneResult,
  ): Record<string, ProcessEntry> {
    const runningSet = new Set(runningIds);
    const updated: Record<string, ProcessEntry> = {};

    for (const [id, proc] of Object.entries(processes)) {
      if (runningSet.has(id)) {
        result.terminatedProcesses.push(id);
        updated[id] = { ...proc, status: "terminated" };
      } else {
        updated[id] = proc;
      }
    }

    return updated;
  }
}
