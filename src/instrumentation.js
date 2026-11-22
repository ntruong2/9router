export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Boot-time app init (watchdog, tunnel resume, pricing sync, quota schedulers, ...).
    // The root layout also imports bootstrap, but most dashboard pages are prerendered, so after a
    // deploy that import only ran once someone opened a dynamically rendered page — sometimes
    // never. bootstrap is idempotent (global guard) and skips the build phase.
    await import("@/shared/services/bootstrap");
  }
}
