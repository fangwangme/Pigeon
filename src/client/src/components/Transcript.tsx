import { createSignal, ErrorBoundary, For, Index, Match, Show, Switch } from "solid-js";
import { state } from "../state/store";
import { copyText, getDetail } from "../state/ws";
import { renderMarkdown } from "../utils/markdown";
import { callCommand, callInputText } from "../utils/tool-call";
import type { Card, FileDiffSummary, NormalizedToolCall, NormalizedTurn, ToolVerb, TurnItem } from "../../../types/protocol";
import type { IconName } from "../icons";
import { DiffBadge, Icon, Sheet } from "./ui";
import { openImage } from "./overlays";
import { t, type MessageId } from "../i18n";

const VERB_LABEL: Record<ToolVerb, MessageId | null> = { run: "verb.run", edit: "verb.edit", create: "verb.create", read: "verb.read", search: "verb.search", other: null };
const VERB_ICON: Record<ToolVerb, IconName> = { run: "term", edit: "pencil", create: "fileplus", read: "read", search: "search", other: "layers" };
const VERB_COUNT: Record<ToolVerb, MessageId> = {
  read: "transcript.readFiles",
  edit: "transcript.editedFiles",
  create: "transcript.createdFiles",
  run: "transcript.ranCommands",
  search: "transcript.searched",
  other: "transcript.calledTools",
};
const VERB_ORDER: ToolVerb[] = ["read", "search", "edit", "create", "run", "other"];

function markdownHtml(md: string): string {
  const btn = `<button class="cpy" data-copy type="button">${t("common.copy")}</button>`;
  return renderMarkdown(md)
    .replace(/<div class="cb-hdr">([\s\S]*?)<\/div>/g, `<div class="cb-hdr">$1${btn}</div>`)
    .replace(/(?<!<\/div>)<pre>/g, `<div class="cb"><div class="cb-hdr"><span class="cb-lang"></span>${btn}</div><pre>`)
    .replace(/<\/pre>(?!<\/div>)/g, "</pre></div>");
}

function onMarkdownClick(e: MouseEvent): void {
  const target = e.target instanceof Element ? e.target : (e.target as Node | null)?.parentElement;
  const btn = target?.closest("[data-copy]");
  if (!btn) return;
  const pre = btn.closest(".cb")?.querySelector("pre") ?? btn.parentElement?.querySelector("pre");
  if (pre) copyText(pre.textContent ?? "");
}

export function Markdown(props: { md: string }) {
  return <div class="msg" innerHTML={markdownHtml(props.md)} onClick={onMarkdownClick} />;
}

function verbLabel(c: NormalizedToolCall): string {
  const id = VERB_LABEL[c.verb];
  return id ? t(id) : c.name;
}

/** One line for a call: a command with a description shows only the description (§3.3). */
function callLine(c: NormalizedToolCall): string {
  if (c.verb === "run" && c.description) return c.description;
  return `${verbLabel(c)} ${callObject(c)}`.trim();
}

function callObject(c: NormalizedToolCall): string {
  if (c.verb === "run") return c.description || c.target || "";
  return c.target || "";
}

export function isPathCall(c: NormalizedToolCall): boolean {
  return c.verb !== "run" && !!c.target;
}

export function renderPath(path: string): string {
  if (!path) return "";
  return `\u200E${path}\u200E`;
}

function totals(calls: NormalizedToolCall[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const c of calls) {
    add += c.diff?.additions ?? 0;
    del += c.diff?.deletions ?? 0;
  }
  return { add, del };
}

function groupSummary(calls: NormalizedToolCall[]): string {
  const counts = new Map<ToolVerb, number>();
  for (const c of calls) counts.set(c.verb, (counts.get(c.verb) ?? 0) + 1);
  return VERB_ORDER.filter((v) => counts.has(v))
    .map((v) => t(VERB_COUNT[v], { count: counts.get(v)! }))
    .join(t("transcript.listSep"));
}

// ---------- the tool sheet (§3.3) ----------

