import { createMemo, createSignal, For, Show } from "solid-js";
import { showToast, state } from "../state/store";
import { closeAlert, isAlertClosed, respondInteraction, respondOptionIds } from "../state/ws";
import type { InteractionCardData, NormalizedQuestion, NormalizedToolCall } from "../../../types/protocol";
import { focusComposer } from "./Composer";
import { Markdown, openToolDetail } from "./Transcript";
import { DiffBadge, Icon, Sheet } from "./ui";
import { t } from "../i18n";
import { callCommand } from "../utils/tool-call";

/** Options that hand the turn back to the user to write something (§4.1, §4.3). */
const TELL_RE = /tell|keep planning|告诉|说明|继续规划/i;

function lastTurn() {
  return state.normalizedTurns[state.normalizedTurns.length - 1];
}

/** The transcript's pending tool call the permission prompt is about. */
function pendingCall(): NormalizedToolCall | undefined {
  const turn = lastTurn();
  const calls = (turn?.items ?? []).flatMap((i) => (i.kind === "tool" ? [i.call] : [])).concat(turn?.items?.length ? [] : turn?.toolCalls ?? []);
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
      .catch((e) => showToast(e.message || t("prompt.notSent")))
      .finally(() => setSending(null));
  };
  return { sending, answer };
}

/** §4.2: 其他（自己输入）: a pick that opens a text box under it. */
function OtherOption(props: { multi: boolean; text: string | undefined; onToggle: () => void; onText: (s: string) => void }) {
  let box: HTMLTextAreaElement | undefined;
  return (
    <>
      <button
        class={`opt${props.multi ? " multi" : ""}${props.text !== undefined ? " sel" : ""}`}
        onClick={() => {
          props.onToggle();
          queueMicrotask(() => box?.focus());
        }}
      >
        <span class="rd" />
        <div class="tx">
          <b>{t("prompt.other")}</b>
        </div>
      </button>
      <Show when={props.text !== undefined}>
        <textarea
          ref={box}
          class="othtext"
          rows={2}
          maxLength={2000}
          placeholder={t("prompt.otherPlaceholder")}
          value={props.text ?? ""}
          onInput={(e) => props.onText(e.currentTarget.value)}
        />
      </Show>
    </>
  );
}

/** §4.1: what a tap cannot answer is answered by typing in the composer. */
function ReplyBelow() {
  return <p class="note" style={{ margin: "4px 2px 0" }}>{t("prompt.replyBelow")}</p>;
}

