// Test preload: builds the PWA and regenerates the modules embedded in the daemon
// (src/server/embedded-html.ts, src/server/pwa-assets.ts), so `bun test` also checks that the
// client builds and never runs against a stale or missing bundle.
const proc = Bun.spawnSync(["bun", "run", "build:client"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) {
  console.error(proc.stdout.toString(), proc.stderr.toString());
  throw new Error("Client build failed (bun run build:client)");
}