const [toolSheet, setToolSheet] = createSignal<{ calls: NormalizedToolCall[]; title: string; detail: NormalizedToolCall | null; direct: boolean } | null>(null);

function findTurnForCall(callId: string): string | undefined {
  for (const turn of state.normalizedTurns) {
    if (turn.toolCalls?.some((c) => c.id === callId)) return turn.turnId;
    if (turn.items?.some((i: any) => i.kind === "tool" && i.call?.id === callId)) return turn.turnId;
  }
  return undefined;
}

function loadCallDetailIfNeeded(call: NormalizedToolCall) {
  if (!state.activePaneId || !call.id) return;
  if (call.input !== undefined && call.output !== undefined && (!call.diff || call.diff.patch !== undefined)) return;
  const turnId = findTurnForCall(call.id);
  if (!turnId) return;
  void getDetail({ paneId: state.activePaneId, kind: "tool", turnId, callId: call.id })
    .then((res) => {
      if (res?.call) {
        setToolSheet((cur) => (cur && cur.detail?.id === call.id ? { ...cur, detail: res.call } : cur));
      }
    })
    .catch(() => {});
}

export function openToolDetail(call: NormalizedToolCall): void {
  setToolSheet({ calls: [call], title: callLine(call), detail: call, direct: true });
  loadCallDetailIfNeeded(call);
}

export function openDiffs(path: string, diffs: FileDiffSummary[]): void {
  const call: NormalizedToolCall = { id: `file:${path}`, name: "edit", verb: "edit", target: path, input: {}, status: "completed", diff: undefined };
  setToolSheet({ calls: [call], title: path.split("/").pop() || path, detail: call, direct: true });
  setFileDiffs(diffs);
  if (state.activePaneId && (!diffs.length || !diffs[0].patch)) {
    void getDetail({ paneId: state.activePaneId, kind: "file", filePath: path })
      .then((res) => {
        if (res?.diff) setFileDiffs([res.diff]);
      })
      .catch(() => {});
  }
}

const [fileDiffs, setFileDiffs] = createSignal<FileDiffSummary[] | null>(null);

function Lines(props: { text: string; label: string }) {
  const [all, setAll] = createSignal(false);
  const lines = () => props.text.split("\n");
  const shown = () => (all() ? props.text : lines().slice(0, 40).join("\n"));
  return (
    <>
      <div class="fl">
        <span>{props.label}</span>
        <button onClick={() => copyText(props.text)}>
          <Icon name="copy" sm />
          {t("common.copy")}
        </button>
      </div>
      <div class="fbox mono">{shown()}</div>
      <Show when={!all() && lines().length > 40}>
        <button class="lnk" onClick={() => setAll(true)}>
          {t("transcript.showAllLines", { count: lines().length })}
        </button>
      </Show>
    </>
  );
}

