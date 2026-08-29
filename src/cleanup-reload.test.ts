import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "./manager";
import { setupCleanupHook } from "./hooks/cleanup";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-proc-cleanup-test-"));
}

type Handler = (event: unknown) => void | Promise<void>;

function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    on: (name: string, fn: Handler) => {
      handlers[name] = handlers[name] ?? [];
      handlers[name].push(fn);
    },
    emit: (name: string, event: unknown) =>
      Promise.all((handlers[name] ?? []).map((fn) => fn(event))),
  };
}

describe("cleanup hook — session_shutdown reason guard", () => {
  let manager: ProcessManager;

  afterEach(() => {
    manager.cleanup();
  });

  it("skips kill-all + logDir removal when reason=reload", async () => {
    manager = new ProcessManager();
    const killAll = vi.spyOn(manager, "shutdownKillAll");
    const cleanup = vi.spyOn(manager, "cleanup");
    const pi = fakePi();
    setupCleanupHook(pi as never, manager);

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    expect(killAll).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs full cleanup on terminal shutdown (no reason)", async () => {
    manager = new ProcessManager();
    const killAll = vi.spyOn(manager, "shutdownKillAll");
    const cleanup = vi.spyOn(manager, "cleanup");
    const pi = fakePi();
    setupCleanupHook(pi as never, manager);

    await pi.emit("session_shutdown", { type: "session_shutdown" });

    expect(killAll).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });
});

describe("manager.start — logDir resilience", () => {
  let manager: ProcessManager;
  let cwd: string;

  afterEach(() => {
    manager.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("recreates externally-deleted logDir instead of ENOENT", () => {
    manager = new ProcessManager();
    cwd = tmpCwd();
    // Simulate external deletion (tmpfiles cleaner / stale-singleton scenario).
    rmSync(manager["logDir"], { recursive: true, force: true });
    expect(existsSync(manager["logDir"])).toBe(false);

    const info = manager.start("resilient", "echo ok", cwd);

    expect(existsSync(info.stdoutFile)).toBe(true);
    expect(existsSync(info.stderrFile)).toBe(true);
  });
});
