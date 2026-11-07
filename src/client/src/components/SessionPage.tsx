import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { navigate, openTerminal, setState, showToast, state } from "../state/store";
import { copyText, request, selectPane, sendKeys, sendPrompt } from "../state/ws";
import type { FileDiffSummary, QueuedPrompt } from "../../../types/protocol";
import { Composer, insertIntoComposer, ModelSheet, PlusSheet, restoreIntoComposer, SkillsSheet } from "./Composer";
import { ConnectionBanner } from "./Home";
import { openOverlay } from "./overlays";
import { PromptCard } from "./PromptCard";
import { openDiffs, ScreenCard, TodoCapsule, TodoSheet, ToolSheet, Turn } from "./Transcript";
import { DiffBadge, findPane, Icon, paneLabel, paneStatus, paneSummary, Sheet, StatusIcon } from "./ui";
import { t, type MessageId } from "../i18n";

const SOURCE_TEXT: Record<"log" | "launch" | "unknown", MessageId> = { log: "model.sourceLog", launch: "model.sourceLaunch", unknown: "model.sourceUnknown" };
const TERMINAL_KEYS: Array<[string, string]> = [
  ["↑", "up"],
  ["↓", "down"],
  ["←", "left"],
  ["→", "right"],
  ["Enter", "enter"],
  ["Esc", "esc"],
  ["Tab", "tab"],
  ["Ctrl+C", "ctrl+c"],
];

function Screen(props: { scroll?: boolean }) {
  let el: HTMLPreElement | undefined;
  createEffect(
    on(
      () => state.rawScreen,
      () => {
        if (el && props.scroll !== false) el.scrollTop = el.scrollHeight;
      }
    )
  );
  return (
    <pre class="term mono" ref={el}>
      {state.rawScreen || t("terminal.empty")}
    </pre>
  );
}

function Keys() {
  const extra = () => (state.pendingInteraction?.fallbackKeys ?? []).filter((k) => !TERMINAL_KEYS.some(([, v]) => v === k));
  return (
    <div class="keys">
      <For each={TERMINAL_KEYS}>
        {([label, key]) => (
          <button class={key === "ctrl+c" ? "d" : ""} onClick={() => sendKeys([key])}>
            {label}
          </button>
        )}
      </For>
      <For each={extra()}>{(k) => <button onClick={() => sendKeys([k])}>{k}</button>}</For>
    </div>
  );
}

/** §5 */
function TerminalSheet() {
  return (
    <Show when={state.terminalOpen}>
      <Sheet title={t("agent.terminal")} sub={t("terminal.sub")} full onClose={() => setState("terminalOpen", false)}>
        <div style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
          <Screen />
          <Keys />
        </div>
      </Sheet>
    </Show>
  );
}