/** A unified diff with line numbers and add/remove bars; lines never wrap (§3.3). */
export function DiffView(props: { patch: string }) {
  const rows = () => {
    const out: Array<{ cls: string; ln: string; text: string }> = [];
    let oldN = 0;
    let newN = 0;
    for (const line of props.patch.split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) continue;
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (h) {
        oldN = Number(h[1]);
        newN = Number(h[2]);
        out.push({ cls: "hh", ln: "", text: line });
      } else if (line.startsWith("+")) out.push({ cls: "a", ln: String(newN++), text: line.slice(1) });
      else if (line.startsWith("-")) out.push({ cls: "d", ln: String(oldN++), text: line.slice(1) });
      else if (line.startsWith("\\")) continue;
      else {
        oldN++;
        out.push({ cls: "", ln: String(newN++), text: line.slice(1) });
      }
    }
    return out;
  };
  return (
    <div class="diff mono">
      <For each={rows()}>
        {(r) => (
          <Show when={r.cls !== "hh"} fallback={<div class="hh">{r.text}</div>}>
            <div class={r.cls}>
              <span class="ln">{r.ln}</span>
              {r.text || " "}
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}

function ToolDetail(props: { call: NormalizedToolCall }) {
  const c = () => props.call;
  const command = () => callCommand(c());
  const patches = () => fileDiffs() ?? (c().diff ? [c().diff!] : []);
  return (
    <Switch
      fallback={
        <>
          <Lines label={t("tool.input")} text={callInputText(c())} />
          <Show when={c().output}>
            <Lines label={t("tool.result")} text={c().output!} />
          </Show>
        </>
      }
    >
      <Match when={c().verb === "run"}>
        <Show when={c().description}>
          <div class="fbox txt" style={{ "margin-top": "4px" }}>
            {c().description}
          </div>
        </Show>
        <Lines label={t("tool.command")} text={command()} />
        <Show when={c().output}>
          <Lines label={t("tool.output")} text={c().output!} />
        </Show>
        <div class="meta">
          <Show when={c().exitCode !== undefined}>
            <span class={c().exitCode !== 0 ? "bad" : ""}>{t("tool.exitCode", { code: c().exitCode! })}</span>
          </Show>
          <Show when={c().durationMs !== undefined}>
            <span>{t("tool.seconds", { seconds: (c().durationMs! / 1000).toFixed(1) })}</span>
          </Show>
          <Show when={c().status === "running"}>
            <span>{t("tool.running")}</span>
          </Show>
        </div>
      </Match>
      <Match when={c().verb === "edit" || c().verb === "create"}>
        <div class="fl">
          <span>{t("plus.file")}</span>
          <button onClick={() => copyText(c().target || "")}>
            <Icon name="copy" sm />
            {t("tool.copyPath")}
          </button>
        </div>
        <div class="fbox mono">{c().target}</div>
        <For each={patches()}>
          {(d) => (
            <>
              <div class="fl">
                <span>{t("tool.changes")}</span>
                <DiffBadge add={d.additions} del={d.deletions} />
              </div>
              <Show when={d.patch} fallback={<p class="note">{t("tool.noPatch")}</p>}>
                <DiffView patch={d.patch!} />
              </Show>
            </>
          )}
        </For>
        <Show when={patches().length === 0}>
          <Lines label={t("tool.input")} text={callInputText(c())} />
        </Show>
      </Match>
    </Switch>
  );
}

export function ToolSheet() {
  const [atBottom, setAtBottom] = createSignal(true);
  const [canScroll, setCanScroll] = createSignal(false);
  const [scrollRatio, setScrollRatio] = createSignal(0);
  let scroller: HTMLDivElement | undefined;

  const handleScroll = () => {
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    setCanScroll(max > 20);
    setScrollRatio(max > 0 ? scroller.scrollTop / max : 0);
    setAtBottom(max - scroller.scrollTop < 24);
  };

  const scrollToBottom = () => {
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  };

  return (
    <Show when={toolSheet()} keyed>
      {(s) => {
        const close = () => {
          setToolSheet(null);
          setFileDiffs(null);
        };
        return (
          <Sheet
            full
            flush
            title={s.detail ? `${verbLabel(s.detail)} ${s.detail.target?.split("/").pop() || ""}`.trim() : s.title}
            onClose={close}
            onBack={s.detail && !s.direct ? () => setToolSheet({ ...s, detail: null }) : undefined}
          >
            <Show when={canScroll()}>
              <div class="scroll-track">
                <div class="scroll-thumb" style={{ width: `${Math.max(10, scrollRatio() * 100)}%` }} />
              </div>
            </Show>
            <div
              class="body"
              ref={(el) => {
                scroller = el;
                setTimeout(handleScroll, 50);
              }}
              onScroll={handleScroll}
            >
              <Show
                when={s.detail}
                fallback={
                  <For each={s.calls}>
                    {(c) => (
                      <button class="tli" onClick={() => { setToolSheet({ ...s, detail: c }); loadCallDetailIfNeeded(c); }}>
                        <Show when={c.status !== "running"} fallback={<span class="spin" style={{ margin: "2px" }} />}>
                          <Icon name={VERB_ICON[c.verb]} />
                        </Show>
                        <div class="tx">
                          <div class="v" style={{ color: c.status === "failed" ? "var(--danger)" : undefined }}>
                            {verbLabel(c)}
                          </div>
                          <div class={`o mono${isPathCall(c) ? " path-rev" : ""}`}>
                            {isPathCall(c) ? renderPath(callObject(c)) : callObject(c)}
                          </div>
                        </div>
                        <DiffBadge add={c.diff?.additions ?? 0} del={c.diff?.deletions ?? 0} />
                        <Icon name="chevR" sm class="tli-chev" />
                      </button>
                    )}
                  </For>
                }
              >
                <ErrorBoundary
                  fallback={(err) => {
                    console.error("[Pigeon] tool detail failed to render:", err);
                    return <p class="note">{t("tool.renderFailed")}</p>;
                  }}
                >
                  <ToolDetail call={s.detail!} />
                </ErrorBoundary>
              </Show>
            </div>
            <Show when={!atBottom()}>
              <button class="jump tool-jump" aria-label={t("session.jump")} onClick={scrollToBottom}>
                <Icon name="down" />
              </button>
            </Show>
          </Sheet>
        );
      }}
    </Show>
  );
}

// ---------- todo (§3.4) ----------

const [todoOpen, setTodoOpen] = createSignal(false);
const openTodos = () => setTodoOpen(true);

export function TodoSheet() {
  return (
    <Show when={todoOpen()}>
      <Sheet title={t("todo.title")} sub={`${(state.todos ?? []).filter((td) => td.status === "completed").length}/${(state.todos ?? []).length}`} onClose={() => setTodoOpen(false)}>
        <For each={state.todos ?? []} fallback={<p class="note">{t("todo.none")}</p>}>
          {(td) => (
            <div class="li" style={{ "padding-left": "4px" }}>
              <Switch>
                <Match when={td.status === "completed"}>
                  <span class="si done">
                    <Icon name="check" sm />
                  </span>
                </Match>
                <Match when={td.status === "in_progress"}>
                  <span class="si">
                    <span class="spin" />
                  </span>
                </Match>
                <Match when={true}>
                  <span class="si idle" />
                </Match>
              </Switch>
              <div class="tx" style={{ "text-decoration": td.status === "completed" ? "line-through" : undefined, color: td.status === "completed" ? "var(--muted)" : undefined }}>
                {td.text}
              </div>
            </div>
          )}
        </For>
      </Sheet>
    </Show>
  );
}

export function TodoCapsule() {
  const done = () => (state.todos ?? []).filter((td) => td.status === "completed").length;
  const total = () => (state.todos ?? []).length;
  const current = () => (state.todos ?? []).find((td) => td.status === "in_progress")?.text;
  return (
    <Show when={total() > 0}>
      <button class="todo" onClick={openTodos}>
        <span class="ring" style={{ background: `conic-gradient(var(--accent) ${(done() / total()) * 360}deg, var(--line2) 0)` }} />
        <span>
          {done()}/{total()}
          <Show when={current()}> · {current()}</Show>
        </span>
      </button>
    </Show>
  );
}

// ---------- turns (§3.2, §3.3) ----------

type Block =
  | { kind: "text"; markdown: string }
  | { kind: "tools"; calls: NormalizedToolCall[] }
  | { kind: "todo"; done: number; total: number }
  | { kind: "error"; text: string }
  | { kind: "compact"; summary: string };

function blocksOf(turn: NormalizedTurn): Block[] {
  const items: TurnItem[] = turn.items?.length
    ? turn.items
    : [
        ...(turn.toolCalls ?? []).map((call) => ({ kind: "tool" as const, call })),
        ...(turn.assistantResponse?.markdown ? [{ kind: "text" as const, markdown: turn.assistantResponse.markdown }] : []),
      ];
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.calls.push(it.call);
      else out.push({ kind: "tools", calls: [it.call] });
    } else if (it.kind === "text") {
      out.push({ kind: "text", markdown: it.markdown });
    } else if (it.kind === "todo") {
      out.push(it);
    } else if (it.kind === "error" || it.kind === "compact") {
      out.push(it);
    }
  }
  return out;
}