function Options(props: { p: InteractionCardData }) {
  const { sending, answer } = useAnswer(() => props.p);
  return (
    <div class="optbtns">
      <For each={props.p.options}>
        {(o, i) => (
          <button class={`btn blk${i() === 0 ? " pri" : ""}`} disabled={!!sending() && sending() !== o.id} onClick={() => answer(o.id, o.label)}>
            {sending() === o.id ? t("common.sending") : o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** §4.1 / §4.4 */
function PermissionCard(props: { p: InteractionCardData }) {
  const call = () => pendingCall();
  const command = () => {
    const c = call();
    if (!c) return props.p.payload || "";
    if (c.verb === "run") return callCommand(c);
    return "";
  };
  return (
    <div class="qcard">
      <div class="qtop">
        <span class="wbadge">
          <span class="wd" />
          {props.p.options.length ? t("prompt.permission") : t("prompt.waiting")}
        </span>
      </div>
      <div class="qbody">
        <div class="qtitle">{props.p.question || props.p.title || t("prompt.waiting")}</div>
        <Show when={call()?.diff} fallback={<Show when={command()}><button class="qcmd mono" onClick={() => call() && openToolDetail(call()!)}>{command()}</button></Show>}>
          <button class="qcmd mono" onClick={() => openToolDetail(call()!)} style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{call()!.target}</span>
            <DiffBadge add={call()!.diff!.additions} del={call()!.diff!.deletions} />
          </button>
        </Show>
      </div>
      <Show when={props.p.options.length} fallback={<ReplyBelow />}>
        <Options p={props.p} />
      </Show>
    </div>
  );
}

/** §4.2: a transcript question is answered entirely in the card, all questions at once. */
function TranscriptQuestionCard(props: { p: InteractionCardData; q: NormalizedQuestion; onCollapse: () => void }) {
  const qs = () => props.q.questions;
  const [cur, setCur] = createSignal(0);
  const [picked, setPicked] = createSignal<Record<number, number[]>>({});
  // A question's own text: undefined while 其他 is not picked.
  const [others, setOthers] = createSignal<Record<number, string | undefined>>({});
  const [sending, setSending] = createSignal(false);
  const q = () => qs()[cur()];
  const picksOf = (k: number) => picked()[k] ?? [];
  const toggle = (n: number) => {
    const k = cur();
    const now = picksOf(k);
    const next = q()?.multiSelect ? (now.includes(n) ? now.filter((x) => x !== n) : [...now, n].sort((a, b) => a - b)) : [n];
    setPicked({ ...picked(), [k]: next });
    if (!q()?.multiSelect) setOthers({ ...others(), [k]: undefined });
  };
  const toggleOther = () => {
    const k = cur();
    setOthers({ ...others(), [k]: others()[k] === undefined ? "" : undefined });
    if (!q()?.multiSelect) setPicked({ ...picked(), [k]: [] });
  };
  const hasPick = (k: number) => picksOf(k).length > 0 || !!others()[k]?.trim();
  const last = () => cur() === qs().length - 1;
  const allPicked = () => qs().every((_, k) => hasPick(k) && (others()[k] === undefined || !!others()[k]!.trim()));
  const submit = () => {
    if (sending()) return;
    const ids = qs().flatMap((_, k) => [...picksOf(k).map((n) => `q${k + 1}_opt_${n}`), ...(others()[k] !== undefined ? [`q${k + 1}_other`] : [])]);
    const texts = Object.fromEntries(qs().flatMap((_, k) => (others()[k] !== undefined ? [[String(k + 1), others()[k]!.trim()]] : [])));
    setSending(true);
    respondOptionIds(props.p.interactionId, ids, props.p.fingerprint, Object.keys(texts).length ? texts : undefined)
      .catch((e) => showToast(e.message || t("prompt.notSent")))
      .finally(() => setSending(false));
  };
  return (
    <div class="qcard">
      <div class="qtop">
        <div class="pg">
          <Show when={qs().length > 1}>
            <button aria-label={t("prompt.prev")} disabled={cur() === 0} onClick={() => setCur(Math.max(0, cur() - 1))}>
              <Icon name="chevL" sm />
            </button>
            <span>
              {cur() + 1}/{qs().length}
            </span>
            <button aria-label={t("prompt.next")} disabled={last()} onClick={() => setCur(Math.min(qs().length - 1, cur() + 1))}>
              <Icon name="chevR" sm />
            </button>
          </Show>
          <Show when={q()?.header}>
            <span class="wbadge" style={{ "margin-left": "6px" }}>
              {q()!.header}
            </span>
          </Show>
        </div>
        <button class="x" aria-label={t("common.collapse")} onClick={props.onCollapse}>
          <Icon name="x" sm />
        </button>
      </div>
      <div class="qbody">
        <div class="qtitle">{q()?.question}</div>
        <For each={q()?.options ?? []}>
          {(o, i) => (
            <button class={`opt${q()?.multiSelect ? " multi" : ""}${picksOf(cur()).includes(i() + 1) ? " sel" : ""}`} onClick={() => toggle(i() + 1)}>
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
        <Show when={props.p.allowsOther}>
          <OtherOption multi={!!q()?.multiSelect} text={others()[cur()]} onToggle={toggleOther} onText={(s) => setOthers({ ...others(), [cur()]: s })} />
        </Show>
      </div>
      <div class="qfoot">
        <span style={{ flex: 1 }} />
        <Show
          when={last()}
          fallback={
            <button class="btn acc" disabled={!hasPick(cur()) || (others()[cur()] !== undefined && !others()[cur()]!.trim())} onClick={() => setCur(cur() + 1)}>
              {t("prompt.nextShort")}
            </button>
          }
        >
          <button class="btn acc" disabled={!allPicked() || sending()} onClick={submit}>
            {sending() ? t("common.sending") : t("prompt.submit")}
          </button>
        </Show>
      </div>
    </div>
  );
}

/** §4.2: an agent's question menu read from the screen, answered one question at a time. */
function MenuQuestionCard(props: { p: InteractionCardData }) {
  const [picked, setPicked] = createSignal<string[]>([]);
  const [other, setOther] = createSignal<string | undefined>(undefined);
  const [sending, setSending] = createSignal(false);
  const toggle = (id: string) => {
    if (!props.p.multiSelect) {
      setOther(undefined);
      return setPicked([id]);
    }
    setPicked(picked().includes(id) ? picked().filter((x) => x !== id) : [...picked(), id]);
  };
  const toggleOther = () => {
    setOther(other() === undefined ? "" : undefined);
    if (!props.p.multiSelect) setPicked([]);
  };
  const ready = () => (picked().length > 0 || other() !== undefined) && (other() === undefined || !!other()!.trim());
  const confirm = () => {
    if (sending() || !ready()) return;
    setSending(true);
    const ids = [...picked(), ...(other() !== undefined ? ["opt_other"] : [])];
    const texts = other() !== undefined ? { "1": other()!.trim() } : undefined;
    const sent = props.p.multiSelect
      ? respondOptionIds(props.p.interactionId, ids, props.p.fingerprint, texts)
      : respondInteraction(props.p.interactionId, ids[0], props.p.fingerprint, texts);
    sent.catch((e) => showToast(e.message || t("prompt.notSent"))).finally(() => setSending(false));
  };
  return (
    <div class="qcard">
      <div class="qbody">
        <div class="qtitle">{props.p.question}</div>
        <For each={props.p.options}>
          {(o) => (
            <button class={`opt${props.p.multiSelect ? " multi" : ""}${picked().includes(o.id) ? " sel" : ""}`} onClick={() => toggle(o.id)}>
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
        <Show when={props.p.allowsOther}>
          <OtherOption multi={!!props.p.multiSelect} text={other()} onToggle={toggleOther} onText={setOther} />
        </Show>
      </div>
      <div class="qfoot">
        <span style={{ flex: 1 }} />
        <button class="btn acc" disabled={!ready() || sending()} onClick={confirm}>
          {sending() ? t("common.sending") : t("common.confirm")}
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
          {t("prompt.planPending")}
        </span>
        <span class="sp" style={{ flex: 1 }} />
        <button class="lnk" onClick={() => setFull(true)}>
          {t("prompt.fullText")}
        </button>
      </div>
      <div class="qbody">
        <div class="planbox">
          <Markdown md={props.markdown} />
        </div>
      </div>
      <div style={{ "margin-top": "10px" }}>
        <Show when={props.p.options.length} fallback={<ReplyBelow />}>
          <Options p={props.p} />
        </Show>
      </div>
      <Show when={full()}>
        <Sheet title={t("prompt.plan")} full onClose={() => setFull(false)}>
          <Markdown md={props.markdown} />
        </Sheet>
      </Show>
    </div>
  );
}

function isAlertPrompt(p: InteractionCardData): boolean {
  if (p.options.length > 0) return false;
  return !pendingCall();
}

function cleanAlertInfo(p: InteractionCardData) {
  // The question is one of the payload's lines; show it once.
  const raw = p.payload || p.question || "";
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^[>❯›▶$]\s*$/.test(l)) return false;
      if (/(mode:auto|mode:plan|mode:bypass|ctx:\d+%|token:\d+)/i.test(l)) return false;
      return true;
    });

  const fullText = lines.join("\n");
  const isError = /error|fail|capacity|limit|quota|exception|unavailable/i.test(fullText);

  let title = p.title && !/(mode:auto|ctx:|token:)/i.test(p.title) ? p.title : "";
  if (!title) {
    title = isError ? t("prompt.error") : t("prompt.alert");
  }

  const message = lines.length > 0 ? lines.join("\n") : (p.payload || p.question || t("prompt.waiting"));
  return { title, message, isError };
}

/** §4.4: rebuilt per prompt (keyed by its id); a closed one stays closed while it is pending. */
function AlertDialogCard(props: { p: InteractionCardData }) {
  const [closed, setClosed] = createSignal(isAlertClosed(state.activePaneId, props.p.interactionId));
  const info = () => cleanAlertInfo(props.p);
  const close = () => {
    closeAlert(state.activePaneId, props.p.interactionId);
    setClosed(true);
  };

  return (
    <Show when={!closed()}>
      <div class="alert-dialog-overlay" role="dialog" aria-modal="true">
        <div class="scrim" onClick={close} />
        <div class="alert-dialog-card">
          <div class="alert-dialog-hdr">
            <span class="wbadge">
              <span class="wd" />
              {info().isError ? t("prompt.error") : t("prompt.alert")}
            </span>
            <button class="cbtn" aria-label={t("common.close")} onClick={close}>
              <Icon name="x" />
            </button>
          </div>
          <div class="alert-dialog-body">
            <div class="alert-dialog-title">{info().title}</div>
            <div class="alert-box">{info().message}</div>
          </div>
          <div class="alert-dialog-foot">
            <button class="btn acc blk" onClick={close}>
              {t("prompt.dismiss")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** §4: the pending interaction's card, above the composer; collapsed to a cap when asked. */
export function PromptCard(props: { collapsed: boolean; onCollapse: () => void; onExpand: () => void }) {
  const p = () => state.pendingInteraction!;
  const question = () => lastTurn()?.pendingQuestion;
  const plan = () => lastTurn()?.pendingPlan;
  const isAlert = () => isAlertPrompt(p());
  // A pane refresh replaces these objects; a card is rebuilt only when its prompt changes, so
  // the page and picks the user made survive (§4.2).
  const isTranscript = createMemo(() => p().source === "transcript");
  const questionId = () => (isTranscript() ? question()?.id : undefined);
  return (
    <Show
      when={!props.collapsed || !questionId()}
      fallback={
        <button class="qcap" onClick={props.onExpand}>
          <span class="wd" />
          {t("prompt.questionsWaiting", { count: question()!.questions.length })}
        </button>
      }
    >
      <Show
        when={questionId()}
        keyed
        fallback={
          <Show
            when={plan()?.markdown}
            keyed
            fallback={
              <Show
                when={p().multiSelect !== undefined}
                fallback={
                  <Show when={isAlert()} fallback={<PermissionCard p={p()} />}>
                    <Show when={p().interactionId} keyed>
                      {(_id: string) => <AlertDialogCard p={p()} />}
                    </Show>
                  </Show>
                }
              >
                <Show when={p().interactionId} keyed>
                  {(_id: string) => <MenuQuestionCard p={p()} />}
                </Show>
              </Show>
            }
          >
            {(md: string) => <PlanCard p={p()} markdown={md} />}
          </Show>
        }
      >
        {(_id: string) => <TranscriptQuestionCard p={p()} q={question()!} onCollapse={props.onCollapse} />}
      </Show>
    </Show>
  );
}
