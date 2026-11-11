import { connect } from "node:net";
import { existsSync } from "node:fs";
import { PigeonDaemon } from "../server/daemon";
import { ConfigManager, portScoped, resolveInstancePaths } from "../server/config-manager";
import qrcode from "qrcode-terminal";

export const ADMIN_TIMEOUT_MS = 5000;

/** The daemon behind the admin socket is not running (no socket, or nothing listening on it). */
export class DaemonNotRunningError extends Error {}

export function sendAdminCommand(
  adminSocketPath: string,
  method: string,
  params: Record<string, any> = {},
  timeoutMs: number = ADMIN_TIMEOUT_MS
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!existsSync(adminSocketPath)) {
      return reject(new DaemonNotRunningError(`Pigeon daemon is not running (no admin socket at ${adminSocketPath}).`));
    }
    const socket = connect(adminSocketPath, () => {
      socket.write(JSON.stringify({ method, params, id: "cli" }) + "\n");
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Pigeon daemon did not answer '${method}' within ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      socket.end();
      const res = JSON.parse(buffer.trim());
      if (res.error) reject(new Error(res.error.message));
      else resolve(res.result);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // A socket file left behind by a daemon that exited.
      if (err.code === "ECONNREFUSED") reject(new DaemonNotRunningError(`Pigeon daemon is not running (nothing listens on ${adminSocketPath}).`));
      else reject(err);
    });
  });
}

function printQr(url: string, permanent: boolean): void {
  console.log("\n=======================================================");
  console.log("             PIGEON TERMINAL PAIRING QR CODE           ");
  console.log("=======================================================\n");
  console.log(`Pairing URL: ${url}\n`);
  qrcode.generate(url, { small: true });
  console.log("\nScan the QR code above with your phone's Chromium browser.");
  console.log(permanent ? "This pairing link stays valid until you run `pigeon pair` again." : "This pairing link expires in 10 minutes.");
  console.log("=======================================================\n");
}

