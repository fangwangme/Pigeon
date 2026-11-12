import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { navigate, openTerminal, setState, showToast, state } from "../state/store";
import { copyText, getDetail, request, requestSkills, selectPane, sendKeys, sendPrompt, setScreenWatch } from "../state/ws";
import type { FileDiffSummary, QueuedPrompt } from "../../../types/protocol";
import {
  cancelQueuedPromptEdit,
  Composer,
  editQueuedPrompt,
  insertIntoComposer,
  PlusSheet,
  SkillsSheet,
} from "./Composer";
import { ConnectionBanner } from "./Home";
import { openOverlay } from "./overlays";
import { PromptCard } from "./PromptCard";
import { DiffView, renderPath, ScreenCard, TodoCapsule, TodoSheet, ToolSheet, Turn } from "./Transcript";
import { DiffBadge, findPane, formatModelName, Icon, paneLabel, paneStatus, paneSummary, Sheet, StatusIcon } from "./ui";
import { t, type MessageId } from "../i18n";

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
  const [expanded, setExpanded] = createSignal<string | null>(null);
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
            {([path, f]) => {
              const isExp = () => expanded() === path;
              return (
                <div style={{ "border-bottom": "1px solid var(--line)" }}>
                  <button class="li" onClick={() => setExpanded(isExp() ? null : path)}>
                    <div class="tx mono" style={{ "font-size": "13.5px", "overflow-wrap": "anywhere" }}>
                      {path.split("/").pop()}
                      <small class="path-rev">{renderPath(path)}</small>
                    </div>
                    <DiffBadge add={f.add} del={f.del} />
                    <Icon name={isExp() ? "chevD" : "chevR"} sm class="chev" />
                  </button>
                  <Show when={isExp()}>
                    <div style={{ padding: "0 12px 12px" }}>
                      <For each={f.diffs}>
                        {(d) => (
                          <Show when={d.patch} fallback={<p class="note">{t("tool.noPatch")}</p>}>
                            <DiffView patch={d.patch!} />
                          </Show>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
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

type Panel = "menu" | "changes" | "panes" | "plus" | "skills" | null;

/** mobile-ui-and-themes.md §3.5: edit a queued prompt in-place on the server without changing queue position. */
function editQueued(q: QueuedPrompt): void {
  editQueuedPrompt(q.queueId, q.text, q.attachments);
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

  createEffect(() => {
    const paneId = state.activePaneId;
    const isWatch = state.terminalOpen;
    if (paneId) {
      setScreenWatch(paneId, isWatch);
    }
  });

  onCleanup(() => {
    if (state.activePaneId) {
      setScreenWatch(state.activePaneId, false);
    }
  });

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

  const modelValue = () => state.session?.model.value ?? pane()?.model ?? null;
  const thinkingValue = () => state.session?.thinking.value ?? null;
  const subText = () => {
    const parts: string[] = [];
    if (pane()) {
      parts.push(paneLabel(pane()!));
    }
    const m = modelValue() ? formatModelName(pane()?.agent, modelValue()) : null;
    const th = thinkingValue();
    if (m) parts.push(m);
    if (th) parts.push(th);
    return parts.join(" · ");
  };

  const showCard = () => !!state.pendingInteraction && !isTerminal();

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
            <Show when={state.paneSyncing}>
              <span class="spin" style={{ width: "10px", height: "10px", "border-width": "1.5px", "vertical-align": "-1px", "margin-right": "4px", display: "inline-block" }} />
              <span>{t("session.syncing")}</span>
              <Show when={subText()}>
                <span> · </span>
              </Show>
            </Show>
            {subText()}
            <Show when={(tab()?.panes.length ?? 0) > 1}> ▾</Show>
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
                    <Show
                      when={state.paneLoaded}
                      fallback={<div class="newempty">{state.connected ? t("session.loading") : t("common.offline")}</div>}
                    >
                      <div class="newempty">
                        <div style={{ "margin-bottom": "8px" }}>{t("session.noStructuredSession")}</div>
                        <button class="btn primary" onClick={() => openTerminal()}>
                          {t("session.openTerminal")}
                        </button>
                      </div>
                    </Show>
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
              {(q, idx) => (
                <>
                  <div class="ub q">{q.text || t("session.attachments", { count: q.attachments.length })}</div>
                  <div class="ubm">
                    <Show
                      when={state.queuePaused}
                      fallback={q.sending ? t("common.sending") : t("session.queued")}
                    >
                      <span class="wd" style={{ "margin-right": "4px" }} />
                      <span>{t("queue.paused")}</span>
                      <Show when={idx() === 0}>
                        <button
                          onClick={() => {
                            request({ type: "queue_resume", payload: { paneId: state.activePaneId! } }).catch((e) =>
                              showToast(e.message || t("queue.resumeFailed"))
                            );
                          }}
                        >
                          {t("queue.resume")}
                        </button>
                      </Show>
                    </Show>
                    <Show when={!q.sending}>
                      <button onClick={() => editQueued(q)}>{t("session.edit")}</button>
                      <button
                        onClick={() => {
                          cancelQueuedPromptEdit(q.queueId);
                          request({ type: "queue_cancel", payload: { targetPaneId: state.activePaneId!, queueId: q.queueId } }).catch((e) =>
                            showToast(e.message || t("session.undoFailed"))
                          );
                        }}
                      >
                        {t("session.undo")}
                      </button>
                    </Show>
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
        <Show when={state.activePaneId} keyed>
          {(paneId) => (
            <Composer
              draftId={paneId}
              placeholder={isTerminal() ? t("composer.placeholderCommand") : working() ? t("composer.placeholderQueued") : t("composer.placeholderReply")}
              onSend={(text, ids, queueId) => {
                if (queueId) {
                  return request({
                    type: "queue_update",
                    payload: { targetPaneId: state.activePaneId!, queueId, text, attachments: ids },
                  });
                }
                return sendPrompt(text, ids);
              }}
              working={working()}
              onStop={stop}
              onPlus={isTerminal() ? undefined : () => setPanel("plus")}
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
          onSkills={() => {
            requestSkills();
            setPanel("skills");
          }}
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
      <ToolSheet />
      <TodoSheet />
      <TerminalSheet />
    </div>
  );
}
