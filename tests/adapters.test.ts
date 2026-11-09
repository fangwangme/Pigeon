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
          directory text,
          title text,
          time_updated integer,
          time_archived integer,
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
        "INSERT INTO session_v2 (id, directory, title, time_updated, summary_additions, summary_deletions, summary_files, summary_diffs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "ses_mock_1",
          "/work",
          "Test Session",
          2000,
          15,
          5,
          2,
          JSON.stringify([
            { filePath: "src/main.ts", status: "modified", additions: 10, deletions: 2 },
            { filePath: "src/util.ts", status: "created", additions: 5, deletions: 3 },
          ]),
        ]
      );

      // Insert untitled session to test first-prompt fallback
      db.run(
        "INSERT INTO session_v2 (id, directory, title, time_updated) VALUES (?, ?, ?, ?)",
        ["ses_untitled", "/work", null, 3000]
      );
      db.run(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
        ["msg_u_untitled", "ses_untitled", "user", 1, 3000, JSON.stringify({ text: "First prompt fallback title" })]
      );

      // Insert placeholder-titled session (agent-session-normalization.md §2.1)
      db.run(
        "INSERT INTO session_v2 (id, directory, title, time_updated) VALUES (?, ?, ?, ?)",
        ["ses_placeholder", "/work", "New session - 2026-11-07T14:30:00.000Z", 4000]
      );
      db.run(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
        ["msg_u_placeholder", "ses_placeholder", "user", 1, 4000, JSON.stringify({ text: "Placeholder prompt" })]
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

      const { turns, stats, sessionTitle } = adapter.getTurns("ses_mock_1");
      expect(turns.length).toBe(1);
      expect(sessionTitle).toBe("Test Session"); // §2.1, §3

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
      expect(tc.target).toBe("bun test");
      expect(tc.status).toBe("completed");
      expect(tc.exitCode).toBe(0);
      expect(tc.output).toContain("5 tests passed");
      expect(tc.durationMs).toBe(400);

      // Ordered items (§3)
      expect(turn.items?.map((i) => i.kind)).toEqual(["tool", "text"]);

      // Assistant Text
      expect(turn.assistantResponse?.markdown).toContain("| 列1 | 列2 |");
      expect(turn.assistantResponse?.markdown).toContain("已修复完成！");

      // Stats
      expect(stats?.filesModified).toBe(2);
      expect(stats?.additions).toBe(15);
      expect(stats?.deletions).toBe(5);
      expect(stats?.diffs?.length).toBe(2);
    });

    test("an OpenCode session whose title is the placeholder carries no sessionTitle, and one with a real title carries it (agent-session-normalization.md §2.1)", () => {
      const adapter = new OpenCodeAdapter({ dbPath: mockDbPath });
      expect(adapter.getTurns("ses_mock_1").sessionTitle).toBe("Test Session");
      expect(adapter.getTurns("ses_placeholder").sessionTitle).toBeUndefined();
      expect(adapter.getTurns("ses_untitled").sessionTitle).toBeUndefined();
    });

    test("OpenCode session listing falls back to the first prompt when title is empty or placeholder (agent-session-normalization.md §2.1, protocol.md §4.10)", () => {
      const mgr = new AgentAdapterManager({ opencode: { dbPath: mockDbPath } });
      expect(mgr.listSessions("opencode", "/work")).toEqual([
        { id: "ses_placeholder", title: "Placeholder prompt", updatedAt: 4000 },
        { id: "ses_untitled", title: "First prompt fallback title", updatedAt: 3000 },
        { id: "ses_mock_1", title: "Test Session", updatedAt: 2000 },
      ]);
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
      expect(turn.toolCalls![0].target).toBe("bun test");
      expect(turn.toolCalls![0].output).toContain("29 pass");
      expect(turn.items?.map((i) => i.kind)).toEqual(["tool", "text"]);
      expect(turn.assistantResponse?.markdown).toBe("所有模块已就绪并测试通过。");
    });

    test("Reads full line from transcript_full.jsonl when truncated_fields is present (§2.2)", () => {
      const brain = join(testDir, "brain_trunc");
      const logs = join(brain, "s_trunc", ".system_generated", "logs");
      const annots = join(testDir, "annotations");
      mkdirSync(logs, { recursive: true });
      mkdirSync(annots, { recursive: true });
      writeFileSync(join(annots, "s_trunc.pbtxt"), 'title: "Truncated Session"\n');
      writeFileSync(
        join(logs, "transcript.jsonl"),
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>hi</USER_REQUEST>", created_at: new Date(1000).toISOString() }) +
          "\n" +
          JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "trunc...", truncated_fields: ["content"], created_at: new Date(2000).toISOString() }) +
          "\n"
      );
      writeFileSync(
        join(logs, "transcript_full.jsonl"),
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>hi</USER_REQUEST>", created_at: new Date(1000).toISOString() }) +
          "\n" +
          JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "full untruncated response", created_at: new Date(2000).toISOString() }) +
          "\n"
      );
      const adapter = new AgyAdapter({ baseBrainDir: brain });
      const { turns, sessionTitle } = adapter.getTurns("s_trunc");
      expect(sessionTitle).toBe("Truncated Session");
      expect(turns[0].assistantResponse?.markdown).toBe("full untruncated response");
    });

    test("a line written in two parts is parsed once, whole, after its newline arrives (§4.2)", () => {
      const brain = join(testDir, "brain_split");
      const logs = join(brain, "s", ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      const logFile = join(logs, "transcript.jsonl");
      const first = JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() });
      const second = JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>第二个问题</USER_REQUEST>", created_at: new Date(2000).toISOString() });
      const cut = second.indexOf("第二") + 1;
      writeFileSync(logFile, first + "\n" + second.slice(0, cut));
      const adapter = new AgyAdapter({ baseBrainDir: brain });
      expect(adapter.getTurns("s", true).turns.map((t) => t.userPrompt?.text)).toEqual(["first"]);
      writeFileSync(logFile, second.slice(cut) + "\n", { flag: "a" });
      expect(adapter.getTurns("s", true).turns.map((t) => t.userPrompt?.text)).toEqual(["first", "第二个问题"]);
    });

    test("Extracts model from USER_SETTINGS_CHANGE event in transcript (§2.2)", () => {
      const brain = join(testDir, "brain_model");
      const logs = join(brain, "s_model", ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      const logFile = join(logs, "transcript.jsonl");
      const line1 = JSON.stringify({
        step_index: 0,
        type: "USER_SETTINGS_CHANGE",
        content: "The user changed setting `Model Selection` from `Gemini 2.5 Flash` to `Gemini 3.8 Flash (Medium)`.",
        created_at: new Date(1000).toISOString(),
      });
      const line2 = JSON.stringify({
        step_index: 1,
        type: "USER_INPUT",
        content: "<USER_REQUEST>test</USER_REQUEST>",
        created_at: new Date(2000).toISOString(),
      });
      writeFileSync(logFile, `${line1}\n${line2}\n`, "utf-8");
      const adapter = new AgyAdapter({ baseBrainDir: brain });
      const { model } = adapter.getTurns("s_model", false);
      expect(model).toBe("Gemini 3.8 Flash (Medium)");
    });

    test("Extracts diffs and computes session stats for edit_file and write_file", () => {
      const brain = join(testDir, "brain_diffs");
      const logs = join(brain, "s_diffs", ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      const logFile = join(logs, "transcript.jsonl");

      const line0 = JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>update code</USER_REQUEST>",
        created_at: new Date(1000).toISOString(),
      });
      // edit_file with quoted args as generated in transcript.jsonl
      const line1 = JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "edit_file",
            args: {
              Path: '"/workspace/src/foo.ts"',
              Target: '"const a = 1;\\nconst b = 2;"',
              Replacement: '"const a = 1;\\nconst b = 3;\\nconst c = 4;"',
            },
          },
          {
            name: "write_file",
            args: {
              Path: '"/workspace/src/bar.ts"',
              Content: '"line1\\nline2\\n"',
              Overwrite: '"true"',
            },
          },
          {
            name: "write_file",
            args: {
              Path: '"/workspace/src/new.ts"',
              Content: '"hello world\\n"',
            },
          },
        ],
        created_at: new Date(2000).toISOString(),
      });

      writeFileSync(logFile, `${line0}\n${line1}\n`, "utf-8");
      const adapter = new AgyAdapter({ baseBrainDir: brain });
      const { turns, stats } = adapter.getTurns("s_diffs", false);

      expect(turns).toHaveLength(1);
      const calls = turns[0].toolCalls!;
      expect(calls).toHaveLength(3);

      // 1. edit_file
      expect(calls[0].verb).toBe("edit");
      expect(calls[0].target).toBe("/workspace/src/foo.ts");
      expect(calls[0].diff).toBeDefined();
      expect(calls[0].diff?.status).toBe("modified");
      expect(calls[0].diff?.additions).toBe(2);
      expect(calls[0].diff?.deletions).toBe(1);

      // 2. write_file with overwrite -> edit
      expect(calls[1].verb).toBe("edit");
      expect(calls[1].target).toBe("/workspace/src/bar.ts");
      expect(calls[1].diff).toBeDefined();
      expect(calls[1].diff?.status).toBe("modified");
      expect(calls[1].diff?.additions).toBe(3);

      // 3. write_file new file -> create
      expect(calls[2].verb).toBe("create");
      expect(calls[2].target).toBe("/workspace/src/new.ts");
      expect(calls[2].diff).toBeDefined();
      expect(calls[2].diff?.status).toBe("created");
      expect(calls[2].diff?.additions).toBe(2);

      // Cumulative stats
      expect(stats).toBeDefined();
      expect(stats?.filesModified).toBe(3);
      expect(stats?.additions).toBe(7);
      expect(stats?.deletions).toBe(1);
      expect(stats?.diffs).toHaveLength(3);
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