function ToolLine(props: { calls: NormalizedToolCall[] }) {
  const single = () => (props.calls.length === 1 ? props.calls[0] : null);
  const running = () => props.calls.some((c) => c.status === "running");
  const failed = () => props.calls.some((c) => c.status === "failed");
  const tot = () => totals(props.calls);
  const label = () => (single() ? callLine(single()!) : groupSummary(props.calls));
  return (
    <button
      class={`tool${failed() ? " fail" : ""}`}
      onClick={() => (single() ? openToolDetail(single()!) : setToolSheet({ calls: props.calls, title: groupSummary(props.calls), detail: null, direct: false }))}
    >
      <Show when={!running()} fallback={<span class="spin" />}>
        <Icon name={single() ? VERB_ICON[single()!.verb] : "layers"} sm />
      </Show>
      <Show
        when={single() && isPathCall(single()!)}
        fallback={<span class="lab">{label()}</span>}
      >
        <span class="lab" style={{ display: "inline-flex", "align-items": "center", "min-width": 0, "max-width": "100%" }}>
          <span style={{ "flex-shrink": 0, "margin-right": "4px" }}>{verbLabel(single()!)}</span>
          <span class="path-rev mono" style={{ "min-width": 0 }}>
            {renderPath(callObject(single()!))}
          </span>
        </span>
      </Show>
      <DiffBadge add={tot().add} del={tot().del} />
      <Icon name="chevR" sm class="chev" />
    </button>
  );
}