const USAGE = `
Pigeon — Mobile Remote Client for Herdr

Usage:
  pigeon start [--port <n>] [--insecure-dev] [--herdr-app-sock <path>] [--herdr-core-sock <path>] [--public-url <url>] [--admin-sock <path>]
  pigeon pair [--ephemeral] [--json] [--port <n>]
  pigeon devices [revoke <id>] [--port <n>]
  pigeon status [--port <n>]
  pigeon rebuild-cache [--json] [--port <n>] [--yes]

The admin commands reach the daemon on the configured port, or on --port.
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "start";

  const portIdx = args.indexOf("--port");
  let cliPort: number | undefined;
  if (portIdx !== -1) {
    const val = args[portIdx + 1];
    cliPort = Number(val);
    if (!Number.isInteger(cliPort) || cliPort < 1 || cliPort > 65535) {
      fail(`Invalid --port '${val}'`);
    }
  }

  // Load config from instance's state directory if --port was specified, else production
  const configPath = cliPort ? resolveInstancePaths({ port: cliPort }).configPath : undefined;
  const configManager = new ConfigManager(configPath ? { path: configPath, port: cliPort } : undefined);
  const adminPort = cliPort ?? configManager.getServerConfig().port;
  const adminSocketPath = resolveInstancePaths({ port: adminPort, env: configManager.env }).adminSocketPath;

  if (command === "start") {
    let port: number | undefined = cliPort;
    let insecureDev: boolean | undefined;
    let herdrAppSocketPath: string | undefined;
    let herdrCoreSocketPath: string | undefined;
    let publicUrl: string | undefined;
    let adminSocketPath: string | undefined;

    for (let i = 1; i < args.length; i++) {
      const value = args[i + 1];
      if (args[i] === "--port" && value) {
        port = cliPort;
        i++;
      } else if (args[i] === "--insecure-dev") {
        insecureDev = true;
      } else if (args[i] === "--herdr-app-sock" && value) {
        herdrAppSocketPath = value;
        i++;
      } else if (args[i] === "--herdr-core-sock" && value) {
        herdrCoreSocketPath = value;
        i++;
      } else if (args[i] === "--public-url" && value) {
        publicUrl = value;
        i++;
      } else if (args[i] === "--admin-sock" && value) {
        adminSocketPath = value;
        i++;
      } else {
        fail(`Unknown option '${args[i]}'\n${USAGE}`);
      }
    }

    const daemon = new PigeonDaemon({ configManager, port, insecureDev, herdrAppSocketPath, herdrCoreSocketPath, publicBaseUrl: publicUrl, adminSocketPath });
    await daemon.start();
    daemon.fillModelCatalog();
    console.log(`Pigeon daemon listening on port ${daemon.config.port} (insecureDev=${daemon.config.insecureDev})`);

    // Reuse the stored permanent link; only `pigeon pair` rotates it.
    const active = daemon.pairingManager.getActiveToken();
    const tokenInfo = active
      ? { ...active, url: `${daemon.config.publicBaseUrl}/pair#code=${active.token}` }
      : daemon.pairingManager.createPairingToken();
    printQr(tokenInfo.url, tokenInfo.permanent);

    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else if (command === "pair") {
    const res = await sendAdminCommand(adminSocketPath, "pair.create", { ephemeral: args.includes("--ephemeral") });
    if (args.includes("--json")) console.log(JSON.stringify(res, null, 2));
    else printQr(res.url, res.permanent);
  } else if (command === "devices") {
    if (args[1] === "revoke") {
      if (!args[2]) fail("Usage: pigeon devices revoke <deviceId>");
      const res = await sendAdminCommand(adminSocketPath, "devices.revoke", { deviceId: args[2] });
      console.log(res.revoked ? `Device ${args[2]} revoked.` : `No device with id ${args[2]}.`);
    } else {
      const list = await sendAdminCommand(adminSocketPath, "devices.list");
      console.log("Paired devices:", list);
    }
  } else if (command === "status") {
    const status: any = await sendAdminCommand(adminSocketPath, "status");
    if (args.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log("Pigeon status:");
      console.log(`  Herdr connected:   ${status.herdrConnected ? "yes" : "no"}`);
      console.log(`  Public URL:        ${status.publicBaseUrl}`);
      console.log(`  Active sessions:   ${status.activeSessions}`);
      if (status.queues && Object.keys(status.queues).length > 0) {
        console.log("  Queues:");
        for (const [pane, q] of Object.entries(status.queues as Record<string, any>)) {
          console.log(`    Pane ${pane}: length=${q.length}, state=${q.state}`);
        }
      }
      if (status.lastUsageScan) {
        const timeStr = status.lastUsageScan.time ? new Date(status.lastUsageScan.time).toISOString() : "never";
        console.log(`  Last usage scan:   ${timeStr} (${status.lastUsageScan.durationMs || 0}ms)`);
      }
      if (status.sourceErrors) {
        console.log("  Source errors:");
        for (const [src, err] of Object.entries(status.sourceErrors)) {
          console.log(`    ${src}: ${err || "none"}`);
        }
      }
    }
  } else if (command === "rebuild-cache") {
    if (adminPort !== 4100 && !args.includes("--yes")) {
      fail("Refusing to rebuild shared usage cache from test instance without --yes.");
    }
    console.log("Rebuilding usage database from all sources...");
    let res: any;
    try {
      res = await sendAdminCommand(adminSocketPath, "usage.rebuild", {}, 120_000);
    } catch (err) {
      if (!(err instanceof DaemonNotRunningError)) throw err;
      // No daemon: rebuild the same database directly.
      const { UsageService } = await import("../server/usage/index");
      const service = new UsageService({ configManager, autoScan: false });
      try {
        res = await service.rebuild();
      } finally {
        service.destroy();
      }
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log("\nRebuild complete:");
      console.log(`  Scanned files: ${res.scannedFiles?.toLocaleString() ?? 0}`);
      console.log(`  Records added: ${res.recordsAdded?.toLocaleString() ?? 0}`);
      console.log(`  Total tokens:  ${res.totalTokens?.toLocaleString() ?? 0}`);
      console.log(`  Total cost:    $${Number(res.totalCost || 0).toFixed(2)}`);
    }
  } else {
    console.log(USAGE);
  }
}

if (import.meta.main) {
  main().catch((err) => fail(`Error: ${err instanceof Error ? err.message : String(err)}`));
}
