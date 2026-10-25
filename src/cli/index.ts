import { connect } from "node:net";
import { existsSync } from "node:fs";
import { PigeonDaemon } from "../server/daemon";
import { ConfigManager } from "../server/config-manager";
import qrcode from "qrcode-terminal";

const ADMIN_TIMEOUT_MS = 5000;

function sendAdminCommand(adminSocketPath: string, method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!existsSync(adminSocketPath)) {
      return reject(new Error(`Pigeon daemon is not running (no admin socket at ${adminSocketPath}).`));
    }
    const socket = connect(adminSocketPath, () => {
      socket.write(JSON.stringify({ method, params, id: "cli" }) + "\n");
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Pigeon daemon did not answer '${method}' within ${ADMIN_TIMEOUT_MS / 1000}s.`));
    }, ADMIN_TIMEOUT_MS);

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
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
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
  pigeon start [--port <n>] [--insecure-dev] [--herdr-sock <path>] [--public-url <url>]
  pigeon pair [--ephemeral] [--json]
  pigeon devices [revoke <id>]
  pigeon status
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "start";
  const configManager = new ConfigManager();
  const adminSocketPath = configManager.getServerConfig().adminSocketPath;

  if (command === "start") {
    let port: number | undefined;
    let insecureDev: boolean | undefined;
    let herdrSocketPath: string | undefined;
    let publicUrl: string | undefined;

    for (let i = 1; i < args.length; i++) {
      const value = args[i + 1];
      if (args[i] === "--port" && value) {
        port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid --port '${value}'`);
        i++;
      } else if (args[i] === "--insecure-dev") {
        insecureDev = true;
      } else if (args[i] === "--herdr-sock" && value) {
        herdrSocketPath = value;
        i++;
      } else if (args[i] === "--public-url" && value) {
        publicUrl = value;
        i++;
      } else {
        fail(`Unknown option '${args[i]}'\n${USAGE}`);
      }
    }

    const daemon = new PigeonDaemon({ configManager, port, insecureDev, herdrSocketPath, publicBaseUrl: publicUrl });
    await daemon.start();
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
    console.log("Pigeon status:", await sendAdminCommand(adminSocketPath, "status"));
  } else {
    console.log(USAGE);
  }
}

if (import.meta.main) {
  main().catch((err) => fail(`Error: ${err instanceof Error ? err.message : String(err)}`));
}