function Reasoning(props: { text: string; durationMs?: number; streaming?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const label = () => (props.streaming ? t("transcript.thinkingNow") : props.durationMs ? t("transcript.thoughtFor", { seconds: Math.max(1, Math.round(props.durationMs / 1000)) }) : t("transcript.thought"));
  return (
    <>
      <button class="tool think" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <Icon name="bulb" sm />
        <span class="lab">{label()}</span>
        <Icon name={open() ? "chevD" : "chevR"} sm class="chev" />
      </button>
      <Show when={open()}>
        <div class="thinkbody">{props.text}</div>
      </Show>
    </>
  );
}

/** §3: a compaction is one line; a tap shows the summary in a scrolling box. */
function Compaction(props: { summary: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button class="tool compact" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <Icon name="list" sm />
        <span class="lab">{t("transcript.compacted")}</span>
        <Icon name={open() ? "chevD" : "chevR"} sm class="chev" />
      </button>
      <Show when={open()}>
        <div class="thinkbody compactbody">{props.summary}</div>
      </Show>
    </>
  );
}

function lastText(turn: NormalizedTurn): string {
  const blocks = blocksOf(turn);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "text") return b.markdown;
  }
  return "";
}

function formatTurnTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (isSameDay) return `${hh}:${mm}`;
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${mon}-${day} ${hh}:${mm}`;
}

export function Turn(props: { turn: NormalizedTurn; last: boolean; working: boolean }) {
  const blocks = () => blocksOf(props.turn);
  const finished = () => !props.last || !props.working;
  return (
    <>
      <Show when={props.turn.userPrompt}>
        {(p) => (
          <>
            <Show when={p().files?.length}>
              <div class="att">
                <For each={p().files}>
                  {(f) => {
                    const uploadMatch = f.match(/up_[0-9a-f]{16}/);
                    const uploadId = uploadMatch ? uploadMatch[0] : null;
                    const fileName = f.split("/").pop() || f;
                    const isImg = /\.(png|jpe?g|webp|gif|svg)$/i.test(f) || !!uploadId;
                    return uploadId ? (
                      <button
                        type="button"
                        class="att-thumb-link"
                        style={{ cursor: "pointer", border: "1px solid var(--line)" }}
                        onClick={() => openImage(`/api/uploads/${uploadId}`, fileName)}
                      >
                        <img src={`/api/uploads/${uploadId}`} alt={fileName} class="att-thumb" />
                        <span class="att-name">{fileName.replace(/^up_[0-9a-f]{16}-/, "")}</span>
                      </button>
                    ) : (
                      <span>
                        <Icon name={isImg ? "image" : "folder"} sm />
                        {fileName}
                      </span>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={p().text.trim()}>
              <div class="ub">{p().text}</div>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.turn.reasoning?.text}>
        <Reasoning text={props.turn.reasoning!.text} durationMs={props.turn.reasoning!.durationMs} streaming={props.turn.reasoning!.isStreaming} />
      </Show>
      <Index each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b().kind === "text"}>
              <Markdown md={(b() as { markdown: string }).markdown} />
            </Match>
            <Match when={b().kind === "tools"}>
              <ToolLine calls={(b() as { calls: NormalizedToolCall[] }).calls} />
            </Match>
            <Match when={b().kind === "todo"}>
              <button class="tool" onClick={openTodos}>
                <Icon name="list" sm />
                <span class="lab">
                  {t("todo.progress", { done: (b() as { done: number }).done, total: (b() as { total: number }).total })}
                </span>
                <Icon name="chevR" sm class="chev" />
              </button>
            </Match>
            <Match when={b().kind === "compact"}>
              <Compaction summary={(b() as { summary: string }).summary} />
            </Match>
            <Match when={b().kind === "error"}>
              <div class="turn-error" style={{ color: "var(--danger)", margin: "8px 0", "font-size": "14px", "line-height": "1.5" }}>
                {(b() as { text: string }).text}
              </div>
            </Match>
          </Switch>
        )}
      </Index>
      <Show when={finished()}>
        <div class="acts" style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            <Show when={lastText(props.turn)}>
              <button aria-label={t("transcript.copyReply")} onClick={() => copyText(lastText(props.turn))}>
                <Icon name="copy" sm />
              </button>
            </Show>
          </div>
          <Show when={props.turn.updatedAt}>
            <span class="mono" style={{ "font-size": "11.5px", color: "var(--faint)", "margin-right": "4px" }}>
              {formatTurnTime(props.turn.updatedAt!)}
            </span>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** §3.6: screen cards in the message style when no session is bound. */
export function ScreenCard(props: { card: Card }) {
  const c = props.card;
  switch (c.kind) {
    case "markdown":
      return <Markdown md={c.content} />;
    case "thought":
      return <Reasoning text={c.body} />;
    case "tool_call":
      return (
        <button
          class={`tool${c.status === "error" ? " fail" : ""}`}
          onClick={() =>
            openToolDetail({ id: c.id, name: c.title, verb: "run", target: c.command, input: c.command, output: c.output, exitCode: c.exitCode, status: c.status === "running" ? "running" : c.status === "error" ? "failed" : "completed" })
          }
        >
          <Show when={c.status !== "running"} fallback={<span class="spin" />}>
            <Icon name="term" sm />
          </Show>
          <span class="lab">{c.title || c.command}</span>
          <Icon name="chevR" sm class="chev" />
        </button>
      );
    case "diff":
      return (
        <button class="tool" onClick={() => openDiffs(c.filePath, [{ filePath: c.filePath, status: "modified", additions: c.additions, deletions: c.deletions, patch: c.diff }])}>
          <Icon name="pencil" sm />
          <span class="lab" style={{ display: "inline-flex", "align-items": "center", "min-width": 0, "max-width": "100%" }}>
            <span style={{ "flex-shrink": 0, "margin-right": "4px" }}>{t("verb.edit")}</span>
            <span class="path-rev mono" style={{ "min-width": 0 }}>
              {renderPath(c.filePath)}
            </span>
          </span>
          <DiffBadge add={c.additions} del={c.deletions} />
          <Icon name="chevR" sm class="chev" />
        </button>
      );
    default:
      return null;
  }
}
