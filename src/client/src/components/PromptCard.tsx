import { createMemo, createSignal, For, Show } from "solid-js";
import { openTerminal, showToast, state } from "../state/store";
import { request, respondInteraction } from "../state/ws";
import type { InteractionCardData, NormalizedQuestion, NormalizedToolCall } from "../../../types/protocol";
import { focusComposer } from "./Composer";
import { Markdown, openToolDetail } from "./Transcript";
import { DiffBadge, Icon, Sheet } from "./ui";
import { t } from "../i18n";
import { matchScreenOption } from "../prompt-match";

/** Options that hand the turn back to the user to write something (§4.1, §4.3). */
const TELL_RE = /tell|keep planning|告诉|说明|继续规划/i;
const OTHER_RE = /type something|other|其他|自己输入/i;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

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

function TerminalLink() {
  return (
    <button class="btn ghost blk" onClick={openTerminal}>
      <Icon name="term" sm />
      {t("prompt.inTerminal")}
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
            {sending() === o.id ? t("common.sending") : o.label}
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
    if (props.p.source === "transcript") return 0;
    const text = norm(props.p.question + " " + (props.p.payload ?? ""));
    const i = qs().findIndex((q) => text.includes(norm(q.question)) || norm(q.question).includes(norm(props.p.question)));
    return i === -1 ? 0 : i;
  });
  const [page, setPage] = createSignal<number | null>(null);
  const cur = () => page() ?? onScreen();
  const [picked, setPicked] = createSignal<Record<number, string>>({});
  const { sending, answer } = useAnswer(() => props.p);
  const q = () => qs()[cur()];
  const other = () => (props.p.source === "transcript" ? undefined : props.p.options.find((o) => OTHER_RE.test(o.label)));
  const submit = () => {
    const label = picked()[cur()];
    if (props.p.source === "transcript") {
      const optIdx = q()?.options.findIndex((o) => o.label === label) ?? -1;
      const targetId = optIdx >= 0 ? `q${cur() + 1}_opt_${optIdx + 1}` : null;
      const opt = props.p.options.find((o) => o.id === targetId || o.label === label);
      if (!opt) {
        showToast(t("prompt.mismatch"));
        openTerminal();
        return;
      }
      setPage(null);
      answer(opt.id, opt.label);
      return;
    }
    const opt = label ? matchScreenOption(props.p.options, label) : undefined;
    if (!opt) {
      showToast(t("prompt.mismatch"));
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
            <button aria-label={t("prompt.prev")} disabled={cur() === 0} onClick={() => setPage(Math.max(0, cur() - 1))}>
              <Icon name="chevL" sm />
            </button>
            <span>
              {cur() + 1}/{qs().length}
            </span>
            <button aria-label={t("prompt.next")} disabled={cur() === qs().length - 1} onClick={() => setPage(Math.min(qs().length - 1, cur() + 1))}>
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
        <Show when={other()} keyed>
          {(o) => (
            <button class="opt oth" disabled={!!sending() || cur() !== onScreen()} onClick={() => answer(o.id, "tell")}>
              <span class="rd" style={{ visibility: "hidden" }} />
              <div class="tx">{t("prompt.other")}</div>
            </button>
          )}
        </Show>
      </div>
      <div class="qfoot">
        <button class="lnk" onClick={openTerminal}>
          <Icon name="term" sm />
          {t("agent.terminal")}
        </button>
        <Show
          when={!q()?.multiSelect && (props.p.source !== "transcript" || props.p.options.some((o) => o.keyShortcut))}
          fallback={
            <button class="btn acc" onClick={openTerminal}>
              {t("prompt.inTerminal")}
            </button>
          }
        >
          <button class="btn acc" disabled={!picked()[cur()] || !!sending() || (props.p.source !== "transcript" && cur() !== onScreen())} onClick={submit}>
            {sending() ? t("common.sending") : cur() === qs().length - 1 ? t("prompt.submit") : t("prompt.nextShort")}
          </button>
        </Show>
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
        <Show when={props.p.options.length} fallback={<TerminalLink />}>
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
  const raw = [p.question, p.payload].filter(Boolean).join("\n");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^[>❯›▶$]\s*$/.test(l)) return false;
      if (/(mode:auto|mode:plan|mode:bypass|ctx:\d+%|token:\d+)/i.test(l)) return false;
      if (/^Pigeon\s+main/i.test(l)) return false;
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

function useDismissAlert() {
  const dismiss = () => {
    if (state.activePaneId) {
      request({
        type: "agent_send_keys",
        payload: { targetPaneId: state.activePaneId, keys: ["escape"] },
      }).catch((e) => showToast(e.message || t("prompt.notSent")));
    }
  };
  return dismiss;
}

function AlertDialogCard(props: { p: InteractionCardData }) {
  const [showModal, setShowModal] = createSignal(true);
  const info = () => cleanAlertInfo(props.p);
  const dismiss = useDismissAlert();

  const handleClose = () => {
    setShowModal(false);
    dismiss();
  };

  return (
    <>
      <Show when={showModal()}>
        <div class="alert-dialog-overlay" role="dialog" aria-modal="true">
          <div class="scrim" onClick={handleClose} />
          <div class="alert-dialog-card">
            <div class="alert-dialog-hdr">
              <span class="wbadge">
                <span class="wd" />
                {info().isError ? t("prompt.error") : t("prompt.alert")}
              </span>
              <button class="cbtn" aria-label={t("common.close")} onClick={handleClose}>
                <Icon name="x" />
              </button>
            </div>
            <div class="alert-dialog-body">
              <div class="alert-dialog-title">{info().title}</div>
              <div class="alert-box">
                {info().message}
              </div>
            </div>
            <div class="alert-dialog-foot">
              <button class="btn acc blk" onClick={handleClose}>
                {t("prompt.dismiss")}
              </button>
              <button class="btn ghost blk" onClick={() => { setShowModal(false); openTerminal(); }}>
                <Icon name="term" sm />
                {t("prompt.viewTerminal")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <div class="qcard">
        <div class="qtop">
          <span class="wbadge">
            <span class="wd" />
            {info().isError ? t("prompt.error") : t("prompt.alert")}
          </span>
          <span style={{ flex: 1 }} />
          <Show when={!showModal()}>
            <button class="lnk" onClick={() => setShowModal(true)}>
              {t("prompt.openDialog")}
            </button>
          </Show>
        </div>
        <div class="qbody">
          <div class="qtitle">{info().title}</div>
          <div class="alert-box">
            {info().message}
          </div>
        </div>
        <div class="optbtns" style={{ "margin-top": "12px" }}>
          <button class="btn acc blk" onClick={handleClose}>
            {t("prompt.dismiss")}
          </button>
          <button class="btn ghost blk" onClick={openTerminal}>
            <Icon name="term" sm />
            {t("prompt.viewTerminal")}
          </button>
        </div>
      </div>
    </>
  );
}

/** §4: replaces the composer while the pane has a pending interaction. Returns null when collapsed. */
export function PromptCard(props: { collapsed: boolean; onCollapse: () => void; onExpand: () => void }) {
  const p = () => state.pendingInteraction!;
  const question = () => lastTurn()?.pendingQuestion;
  const plan = () => lastTurn()?.pendingPlan;
  const isAlert = () => isAlertPrompt(p());
  return (
    <Show
      when={!props.collapsed || !question()}
      fallback={
        <button class="qcap" onClick={props.onExpand}>
          <span class="wd" />
          {t("prompt.questionsWaiting", { count: question()!.questions.length })}
        </button>
      }
    >
      <Show
        when={question()}
        keyed
        fallback={
          <Show
            when={plan()}
            keyed
            fallback={
              <Show when={isAlert()} fallback={<PermissionCard p={p()} />}>
                <AlertDialogCard p={p()} />
              </Show>
            }
          >
            {(pl) => <PlanCard p={p()} markdown={pl.markdown} />}
          </Show>
        }
      >
        {(q) => <QuestionCard p={p()} q={q} onCollapse={props.onCollapse} />}
      </Show>
    </Show>
  );
}
