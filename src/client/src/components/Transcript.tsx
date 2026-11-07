import { createSignal, For, Match, Show, Switch } from "solid-js";
import { state } from "../state/store";
import { copyText } from "../state/ws";
import { renderMarkdown } from "../utils/markdown";
import type { Card, FileDiffSummary, NormalizedToolCall, NormalizedTurn, ToolVerb, TurnItem } from "../../../types/protocol";
import type { IconName } from "../icons";
import { DiffBadge, Icon, Sheet } from "./ui";
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

/** Wraps code blocks with a copy button (§3.2); clicks are handled by `onMarkdownClick`. */
function markdownHtml(md: string): string {
  return renderMarkdown(md)
    .replace(/<pre>/g, `<div class="cb"><button class="cpy" data-copy type="button">${t("common.copy")}</button><pre>`)
    .replace(/<\/pre>/g, "</pre></div>");
}

function onMarkdownClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest("[data-copy]");
  if (!btn) return;
  const pre = btn.parentElement?.querySelector("pre");
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

export function openToolDetail(call: NormalizedToolCall): void {
  setToolSheet({ calls: [call], title: callLine(call), detail: call, direct: true });
}

export function openDiffs(path: string, diffs: FileDiffSummary[]): void {
  const call: NormalizedToolCall = { id: `file:${path}`, name: "edit", verb: "edit", target: path, input: {}, status: "completed", diff: undefined };
  setToolSheet({ calls: [call], title: path.split("/").pop() || path, detail: call, direct: true });
  setFileDiffs(diffs);
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

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function ToolDetail(props: { call: NormalizedToolCall }) {
  const c = () => props.call;
  const command = () => {
    const input = c().input;
    if (typeof input === "string") return input;
    return typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : c().target || "";
  };
  const patches = () => fileDiffs() ?? (c().diff ? [c().diff!] : []);
  return (
    <Switch
      fallback={
        <>
          <Lines label={t("tool.input")} text={stringify(c().input)} />
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
          <Lines label={t("tool.input")} text={stringify(c().input)} />
        </Show>
      </Match>
    </Switch>
  );
}

export function ToolSheet() {
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
            title={s.detail ? `${verbLabel(s.detail)} ${s.detail.target?.split("/").pop() || ""}`.trim() : s.title}
            onClose={close}
            onBack={s.detail && !s.direct ? () => setToolSheet({ ...s, detail: null }) : undefined}
          >
            <Show
              when={s.detail}
              fallback={
                <For each={s.calls}>
                  {(c) => (
                    <button class="tli" onClick={() => setToolSheet({ ...s, detail: c })}>
                      <Show when={c.status !== "running"} fallback={<span class="spin" style={{ margin: "2px" }} />}>
                        <Icon name={VERB_ICON[c.verb]} />
                      </Show>
                      <div class="tx">
                        <div class="v" style={{ color: c.status === "failed" ? "var(--danger)" : undefined }}>
                          {verbLabel(c)}
                        </div>
                        <div class="o mono">{callObject(c)}</div>
                      </div>
                      <DiffBadge add={c.diff?.additions ?? 0} del={c.diff?.deletions ?? 0} />
                    </button>
                  )}
                </For>
              }
            >
              <ToolDetail call={s.detail!} />
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

type Block = { kind: "text"; markdown: string } | { kind: "tools"; calls: NormalizedToolCall[] } | { kind: "todo"; done: number; total: number };

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
    } else out.push(it.kind === "text" ? { kind: "text", markdown: it.markdown } : it);
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
      <span class="lab">{label()}</span>
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

function lastText(turn: NormalizedTurn): string {
  const blocks = blocksOf(turn);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "text") return b.markdown;
  }
  return "";
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
                  {(f) => (
                    <span>
                      <Icon name="image" sm />
                      {f.split("/").pop()}
                    </span>
                  )}
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
      <For each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b.kind === "text"}>
              <Markdown md={(b as { markdown: string }).markdown} />
            </Match>
            <Match when={b.kind === "tools"}>
              <ToolLine calls={(b as { calls: NormalizedToolCall[] }).calls} />
            </Match>
            <Match when={b.kind === "todo"}>
              <button class="tool" onClick={openTodos}>
                <Icon name="list" sm />
                <span class="lab">
                  {t("todo.progress", { done: (b as { done: number }).done, total: (b as { total: number }).total })}
                </span>
                <Icon name="chevR" sm class="chev" />
              </button>
            </Match>
          </Switch>
        )}
      </For>
      <Show when={finished() && lastText(props.turn)}>
        <div class="acts">
          <button aria-label={t("transcript.copyReply")} onClick={() => copyText(lastText(props.turn))}>
            <Icon name="copy" sm />
          </button>
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
          <span class="lab">{t("transcript.editFile", { path: c.filePath })}</span>
          <DiffBadge add={c.additions} del={c.deletions} />
          <Icon name="chevR" sm class="chev" />
        </button>
      );
    default:
      return null;
  }
}
