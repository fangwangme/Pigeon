import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { OpenCodeAdapter } from "../src/server/agent-adapters/opencode";
import { AgyAdapter } from "../src/server/agent-adapters/agy";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { tempDir } from "./helpers/fixtures";

// agent-session-normalization.md §2.1 (OpenCode) and §2.2 (Antigravity).
describe("structured session adapters (agent-session-normalization.md §2)", () => {
  const testDir = tempDir("adapters");

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  describe("OpenCode SQLite Adapter", () => {
    const mockDbPath = join(testDir, "mock_opencode.db");

    beforeAll(() => {
      const db = new Database(mockDbPath);
      db.run(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          title text,
          summary_additions integer,
          summary_deletions integer,
          summary_files integer,
          summary_diffs text
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          data text NOT NULL
        );
      `);

      // Insert mock session
      db.run(
        "INSERT INTO session_v2 (id, title, summary_additions, summary_deletions, summary_files, summary_diffs) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "ses_mock_1",
          "Test Session",
          15,
          5,
          2,
          JSON.stringify([
            { filePath: "src/main.ts", status: "modified", additions: 10, deletions: 2 },
            { filePath: "src/util.ts", status: "created", additions: 5, deletions: 3 },
          ]),
        ]
      );

      // Insert User Message
      db.run(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "msg_u1",
          "ses_mock_1",
          "user",
          1,
          1000,
          JSON.stringify({ text: "请修复表格显示问题", files: ["src/main.ts"] }),
        ]
      );

      // Insert Assistant Message with reasoning, tool call, and text
      db.run(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "msg_a1",
          "ses_mock_1",
          "assistant",
          2,
          2000,
          JSON.stringify({
            content: [
              {
                type: "reasoning",
                text: "需要使用 overflow-x: auto 来解决宽度溢出",
                time: { created: 1000, completed: 2500 },
              },
              {
                type: "tool",
                id: "call_tool_1",
                name: "bash",
                state: {
                  status: "completed",
                  input: { command: "bun test" },
                  output: "✓ 5 tests passed\n",
                  exitCode: 0,
                },
                time: { ran: 2000, completed: 2400 },
              },
              {
                type: "text",
                text: "| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |\n已修复完成！",
              },
            ],
          }),
        ]
      );

      db.close();
    });

    test("Reads SQLite in read-only mode and parses into NormalizedTurns", () => {
      const adapter = new OpenCodeAdapter({ dbPath: mockDbPath });
      expect(adapter.isAvailable()).toBe(true);

      const { turns, stats } = adapter.getTurns("ses_mock_1");
      expect(turns.length).toBe(1);

      const turn = turns[0];
      expect(turn.turnNumber).toBe(1);
      expect(turn.userPrompt?.text).toBe("请修复表格显示问题");
      expect(turn.userPrompt?.files).toEqual(["src/main.ts"]);

      // Reasoning
      expect(turn.reasoning?.text).toContain("overflow-x: auto");
      expect(turn.reasoning?.durationMs).toBe(1500);

      // Tool Call
      expect(turn.toolCalls?.length).toBe(1);
      const tc = turn.toolCalls![0];
      expect(tc.name).toBe("bash");
      expect(tc.status).toBe("completed");
      expect(tc.exitCode).toBe(0);
      expect(tc.output).toContain("5 tests passed");
      expect(tc.durationMs).toBe(400);

      // Assistant Text
      expect(turn.assistantResponse?.markdown).toContain("| 列1 | 列2 |");
      expect(turn.assistantResponse?.markdown).toContain("已修复完成！");

      // Stats
      expect(stats?.filesModified).toBe(2);
      expect(stats?.additions).toBe(15);
      expect(stats?.deletions).toBe(5);
      expect(stats?.diffs?.length).toBe(2);
    });

    test("Gracefully handles non-existent session ID", () => {
      const adapter = new OpenCodeAdapter({ dbPath: mockDbPath });
      const { turns } = adapter.getTurns("ses_non_existent");
      expect(turns.length).toBe(0);
    });
  });

  describe("Antigravity (AGY) JSONL Adapter", () => {
    const agyBrainDir = join(testDir, "brain");
    const sessionId = "agy_test_ses";
    const sessionLogsDir = join(agyBrainDir, sessionId, ".system_generated", "logs");

    beforeAll(() => {
      mkdirSync(sessionLogsDir, { recursive: true });
      const logFile = join(sessionLogsDir, "transcript.jsonl");

      const line1 = JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>重构 Herdr 轮询与审批模块</USER_REQUEST>",
        created_at: new Date(1000).toISOString(),
      });

      const line2 = JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        thinking: "方案已审核通过，开始接入 250ms 防抖读屏与 SHA-256 去重",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: "bun test" },
          },
        ],
        content: "所有模块已就绪并测试通过。",
        created_at: new Date(2000).toISOString(),
      });

      const line3 = JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        content: "✓ 29 pass\n0 fail",
        created_at: new Date(3000).toISOString(),
      });

      writeFileSync(logFile, `${line1}\n${line2}\n${line3}\n`, "utf-8");
    });

    test("Incrementally parses JSONL and extracts clean turns", () => {
      const adapter = new AgyAdapter({ baseBrainDir: agyBrainDir });
      expect(adapter.isAvailable(sessionId)).toBe(true);

      const { turns } = adapter.getTurns(sessionId, true);
      expect(turns.length).toBe(1);

      const turn = turns[0];
      expect(turn.userPrompt?.text).toBe("重构 Herdr 轮询与审批模块");
      expect(turn.reasoning?.text).toContain("SHA-256 去重");
      expect(turn.toolCalls?.length).toBe(1);
      expect(turn.toolCalls![0].name).toBe("run_command");
      expect(turn.toolCalls![0].output).toContain("29 pass");
      expect(turn.assistantResponse?.markdown).toBe("所有模块已就绪并测试通过。");
    });

    test("Protects against incomplete partial line at EOF", () => {
      const adapter = new AgyAdapter({ baseBrainDir: agyBrainDir });
      const logFile = join(sessionLogsDir, "transcript.jsonl");

      // Append incomplete JSON line without trailing newline
      const incomplete = '{"step_index": 3, "type": "USER_INPUT", "content": "正在输入的未';
      writeFileSync(logFile, incomplete, { flag: "a" });

      // Should not throw or crash on incomplete line
      const { turns } = adapter.getTurns(sessionId, true);
      expect(turns.length).toBe(1);
    });
  });

  describe("Antigravity full re-read", () => {
    test("a full read after an incremental read that stopped mid-line still returns the first turn", () => {
      const brain = join(testDir, "brain2");
      const logs = join(brain, "s2", ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      const line = (o: object) => JSON.stringify(o) + "\n";
      writeFileSync(
        join(logs, "transcript.jsonl"),
        line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }) +
          line({ step_index: 1, type: "PLANNER_RESPONSE", content: "done", created_at: new Date(2000).toISOString() }) +
          '{"step_index": 2, "type": "USER_INPUT", "content": "half' // still being written
      );
      const adapter = new AgyAdapter({ baseBrainDir: brain });
      expect(adapter.getTurns("s2", true).turns).toHaveLength(1);
      const { turns } = adapter.getTurns("s2", false);
      expect(turns.map((t) => t.userPrompt?.text)).toEqual(["first"]);
    });
  });

  describe("Agent Adapter Manager", () => {
    test("Routes to correct adapter based on agent kind", () => {
      const mgr = new AgentAdapterManager();
      expect(mgr.isSupported("opencode")).toBe(true);
      expect(mgr.isSupported("OpenCode")).toBe(true);
      expect(mgr.isSupported("agy")).toBe(true);
      expect(mgr.isSupported("bash")).toBe(false);
      expect(mgr.isSupported("htop")).toBe(false);
    });
  });
});
