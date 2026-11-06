import { createMemo, createSignal, For, Show } from "solid-js";
import { openTerminal, showToast, state } from "../state/store";
import { respondInteraction } from "../state/ws";
import type { InteractionCardData, NormalizedQuestion, NormalizedToolCall } from "../../../types/protocol";
import { focusComposer } from "./Composer";
import { Markdown, openToolDetail } from "./Transcript";
import { DiffBadge, Icon, Sheet } from "./ui";

/** Options that hand the turn back to the user to write something (§4.1, §4.3). */
const TELL_RE = /tell|keep planning|告诉|说明|继续规划/i;
const OTHER_RE = /type something|other|其他|自己输入/i;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function lastTurn() {
  return state.normalizedTurns[state.normalizedTurns.length - 1];
}

/** The transcript's pending tool call the permission prompt is about. */
function pendingCall(): NormalizedToolCall | undefined {
  const t = lastTurn();
  const calls = (t?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i.call] : [])).concat(t?.items?.length ? [] : t?.toolCalls ?? []);
  return [...calls].reverse().find((c) => c.status === "running");
}

function useAnswer(p: () => InteractionCardData) {
  const [sending, setSending] = createSignal<string | null>(null);
  const answer = (optionId: string, label: string) => {
    if (sending()) return;
    setSending(optionId);
    respondInteraction(p().interactionId, optionId, p().fingerprint)
      .then((ack) => {
        if (ack?.approved !== false && TELL_RE.test(label)) focusComposer();
      })
      .catch((e) => showToast(e.message || "没有发出"))
      .finally(() => setSending(null));
  };
  return { sending, answer };
}

function TerminalLink() {
  return (
    <button class="btn ghost blk" onClick={openTerminal}>
      <Icon name="term" sm />
      在终端中处理
    </button>
  );
}

function Options(props: { p: InteractionCardData }) {
  const { sending, answer } = useAnswer(() => props.p);
  return (
    <div class="optbtns">
      <For each={props.p.options}>
        {(o, i) => (
          <button class={`btn blk${i() === 0 ? " pri" : ""}`} disabled={!!sending() && sending() !== o.id} onClick={() => answer(o.id, o.label)}>
            {sending() === o.id ? "发送中…" : o.label}
          </button>
        )}
      </For>
      <TerminalLink />
    </div>
  );
}

/** §4.1 / §4.4 */
function PermissionCard(props: { p: InteractionCardData }) {
  const call = () => pendingCall();
  const command = () => {
    const c = call();
    if (!c) return props.p.payload || "";
    if (c.verb === "run") return c.target || (typeof c.input === "string" ? c.input : String(c.input.command ?? ""));
    return "";
  };
  return (
    <div class="qcard">
      <div class="qtop">
        <span class="wbadge">
          <span class="wd" />
          {props.p.options.length ? "需要授权" : "Agent 在等待"}
        </span>
      </div>
      <div class="qbody">
        <div class="qtitle">{props.p.question || props.p.title || "Agent 在等待"}</div>
        <Show when={call()?.diff} fallback={<Show when={command()}><button class="qcmd mono" onClick={() => call() && openToolDetail(call()!)}>{command()}</button></Show>}>
          <button class="qcmd mono" onClick={() => openToolDetail(call()!)} style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{call()!.target}</span>
            <DiffBadge add={call()!.diff!.additions} del={call()!.diff!.deletions} />
          </button>
        </Show>
      </div>
      <Show when={props.p.options.length} fallback={<TerminalLink />}>
        <Options p={props.p} />
      </Show>
    </div>
  );
}

