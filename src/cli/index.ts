import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PigeonDaemon } from "../server/daemon";
import qrcode from "qrcode-terminal";

function sendAdminCommand(method: string, params: Record<string, any> = {}): Promise<any> {
  const adminSocketPath =
    process.env.XDG_RUNTIME_DIR
      ? `${process.env.XDG_RUNTIME_DIR}/pigeon.sock`
      : `${process.env.HOME}/.local/state/pigeon/admin.sock`;

  return new Promise((resolve, reject) => {
    if (!existsSync(adminSocketPath)) {
      return reject(new Error("Pigeon daemon is not running (admin socket not found)."));
    }

    const socket = connect(adminSocketPath, () => {
      socket.write(JSON.stringify({ method, params, id: "cli" }) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      if (buffer.includes("\n")) {
        socket.end();
        try {
          const res = JSON.parse(buffer.trim());
          if (res.error) {
            reject(new Error(res.error.message));
          } else {
            resolve(res.result);
          }
        } catch (e) {
          reject(e);
        }
      }
    });

    socket.on("error", (err) => reject(err));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "start";

  if (command === "start") {
    let port = 4100;
    let insecureDev = false;
    let herdrSocketPath: string | undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[++i], 10);
      } else if (args[i] === "--insecure-dev") {
        insecureDev = true;
      } else if (args[i] === "--herdr-sock" && args[i + 1]) {
        herdrSocketPath = args[++i];
      }
    }

    console.log(`Starting Pigeon Daemon on port ${port}... (insecureDev=${insecureDev})`);

    const daemon = new PigeonDaemon({
      port,
      insecureDev,
      herdrSocketPath,
    });

    await daemon.start();

    // Print initial pairing QR code
    daemon.pairingManager.printTerminalQrCode();
    console.log(`Pigeon Daemon running at ${daemon.config.publicBaseUrl}`);

    process.on("SIGINT", () => {
      console.log("\nShutting down Pigeon daemon...");
      daemon.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      daemon.stop();
      process.exit(0);
    });
  } else if (command === "pair") {
    const jsonOutput = args.includes("--json");
    try {
      const res = await sendAdminCommand("pair.create");
      if (jsonOutput) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log("\n=======================================================");
        console.log("             PIGEON TERMINAL PAIRING QR CODE           ");
        console.log("=======================================================\n");
        console.log(`Pairing URL: ${res.url}\n`);
        qrcode.generate(res.url, { small: true });
        console.log("\nScan the QR code above with your mobile Chromium browser.");
        console.log("=======================================================\n");
      }
    } catch (err: any) {
      console.error("Error generating pairing code:", err.message);
      process.exit(1);
    }
  } else if (command === "devices") {
    const subCmd = args[1];
    if (subCmd === "revoke" && args[2]) {
      const deviceId = args[2];
      try {
        const res = await sendAdminCommand("devices.revoke", { deviceId });
        console.log(`Device ${deviceId} revoked:`, res.revoked);
      } catch (err: any) {
        console.error("Error revoking device:", err.message);
        process.exit(1);
      }
    } else {
      try {
        const list = await sendAdminCommand("devices.list");
        console.log("Paired Devices:", list);
      } catch (err: any) {
        console.error("Error listing devices:", err.message);
        process.exit(1);
      }
    }
  } else if (command === "status") {
    try {
      const status = await sendAdminCommand("status");
      console.log("Pigeon Status:", status);
    } catch (err: any) {
      console.error("Error getting status:", err.message);
      process.exit(1);
    }
  } else {
    console.log(`
Pigeon — Mobile Remote Client for Herdr

Usage:
  pigeon start [--port <n>] [--insecure-dev] [--herdr-sock <path>]
  pigeon pair [--json]
  pigeon devices [revoke <id>]
  pigeon status
`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
