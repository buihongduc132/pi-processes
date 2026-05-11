import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single managed process tracked in the registry. */
export interface ProcessEntry {
  name: string;
  command: string;
  status: string;
  pid: number;
  startTime: number;
  tags: string[];
  labels: string[];
}

/** Processes belonging to a single session. */
export interface SessionData {
  lastHeartbeatAt?: number;
  processes: Record<string, ProcessEntry>;
}

/** All sessions sharing the same working directory. */
export interface CwdGroup {
  sessions: Record<string, SessionData>;
}

/** Top-level on-disk registry structure. */
export interface RegistryData {
  version: number;
  cwdIndex: Record<string, CwdGroup>;
}

/** Sentinel version written to new registry files. */
const REGISTRY_VERSION = 1;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * CWD-grouped durable process registry backed by a JSON file.
 *
 * Processes are organised as:
 *   cwdIndex[cwd].sessions[sessionId].processes[processId]
 *
 * Writes are buffered in memory and flushed to disk lazily (on read) or
 * eagerly (on first write). Removals cascade: deleting the last process
 * prunes the session; deleting the last session prunes the cwd entry.
 */
export class Registry {
  private readonly filePath: string;
  private data: RegistryData;
  private dirty = false;
  /** Whether this instance has persisted to disk at least once. */
  private flushed = false;

  constructor(registryPath: string) {
    this.filePath = registryPath;
    this.data = this.load();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Replace all processes for a session under a given cwd.
   * Flushes eagerly on the very first write so the file exists on disk.
   * Optional `meta` merges extra session-level fields (e.g. lastHeartbeatAt).
   */
  write(
    sessionId: string,
    cwd: string,
    processes: Record<string, ProcessEntry>,
    meta?: Partial<Pick<SessionData, "lastHeartbeatAt">>,
  ): void {
    if (!this.data.cwdIndex[cwd]) {
      this.data.cwdIndex[cwd] = { sessions: {} };
    }
    const existing = this.data.cwdIndex[cwd].sessions[sessionId];
    this.data.cwdIndex[cwd].sessions[sessionId] = {
      ...existing,
      ...meta,
      processes,
    };
    this.dirty = true;

    if (!this.flushed) {
      this.flush();
    }
  }

  /**
   * Read all sessions grouped under a cwd.
   * Flushes pending writes first so file and memory stay in sync.
   */
  readCwd(cwd: string): CwdGroup | null {
    this.flushIfDirty();
    return this.data.cwdIndex[cwd] ?? null;
  }

  /**
   * Read a single session's processes under a cwd.
   * Flushes pending writes first so file and memory stay in sync.
   */
  readSession(cwd: string, sessionId: string): SessionData | null {
    this.flushIfDirty();
    return this.data.cwdIndex[cwd]?.sessions[sessionId] ?? null;
  }

  /**
   * Remove a single process. Cascades to prune empty sessions and cwd groups.
   */
  removeProcess(cwd: string, sessionId: string, processId: string): void {
    const group = this.data.cwdIndex[cwd];
    if (!group?.sessions[sessionId]) return;

    delete group.sessions[sessionId].processes[processId];
    this.dirty = true;
    this.pruneIfEmpty(cwd, sessionId);
  }

  /**
   * Return all cwd paths that have sessions.
   * Flushes pending writes first.
   */
  listCwds(): string[] {
    this.flushIfDirty();
    return Object.keys(this.data.cwdIndex);
  }

  /**
   * Remove an entire session entry. Cascades to prune empty cwd groups.
   */
  removeSession(cwd: string, sessionId: string): void {
    const group = this.data.cwdIndex[cwd];
    if (!group) return;

    delete group.sessions[sessionId];
    this.dirty = true;
    this.pruneCwdIfEmpty(cwd);
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private load(): RegistryData {
    if (!existsSync(this.filePath)) {
      return this.emptyData();
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as RegistryData;
    } catch {
      // Corrupt or unreadable file — start fresh; will overwrite on next flush.
      return this.emptyData();
    }
  }

  private flushIfDirty(): void {
    if (!this.dirty) return;
    this.flush();
  }

  private flush(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.data), "utf-8");
    this.dirty = false;
    this.flushed = true;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Return a blank registry structure. */
  private emptyData(): RegistryData {
    return { version: REGISTRY_VERSION, cwdIndex: {} };
  }

  /** Prune a session if it has no processes; then prune the cwd if empty. */
  private pruneIfEmpty(cwd: string, sessionId: string): void {
    const group = this.data.cwdIndex[cwd];
    if (!group) return;

    const session = group.sessions[sessionId];
    if (session && Object.keys(session.processes).length === 0) {
      delete group.sessions[sessionId];
    }
    this.pruneCwdIfEmpty(cwd);
  }

  /** Prune a cwd entry if it has no sessions. */
  private pruneCwdIfEmpty(cwd: string): void {
    const group = this.data.cwdIndex[cwd];
    if (group && Object.keys(group.sessions).length === 0) {
      delete this.data.cwdIndex[cwd];
    }
  }
}