/** §4.2: the transcript question drives the card; answers go as the screen's digits. */
function QuestionCard(props: { p: InteractionCardData; q: NormalizedQuestion; onCollapse: () => void }) {
  const qs = () => props.q.questions;
  const onScreen = createMemo(() => {
    const text = norm(props.p.question + " " + (props.p.payload ?? ""));
    const i = qs().findIndex((q) => text.includes(norm(q.question)) || norm(q.question).includes(norm(props.p.question)));
    return i === -1 ? 0 : i;
  });
  const [page, setPage] = createSignal<number | null>(null);
  const cur = () => page() ?? onScreen();
  const [picked, setPicked] = createSignal<Record<number, string>>({});
  const { sending, answer } = useAnswer(() => props.p);
  const q = () => qs()[cur()];
  const screenOption = (label: string) => props.p.options.find((o) => norm(o.label) === norm(label) || norm(o.label).startsWith(norm(label)));
  const other = () => props.p.options.find((o) => OTHER_RE.test(o.label));
  const submit = () => {
    const label = picked()[cur()];
    const opt = label ? screenOption(label) : undefined;
    if (!opt) {
      showToast("屏幕上的选项和问题对不上，请在终端中处理");
      openTerminal();
      return;
    }
    setPage(null);
    answer(opt.id, opt.label);
  };
  return (
    <div class="qcard">
      <div class="qtop">
        <div class="pg">
          <Show when={qs().length > 1}>
            <button aria-label="上一题" disabled={cur() === 0} onClick={() => setPage(Math.max(0, cur() - 1))}>
              <Icon name="chevL" sm />
            </button>
            <span>
              {cur() + 1}/{qs().length}
            </span>
            <button aria-label="下一题" disabled={cur() === qs().length - 1} onClick={() => setPage(Math.min(qs().length - 1, cur() + 1))}>
              <Icon name="chevR" sm />
            </button>
          </Show>
          <Show when={q()?.header}>
            <span class="wbadge" style={{ "margin-left": "6px" }}>
              {q()!.header}
            </span>
          </Show>
        </div>
        <button class="x" aria-label="收起" onClick={props.onCollapse}>
          <Icon name="x" sm />
        </button>
      </div>
      <div class="qbody">
        <div class="qtitle">{q()?.question}</div>
        <For each={q()?.options ?? []}>
          {(o) => (
            <button class={`opt${picked()[cur()] === o.label ? " sel" : ""}`} onClick={() => setPicked({ ...picked(), [cur()]: o.label })}>
              <span class="rd" />
              <div class="tx">
                <b>{o.label}</b>
                <Show when={o.description}>
                  <span>{o.description}</span>
                </Show>
              </div>
            </button>
          )}
        </For>
        <button
          class="opt oth"
          onClick={() => {
            const o = other();
            if (o) answer(o.id, "tell");
            props.onCollapse();
            focusComposer();
          }}
        >
          <span class="rd" style={{ visibility: "hidden" }} />
          <div class="tx">其他…</div>
        </button>
      </div>
      <div class="qfoot">
        <button class="lnk" onClick={openTerminal}>
          <Icon name="term" sm />
          终端
        </button>
        <button class="btn acc" disabled={!picked()[cur()] || !!sending() || cur() !== onScreen()} onClick={submit}>
          {sending() ? "发送中…" : cur() === qs().length - 1 ? "提交" : "下一题"}
        </button>
      </div>
    </div>
  );
}

/** §4.3 */
function PlanCard(props: { p: InteractionCardData; markdown: string }) {
  const [full, setFull] = createSignal(false);
  return (
    <div class="qcard">
      <div class="qtop">
        <span class="wbadge">
          <span class="wd" />
          计划待批准
        </span>
        <span class="sp" style={{ flex: 1 }} />
        <button class="lnk" onClick={() => setFull(true)}>
          全文
        </button>
      </div>
      <div class="qbody">
        <div class="planbox">
          <Markdown md={props.markdown} />
        </div>
      </div>
      <div style={{ "margin-top": "10px" }}>
        <Show when={props.p.options.length} fallback={<TerminalLink />}>
          <Options p={props.p} />
        </Show>
      </div>
      <Show when={full()}>
        <Sheet title="计划" full onClose={() => setFull(false)}>
          <Markdown md={props.markdown} />
        </Sheet>
      </Show>
    </div>
  );
}

/** §4: replaces the composer while the pane has a pending interaction. Returns null when collapsed. */
export function PromptCard(props: { collapsed: boolean; onCollapse: () => void; onExpand: () => void }) {
  const p = () => state.pendingInteraction!;
  const question = () => lastTurn()?.pendingQuestion;
  const plan = () => lastTurn()?.pendingPlan;
  return (
    <Show
      when={!props.collapsed || !question()}
      fallback={
        <button class="qcap" onClick={props.onExpand}>
          <span class="wd" />
          {question()!.questions.length} 个问题等你回答
        </button>
      }
    >
      <Show when={question()} keyed fallback={<Show when={plan()} keyed fallback={<PermissionCard p={p()} />}>{(pl) => <PlanCard p={p()} markdown={pl.markdown} />}</Show>}>
        {(q) => <QuestionCard p={p()} q={q} onCollapse={props.onCollapse} />}
      </Show>
    </Show>
  );
}
