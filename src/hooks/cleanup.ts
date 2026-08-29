import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProcessManager } from "../manager";

export function setupCleanupHook(pi: ExtensionAPI, manager: ProcessManager) {
  pi.on("session_shutdown", (event) => {
    // Reload keeps the host session alive (extensions rebuilt, manager
    // singleton reused). Killing processes and rmSync-ing logDir on reload
    // orphans a stale manager whose logDir no longer exists — every later
    // process.start fails with ENOENT on proc_N-stdout.log. Only run the
    // destructive cleanup on a terminal shutdown.
    if ((event as { reason?: string } | undefined)?.reason === "reload") return;
    manager.stopWatcher();
    manager.shutdownKillAll();
    manager.cleanup();
  });
}
