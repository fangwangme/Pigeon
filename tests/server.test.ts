import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { PairingManager, generateBase32Token } from "../src/server/pairing";
import { CardClassifier, computeInteractionFingerprint } from "../src/server/card-classifier";
import { PushManager } from "../src/server/push";
import { HerdrClient } from "../src/server/herdr-client";
import { WsServer } from "../src/server/ws-server";
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
      const { token, url } = pairing.createPairingToken();
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

      // Verify token is consumed
      const replay = pairing.exchangeToken(token);
      expect(replay.success).toBe(false);
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
  });
});