/** §6.6: edits summed per file. */
function ChangesSheet(props: { onClose: () => void }) {
  const files = createMemo(() => {
    const map = new Map<string, { add: number; del: number; diffs: FileDiffSummary[] }>();
    for (const d of state.sessionStats?.diffs ?? []) {
      const e = map.get(d.filePath) ?? { add: 0, del: 0, diffs: [] };
      e.add += d.additions;
      e.del += d.deletions;
      e.diffs.push(d);
      map.set(d.filePath, e);
    }
    return [...map.entries()];
  });
  return (
    <Sheet title={t("changes.title")} sub={files().length ? t("changes.fileCount", { count: files().length }) : undefined} onClose={props.onClose} full>
      <Show when={files().length} fallback={<p class="note">{state.session?.bound ? t("changes.none") : t("changes.unbound")}</p>}>
        <div class="card">
          <For each={files()}>
            {([path, f]) => (
              <button class="li" onClick={() => openDiffs(path, f.diffs)}>
                <div class="tx mono" style={{ "font-size": "13.5px", "overflow-wrap": "anywhere" }}>
                  {path.split("/").pop()}
                  <small>{path}</small>
                </div>
                <DiffBadge add={f.add} del={f.del} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </Sheet>
  );
}

/** §6.8 */
function PaneSheet(props: { onClose: () => void }) {
  const found = () => findPane(state.activePaneId);
  return (
    <Sheet title={t("panes.title")} sub={found()?.tab.label} onClose={props.onClose}>
      <div class="card">
        <For each={found()?.tab.panes ?? []}>
          {(p) => (
            <button
              class="li"
              onClick={() => {
                selectPane(p.id);
                props.onClose();
              }}
            >
              <StatusIcon status={paneStatus(p)} />
              <div class="tx">
                {paneLabel(p)}
                <small>{p.name || paneSummary(p) || p.id}</small>
              </div>
              <Show when={p.id === state.activePaneId}>
                <span class="ck">
                  <Icon name="check" />
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <p class="note">{t("panes.note")}</p>
    </Sheet>
  );
}

type Panel = "menu" | "changes" | "panes" | "plus" | "skills" | "model" | null;

/** mobile-ui-and-themes.md §3.5: take a queued prompt out of the queue and back into the composer. */
function editQueued(q: QueuedPrompt): void {
  request({ type: "queue_cancel", payload: { targetPaneId: state.activePaneId!, queueId: q.queueId } })
    .then(() => restoreIntoComposer(q.text, q.attachments))
    .catch((e) => showToast(e.code === "ERR_NOT_FOUND" ? t("session.alreadySent") : e.message || t("session.undoFailed")));
}

export function SessionPage() {
  const [panel, setPanel] = createSignal<Panel>(null);
  const [nearBottom, setNearBottom] = createSignal(true);
  const [cardCollapsed, setCardCollapsed] = createSignal(false);
  const [dockH, setDockH] = createSignal(110);
  let scroller: HTMLDivElement | undefined;
  let chat: HTMLDivElement | undefined;
  let dock: HTMLDivElement | undefined;

  const found = () => findPane(state.activePaneId);
  const pane = () => found()?.pane;
  const tab = () => found()?.tab;
  const isTerminal = () => !!pane() && !pane()!.agent;
  const working = () => state.agentStatus === "working";
  const recipe = () => (pane()?.agent ? state.recipes[pane()!.agent!] : undefined);
  const back = () => {
    const r = state.route;
    navigate({ name: r.name === "session" && r.from === "agents" ? "agents" : "home" });
  };

  // The tab closed under us (here or on the computer): go back. A just-created pane may not be
  // in the snapshot yet, so only a pane seen before counts as gone.
  let seen = false;
  createEffect(() => {
    if (found()) seen = true;
    else if (seen) back();
  });
  createEffect(on(() => state.pendingInteraction?.interactionId, () => setCardCollapsed(false)));

  const toBottom = (smooth = false) => {
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  // §3.5: follow new content only when the reader is already at the bottom.
  createEffect(
    on(
      () => [state.normalizedTurns, state.cards, state.queue.length, state.agentStatus, state.pendingInteraction],
      () => {
        if (nearBottom()) requestAnimationFrame(() => toBottom());
      }
    )
  );
  createEffect(on(() => state.activePaneId, () => requestAnimationFrame(() => toBottom())));
  onMount(() => {
    // Content (rendered Markdown, a prompt card, the keyboard) changes height without a store change.
    const ro = new ResizeObserver(() => {
      if (dock) setDockH(dock.offsetHeight);
      if (nearBottom()) toBottom();
    });
    if (chat) ro.observe(chat);
    if (dock) ro.observe(dock);
    if (scroller) ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const stop = () => {
    const keys = isTerminal() ? ["ctrl+c"] : recipe()?.interruptKeys ?? ["esc"];
    sendKeys(keys);
  };

  const modelValue = () => state.session?.model.value ?? null;
  const thinkingValue = () => state.session?.thinking.value ?? null;
  const modelChip = () => (
    <Show when={recipe()}>
      <button class="mc" onMouseDown={(e) => e.preventDefault()} onClick={() => setPanel("model")}>
        {recipe()!.models.find((m) => m.id === modelValue() || m.label === modelValue())?.label ?? modelValue() ?? t("model.model")}
        <Show when={thinkingValue()}>
          <em>· {thinkingValue()}</em>
        </Show>
        <Icon name="chevD" sm />
      </button>
    </Show>
  );

  const showCard = () => !!state.pendingInteraction && !isTerminal();
  const composerVisible = () => !showCard() || (cardCollapsed() && !!state.normalizedTurns[state.normalizedTurns.length - 1]?.pendingQuestion);

  return (
    <div class="page">
      <div class="hdr float">
        <button class="cbtn" aria-label={t("common.back")} onClick={back}>
          <Icon name="chevL" />
        </button>
        <button class="ht" onClick={() => (tab()?.panes.length ?? 0) > 1 && setPanel("panes")}>
          <div class="t">
            <Show when={working()}>
              <span class="spin" />
            </Show>
            <Show when={state.agentStatus === "blocked"}>
              <span class="wd" />
            </Show>
            <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>{tab()?.label ?? state.sessionTitle ?? t("session.fallbackTitle")}</span>
          </div>
          <div class="s">
            {pane() ? paneLabel(pane()!) : ""}
            <Show when={(tab()?.panes.length ?? 0) > 1}> · {t("home.paneCount", { count: tab()!.panes.length })} ▾</Show>
          </div>
        </button>
        <button class="cbtn" aria-label={t("session.more")} onClick={() => setPanel("menu")}>
          <Icon name="more" />
        </button>
      </div>

      <div
        class="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        <div class="chat" ref={chat}>
          <Show when={!state.connected || !state.herdrConnected}>
            <div style={{ margin: "0 -12px 8px" }}>
              <ConnectionBanner />
            </div>
          </Show>
          <div class="grow" />
          <Show
            when={!isTerminal()}
            fallback={
              <div style={{ display: "flex", "flex-direction": "column", height: "calc(100vh - 230px)" }}>
                <Screen />
                <Keys />
              </div>
            }
          >
            <Show
              when={state.session?.bound}
              fallback={
                <>
                  <For each={state.cards}>{(c) => <ScreenCard card={c} />}</For>
                  <Show when={state.cards.length === 0}>
                    <div class="newempty">{state.connected ? t("session.loading") : t("common.offline")}</div>
                  </Show>
                </>
              }
            >
              <For each={state.normalizedTurns}>{(turn, i) => <Turn turn={turn} last={i() === state.normalizedTurns.length - 1} working={working()} />}</For>
              <Show when={state.normalizedTurns.length === 0}>
                <div class="newempty">{t("session.noMessages")}</div>
              </Show>
            </Show>
            <Show when={working()}>
              <div class="typing">
                <span class="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {t("transcript.thinkingNow")}
              </div>
            </Show>
            <For each={state.queue}>
              {(q) => (
                <>
                  <div class="ub q">{q.text || t("session.attachments", { count: q.attachments.length })}</div>
                  <div class="ubm">
                    {t("session.queued")}
                    <Show when={composerVisible()}>
                      <button onClick={() => editQueued(q)}>{t("session.edit")}</button>
                    </Show>
                    <button
                      onClick={() =>
                        request({ type: "queue_cancel", payload: { targetPaneId: state.activePaneId!, queueId: q.queueId } }).catch((e) => showToast(e.message || t("session.undoFailed")))
                      }
                    >
                      {t("session.undo")}
                    </button>
                  </div>
                </>
              )}
            </For>
          </Show>
          <div class="tail" style={{ height: `${dockH() + 24}px` }} />
        </div>
      </div>

      <div class="dock" ref={dock}>
        <div class="dockrow">
          <TodoCapsule />
          <Show when={!nearBottom()}>
            <button class="jump" aria-label={t("session.jump")} onClick={() => toBottom(true)}>
              <Icon name="down" />
            </button>
          </Show>
        </div>
        <Show when={showCard()}>
          <PromptCard collapsed={cardCollapsed()} onCollapse={() => setCardCollapsed(true)} onExpand={() => setCardCollapsed(false)} />
        </Show>
        <Show when={composerVisible() && state.activePaneId} keyed>
          {(paneId) => (
            <Composer
              draftId={paneId}
              placeholder={isTerminal() ? t("composer.placeholderCommand") : working() ? t("composer.placeholderQueued") : t("composer.placeholderReply")}
              onSend={(text, ids) => sendPrompt(text, ids)}
              working={working()}
              onStop={stop}
              onPlus={isTerminal() ? undefined : () => setPanel("plus")}
              modelChip={modelChip()}
            />
          )}
        </Show>
      </div>

      <Show when={panel() === "menu"}>
        <div class="menuwrap" onClick={() => setPanel(null)}>
          <div class="menu" onClick={(e) => e.stopPropagation()}>
            <button
              class="mi"
              onClick={() => {
                setPanel(null);
                if (tab()) openOverlay({ kind: "rename", tabId: tab()!.id });
              }}
            >
              <Icon name="edit" />
              {t("common.rename")}
            </button>
            <Show when={tab()?.branch || found()?.ws.branch}>
              <button
                class="mi"
                onClick={() => {
                  setPanel(null);
                  copyText(tab()?.branch || found()!.ws.branch!);
                }}
              >
                <Icon name="branch" />
                <div>
                  {t("menu.copyBranch")}
                  <small class="mono">{tab()?.branch || found()?.ws.branch}</small>
                </div>
              </button>
            </Show>
            <Show when={!isTerminal()}>
              <button class="mi" onClick={() => setPanel("changes")}>
                <Icon name="diff" />
                {t("changes.title")}
              </button>
            </Show>
            <Show when={(tab()?.panes.length ?? 0) > 1}>
              <button class="mi" onClick={() => setPanel("panes")}>
                <Icon name="panes" />
                {t("panes.title")}
              </button>
            </Show>
            <Show when={!isTerminal()}>
              <button
                class="mi"
                onClick={() => {
                  setPanel(null);
                  openTerminal();
                }}
              >
                <Icon name="term" />
                {t("menu.viewTerminal")}
              </button>
            </Show>
            <div class="msep" />
            <button
              class="mi red"
              onClick={() => {
                setPanel(null);
                if (tab()) openOverlay({ kind: "close", tabId: tab()!.id });
              }}
            >
              <Icon name="xcircle" />
              {t("close.title")}
            </button>
          </div>
        </div>
      </Show>
      <Show when={panel() === "changes"}>
        <ChangesSheet onClose={() => setPanel(null)} />
      </Show>
      <Show when={panel() === "panes"}>
        <PaneSheet onClose={() => setPanel(null)} />
      </Show>
      <Show when={panel() === "plus"}>
        <PlusSheet
          onClose={() => setPanel(null)}
          onSkills={() => setPanel("skills")}
          onResume={
            recipe()?.resumable
              ? () => {
                  setPanel(null);
                  navigate({ name: "new", workspaceId: found()?.ws.id ?? null, mode: "resume" });
                }
              : undefined
          }
        />
      </Show>
      <Show when={panel() === "skills"}>
        <SkillsSheet
          onClose={() => setPanel(null)}
          onPick={(s) => {
            setPanel(null);
            insertIntoComposer(s.invocation);
          }}
        />
      </Show>
      <Show when={panel() === "model"}>
        <ModelSheet
          recipe={recipe()}
          model={modelValue()}
          thinking={thinkingValue()}
          modelSource={state.session ? t(SOURCE_TEXT[state.session.model.source]) : undefined}
          thinkingSource={state.session?.thinking.value ? t(SOURCE_TEXT[state.session.thinking.source]) : undefined}
          canSwitchModel={!!recipe()?.runtimeSwitch.model}
          canSwitchThinking={!!recipe()?.runtimeSwitch.thinking}
          onClose={() => setPanel(null)}
          onPick={(change) => {
            request({ type: "agent_set_model", payload: { targetPaneId: state.activePaneId!, ...change } })
              .then(() => showToast(t("model.switchSent", { value: (change.modelId ?? change.thinking)! })))
              .catch((e) => showToast(e.message || t("model.switchFailed")));
            setPanel(null);
          }}
        />
      </Show>
      <ToolSheet />
      <TodoSheet />
      <TerminalSheet />
    </div>
  );
}
