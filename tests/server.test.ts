import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { PairingManager, generateBase32Token } from "../src/server/pairing";
import { CardClassifier, computeInteractionFingerprint } from "../src/server/card-classifier";
import { PushManager } from "../src/server/push";
import { HerdrClient } from "../src/server/herdr-client";
import { WsServer } from "../src/server/ws-server";
import { ConfigManager } from "../src/server/config-manager";
import { PigeonDaemon } from "../src/server/daemon";
import { ProtocolErrors } from "../src/types/protocol";

describe("Pigeon Server Implementation Suite", () => {
  describe("Pairing & Admin Socket Subsystem", () => {
    const adminSock = `/tmp/test_pigeon_admin_${Date.now()}.sock`;
    const pairing = new PairingManager({
      publicBaseUrl: "https://pigeon.example.ts.net",
      insecureDev: false,
      adminSocketPath: adminSock,
    });

    beforeAll(async () => {
      await pairing.startAdminSocket();
    });

    afterAll(() => {
      pairing.stopAdminSocket();
    });

    test("Base32 pairing token conforms to 26-char Base32 format", () => {
      const token = generateBase32Token(16);
      expect(token).toHaveLength(26);
      expect(/^[A-Z2-7]{26}$/.test(token)).toBe(true);
    });

    test("Token exchange succeeds and enforces 5-attempt rate limit lockout", () => {
      const { token, url } = pairing.createPairingToken({ singleUse: true });
      expect(url).toContain("#code=" + token);

      // Invalid code attempts
      for (let i = 0; i < 4; i++) {
        const fail = pairing.exchangeToken("INVALIDCODE12345678901234");
        expect(fail.success).toBe(false);
      }

      // Valid exchange
      const ok = pairing.exchangeToken(token, "Android Chrome");
      expect(ok.success).toBe(true);
      expect(ok.sessionToken).toBeDefined();
      expect(ok.deviceId).toMatch(/^dev_/);

      // Validate session
      const session = pairing.validateSession(ok.sessionToken);
      expect(session).not.toBeNull();
      expect(session?.deviceName).toBe("Android Chrome");

      // Verify single-use token is consumed
      const replay = pairing.exchangeToken(token);
      expect(replay.success).toBe(false);
    });

    test("Permanent pairing token never expires and allows multiple device pairings", () => {
      const { token, url, expiresAt, permanent } = pairing.createPairingToken({ permanent: true });
      expect(permanent).toBe(true);
      expect(expiresAt).toBe(0);

      const d1 = pairing.exchangeToken(token, "Phone");
      expect(d1.success).toBe(true);

      const d2 = pairing.exchangeToken(token, "Tablet");
      expect(d2.success).toBe(true);
    });

    test("Persists permanent token and sessions to devices.json across restarts (P0-2)", () => {
      const testDevicesPath = `/tmp/test-pigeon-devices-${Date.now()}.json`;
      try {
        const pm1 = new PairingManager({
          publicBaseUrl: "https://pigeon.local",
          devicesFilePath: testDevicesPath,
        });

        const { token } = pm1.createPairingToken({ permanent: true });
        const ex = pm1.exchangeToken(token, "Persistent Phone");
        expect(ex.success).toBe(true);
        expect(ex.sessionToken).toBeDefined();

        expect(existsSync(testDevicesPath)).toBe(true);
        const stat = statSync(testDevicesPath);
        // Verify 0600 file mode
        expect(stat.mode & 0o777).toBe(0o600);

        // Instantiate second manager pointing to the exact same file (simulating daemon restart)
        const pm2 = new PairingManager({
          publicBaseUrl: "https://pigeon.local",
          devicesFilePath: testDevicesPath,
        });

        // Token should be recovered
        const activeToken = pm2.getActiveToken();
        expect(activeToken).not.toBeNull();
        expect(activeToken?.token).toBe(token);

        // Session should be valid on the new manager instance without re-pairing
        const recoveredSession = pm2.validateSession(ex.sessionToken);
        expect(recoveredSession).not.toBeNull();
        expect(recoveredSession?.deviceName).toBe("Persistent Phone");
      } finally {
        try {
          unlinkSync(testDevicesPath);
        } catch {}
      }
    });

    test("Cookie name uses __Host- prefix in secure mode", () => {
      expect(pairing.getCookieName()).toBe("__Host-pigeon_session");
      const insecurePairing = new PairingManager({
        publicBaseUrl: "http://192.168.1.50:4100",
        insecureDev: true,
      });
      expect(insecurePairing.getCookieName()).toBe("pigeon_session");
    });
  });

  describe("Card Classifier & Stream Parsing", () => {
    const classifier = new CardClassifier();

    test("Classifies command output into tool_call card", () => {
      const screen = "$ bun test\n✓ 7 tests pass\nexit code: 0\n";
      const { cards } = classifier.classifyScreen(screen);
      expect(cards.length).toBeGreaterThanOrEqual(1);

      const toolCard = cards.find((c) => c.kind === "tool_call");
      expect(toolCard).toBeDefined();
      expect((toolCard as any).command).toBe("bun test");
      expect((toolCard as any).exitCode).toBe(0);
      expect((toolCard as any).status).toBe("done");
    });

    test("Classifies unified diff into diff card with line stats", () => {
      const screen = "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1,3 +1,3 @@\n- const exp = 100;\n+ const exp = 200;\n";
      const { cards } = classifier.classifyScreen(screen);

      const diffCard = cards.find((c) => c.kind === "diff");
      expect(diffCard).toBeDefined();
      expect((diffCard as any).filePath).toBe("src/auth.ts");
      expect((diffCard as any).additions).toBe(1);
      expect((diffCard as any).deletions).toBe(1);
    });

    test("Classifies interactive prompt and generates stable fingerprint", () => {
      const screen = "Allow Claude to execute this command?\n[1] Yes, execute\n[2] No\n";
      const { cards, pendingInteraction } = classifier.classifyScreen(screen);

      expect(pendingInteraction).not.toBeNull();
      expect(pendingInteraction?.question).toContain("Allow Claude");
      expect(pendingInteraction?.options.length).toBe(2);
      expect(pendingInteraction?.fingerprint).toMatch(/^fp_/);

      const manualFp = computeInteractionFingerprint(
        "Allow Claude to execute this command?",
        "[1] Yes, execute\n[2] No",
        pendingInteraction!.options
      );
      expect(pendingInteraction?.fingerprint).toBe(manualFp);
    });
  });

  describe("Web Push & Presence Suppression", () => {
    const push = new PushManager("/tmp/test_vapid.json");

    test("Loads or generates VAPID ECDSA P-256 keys", () => {
      const pubKey = push.getPublicKey();
      expect(pubKey).toBeDefined();
      expect(pubKey.length).toBeGreaterThan(30);
    });

    test("Presence suppression suppresses notification when client is actively viewing target pane", async () => {
      const deviceId = "dev_test_1";
      const paneId = "w1:p2";

      // Initially not viewing: should not suppress
      expect(push.shouldSuppressPush(paneId)).toBe(false);

      // Client viewing pane and visible
      push.updatePresence(deviceId, true, paneId);
      expect(push.shouldSuppressPush(paneId)).toBe(true);

      const result = await push.sendNotification(paneId, {
        title: "Test Alert",
        body: "Prompt",
      });
      expect(result.suppressed).toBe(true);
      expect(result.sent).toBe(0);

      // Client screen off / backgrounded
      push.updatePresence(deviceId, false, paneId);
      expect(push.shouldSuppressPush(paneId)).toBe(false);
    });
  });

  describe("Herdr Adapter & 5-State Normalization", () => {
    const client = new HerdrClient();

    test("Normalizes all 5 lifecycle states correctly, treating 'done' as input-ready", () => {
      expect(client.normalizeStatus("idle")).toBe("idle");
      expect(client.normalizeStatus("working")).toBe("working");
      expect(client.normalizeStatus("blocked")).toBe("blocked");
      expect(client.normalizeStatus("done")).toBe("done");
      expect(client.normalizeStatus("completed")).toBe("done");
      expect(client.normalizeStatus("anything_else")).toBe("unknown");
    });

    test("Validates agent start name regex: [a-z][a-z0-9_-]{0,31}", () => {
      expect(client.validateAgentName("claude")).toBe(true);
      expect(client.validateAgentName("claude-code_1")).toBe(true);
      expect(client.validateAgentName("9invalid")).toBe(false);
      expect(client.validateAgentName("A_invalid")).toBe(false);
      expect(client.validateAgentName("a".repeat(33))).toBe(false);
    });
  });

  describe("WebSocket Protocol & Safe Interaction Responder", () => {
    const pairing = new PairingManager({ publicBaseUrl: "http://localhost:4100", insecureDev: true });
    const push = new PushManager("/tmp/test_vapid2.json");
    const herdr = new HerdrClient();
    const wsServer = new WsServer({ herdrClient: herdr, pairingManager: pairing, pushManager: push });

    test("Rejects stale or mismatched interaction fingerprints with ERR_INTERACTION_STALE", async () => {
      const paneId = "w1:p1";
      const state = herdr.getPaneState(paneId);

      // Set up pending interaction with fingerprint
      state.pendingInteraction = {
        id: "card_int_1",
        kind: "interaction",
        interactionId: "int_abc",
        title: "Confirm delete",
        question: "Delete build folder?",
        fingerprint: "fp_expected_123",
        options: [{ id: "opt_yes", label: "Yes", keyShortcut: "y" }],
        fallbackKeys: ["enter"],
      };

      let sentMessage: any = null;
      const fakeWs: any = {
        data: {
          session: { deviceId: "dev_mock" },
          subscribedPaneId: paneId,
          lastPingTime: Date.now(),
        },
        send: (str: string) => {
          sentMessage = JSON.parse(str);
        },
      };

      // Mismatched fingerprint
      await wsServer.handleMessage(
        fakeWs,
        JSON.stringify({
          type: "interaction_respond",
          id: "cmd_1",
          payload: {
            targetPaneId: paneId,
            interactionId: "int_abc",
            fingerprint: "fp_STALE_WRONG",
            optionId: "opt_yes",
          },
        })
      );

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.type).toBe("error");
      expect(sentMessage.error.code).toBe(ProtocolErrors.ERR_INTERACTION_STALE);
    });

    test("Rejects unknown optionId with ERR_INVALID_PAYLOAD", async () => {
      const paneId = "w1:p1";
      const state = herdr.getPaneState(paneId);
      state.pendingInteraction = {
        id: "card_int",
        kind: "interaction",
        interactionId: "int_valid",
        title: "Test",
        question: "Approve?",
        fingerprint: "fp_CORRECT",
        options: [{ id: "opt_yes", label: "Yes" }],
        fallbackKeys: ["enter"],
      };

      let sentMessage: any = null;
      const fakeWs: any = {
        data: {
          session: { deviceId: "dev_mock" },
          subscribedPaneId: paneId,
          lastPingTime: Date.now(),
        },
        send: (str: string) => {
          sentMessage = JSON.parse(str);
        },
      };

      await wsServer.handleMessage(
        fakeWs,
        JSON.stringify({
          type: "interaction_respond",
          id: "cmd_2",
          payload: {
            targetPaneId: paneId,
            interactionId: "int_valid",
            fingerprint: "fp_CORRECT",
            optionId: "opt_NONEXISTENT",
          },
        })
      );

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.type).toBe("error");
      expect(sentMessage.error.code).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    });

    test("Revoking device disconnects active WebSocket session immediately", () => {
      let closed = false;
      let closeCode: number | undefined;

      const fakeWs: any = {
        data: {
          session: { deviceId: "dev_to_revoke" },
          subscribedPaneId: "w1:p1",
          lastPingTime: Date.now(),
        },
        send: () => {},
        close: (code: number) => {
          closed = true;
          closeCode = code;
        },
      };

      wsServer.handleOpen(fakeWs);
      expect(wsServer.getConnectedClientsCount()).toBe(1);

      wsServer.closeDevice("dev_to_revoke");
      expect(closed).toBe(true);
      expect(closeCode).toBe(1008);
      expect(wsServer.getConnectedClientsCount()).toBe(0);
    });

    test("Rejects unknown message types with ERR_INVALID_PAYLOAD loudly (P0-5)", async () => {
      let sentMessage: any = null;
      const fakeWs: any = {
        data: {
          session: { deviceId: "dev_mock" },
          subscribedPaneId: "w1:p1",
          lastPingTime: Date.now(),
        },
        send: (str: string) => {
          sentMessage = JSON.parse(str);
        },
      };

      await wsServer.handleMessage(
        fakeWs,
        JSON.stringify({
          type: "nonexistent_command_type",
          id: "cmd_bad_99",
        })
      );

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.type).toBe("error");
      expect(sentMessage.replyTo).toBe("cmd_bad_99");
      expect(sentMessage.error.code).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
      expect(sentMessage.error.message).toContain("Unsupported or unhandled message type");
    });

    test("Multi-device multi-pane monitoring maintains active pane set concurrently (P0-4)", () => {
      herdr.addMonitoredPane("w1:p1");
      herdr.addMonitoredPane("w1:p2");
      herdr.addMonitoredPane("w2:p1");

      const monitored = herdr.getMonitoredPaneIds();
      expect(monitored).toContain("w1:p1");
      expect(monitored).toContain("w1:p2");
      expect(monitored).toContain("w2:p1");

      // Removing one device's pane doesn't affect other devices
      herdr.removeMonitoredPane("w1:p1");
      const remaining = herdr.getMonitoredPaneIds();
      expect(remaining).not.toContain("w1:p1");
      expect(remaining).toContain("w1:p2");
      expect(remaining).toContain("w2:p1");
    });
  });

  describe("Configuration Management & Persistence Subsystem", () => {
    const testConfigPath = `/tmp/test_pigeon_cfg_${Date.now()}.json`;

    afterAll(() => {
      try {
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
      } catch {}
    });

    test("ConfigManager initializes default config file on startup", () => {
      const cfgMgr = new ConfigManager(testConfigPath, 50);
      expect(existsSync(testConfigPath)).toBe(true);

      const cfg = cfgMgr.getConfig();
      expect(cfg.server).toBeDefined();
      expect(cfg.server.port).toBe(4100);
      expect(cfg.client).toBeDefined();
      expect(cfg.client.themeKey).toBe("gruvbox");
      expect(cfg.client.themeMode).toBe("system");
      expect(cfg.client.macros).toHaveLength(5);
    });

    test("Deep merge retains unmodified server and client configurations", () => {
      const cfgMgr = new ConfigManager(testConfigPath, 50);
      const originalServerPort = cfgMgr.getServerConfig().port;
      const originalMacrosCount = cfgMgr.getClientConfig().macros.length;

      // Patch theme only
      cfgMgr.patchClientConfig({ themeKey: "solarized", themeMode: "light" });
      cfgMgr.flush();

      // Verify in memory
      expect(cfgMgr.getClientConfig().themeKey).toBe("solarized");
      expect(cfgMgr.getClientConfig().themeMode).toBe("light");
      expect(cfgMgr.getClientConfig().macros).toHaveLength(originalMacrosCount);
      expect(cfgMgr.getServerConfig().port).toBe(originalServerPort);

      // Verify from disk file
      const raw = JSON.parse(readFileSync(testConfigPath, "utf-8"));
      expect(raw.client.themeKey).toBe("solarized");
      expect(raw.client.themeMode).toBe("light");
      expect(raw.client.macros).toHaveLength(originalMacrosCount);
      expect(raw.server.port).toBe(originalServerPort);
    });

    test("WebSocket config_get and config_patch with broadcast synchronization", async () => {
      const cfgMgr = new ConfigManager(testConfigPath, 50);
      const herdr = new HerdrClient();
      const pairing = new PairingManager({ publicBaseUrl: "http://localhost:4100", insecureDev: true });
      const push = new PushManager();
      const wsServer = new WsServer({
        herdrClient: herdr,
        pairingManager: pairing,
        pushManager: push,
        configManager: cfgMgr,
        insecureDev: true,
      });

      // 1. Client 1 connects and sends hello
      let client1Welcome: any = null;
      const client1: any = {
        data: {
          session: { deviceId: "dev_c1" },
          subscribedPaneId: "w1:p1",
          lastPingTime: Date.now(),
        },
        send: (str: string) => {
          const msg = JSON.parse(str);
          if (msg.type === "welcome") client1Welcome = msg;
        },
      };
      wsServer.handleOpen(client1);
      await wsServer.handleMessage(client1, JSON.stringify({ type: "hello", id: "h1" }));
      expect(client1Welcome).not.toBeNull();
      expect(client1Welcome.payload.clientConfig.themeKey).toBe("solarized");

      // 2. Client 2 connects
      let client2Updated: any = null;
      const client2: any = {
        data: {
          session: { deviceId: "dev_c2" },
          subscribedPaneId: "w1:p1",
          lastPingTime: Date.now(),
        },
        send: (str: string) => {
          const msg = JSON.parse(str);
          if (msg.type === "config_updated") client2Updated = msg;
        },
      };
      wsServer.handleOpen(client2);

      // 3. Client 1 sends config_get
      let client1Sync: any = null;
      client1.send = (str: string) => {
        const msg = JSON.parse(str);
        if (msg.type === "config_sync") client1Sync = msg;
      };
      await wsServer.handleMessage(client1, JSON.stringify({ type: "config_get", id: "cg1" }));
      expect(client1Sync).not.toBeNull();
      expect(client1Sync.payload.client.themeKey).toBe("solarized");

      // 4. Client 1 sends config_patch to change theme
      let client1Ack: any = null;
      client1.send = (str: string) => {
        const msg = JSON.parse(str);
        if (msg.type === "ack") client1Ack = msg;
      };
      await wsServer.handleMessage(
        client1,
        JSON.stringify({
          type: "config_patch",
          id: "cp1",
          payload: { client: { themeKey: "catppuccin", themeId: "catppuccin" } },
        })
      );

      expect(client1Ack).not.toBeNull();
      expect(client1Ack.replyTo).toBe("cp1");
      expect(cfgMgr.getClientConfig().themeKey).toBe("catppuccin");

      // Verify Client 2 received broadcast
      expect(client2Updated).not.toBeNull();
      expect(client2Updated.payload.client.themeKey).toBe("catppuccin");
    });
  });

  describe("Daemon Security & WebSocket Origin Safeguards (P0-3)", () => {
    const testPort = 4195;
    const testAdminSock = `/tmp/pigeon_sec_test_${Date.now()}.sock`;
    const testDevicesPath = `/tmp/pigeon_sec_devices_${Date.now()}.json`;
    let daemon: PigeonDaemon;

    beforeAll(async () => {
      daemon = new PigeonDaemon({
        port: testPort,
        insecureDev: true,
        adminSocketPath: testAdminSock,
        devicesFilePath: testDevicesPath,
        publicBaseUrl: `http://localhost:${testPort}`,
      });
      await daemon.start();
    });

    afterAll(() => {
      daemon.stop();
      try {
        if (existsSync(testAdminSock)) unlinkSync(testAdminSock);
        if (existsSync(testDevicesPath)) unlinkSync(testDevicesPath);
      } catch {}
    });

    const testWsKey = Buffer.from("pigeon_test_nonce_key").toString("base64");

    test("Rejects WebSocket upgrade without session cookie with 401 Unauthorized", async () => {
      const res = await fetch(`http://localhost:${testPort}/ws`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": testWsKey,
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(res.status).toBe(401);
    });

    test("Rejects WebSocket ?token= query parameter bypass per P0-3", async () => {
      // Create a valid pairing token and exchange for session
      const { token } = daemon.pairingManager.createPairingToken();
      const exchangeRes = daemon.pairingManager.exchangeToken(token, "Test Device");
      expect(exchangeRes.success).toBe(true);
      const sessionToken = exchangeRes.sessionToken!;

      // Attempt using ?token= query param without cookie
      const res = await fetch(`http://localhost:${testPort}/ws?token=${sessionToken}`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": testWsKey,
          "Sec-WebSocket-Version": "13",
        },
      });
      // Must be rejected with 401 (no query param bypass allowed)
      expect(res.status).toBe(401);
    });

    test("Rejects cross-origin WebSocket requests from malicious Origin with 403 Forbidden", async () => {
      const res = await fetch(`http://localhost:${testPort}/ws`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": testWsKey,
          "Sec-WebSocket-Version": "13",
          Origin: "http://malicious-attacker.com",
        },
      });
      expect(res.status).toBe(403);
    });

    test("Rejects unauthenticated push subscription POST requests with 401", async () => {
      const res = await fetch(`http://localhost:${testPort}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/xyz" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
