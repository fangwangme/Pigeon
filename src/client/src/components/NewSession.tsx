import { createEffect, createSignal, For, on, Show } from "solid-js";
import { navigate, showToast, state } from "../state/store";
import { refreshModels, request, selectPane } from "../state/ws";
import type { AgentRecipeSummary, PastSession } from "../../../types/protocol";
import { Composer } from "./Composer";
import { ago, agentLabel, formatModelName, Icon, Logo, Sheet } from "./ui";
import { t } from "../i18n";

function defaultAgent(): string | null {
  const kinds = Object.keys(state.recipes);
  return kinds.includes("claude") ? "claude" : kinds[0] ?? null;
}

/** §7.1 and §7.2 */
export function NewSession(props: { workspaceId: string | null; mode: "new" | "resume" }) {
  const [mode, setMode] = createSignal(props.mode);
  const [wsId, setWsId] = createSignal(props.workspaceId ?? state.workspaces.find((w) => w.isFocused)?.id ?? state.workspaces[0]?.id ?? null);
  const [agent, setAgent] = createSignal(state.activePaneId && props.mode === "resume" ? currentAgent() : defaultAgent());
  const [model, setModel] = createSignal<string | null>(null);
  const [thinking, setThinking] = createSignal<string | null>(null);
  const [sheet, setSheet] = createSignal<"ws" | "agent" | "model" | null>(null);
  const [past, setPast] = createSignal<PastSession[] | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  function currentAgent(): string | null {
    for (const w of state.workspaces) for (const t of w.tabs) for (const p of t.panes) if (p.id === state.activePaneId && p.agent) return p.agent;
    return defaultAgent();
  }

  const ws = () => state.workspaces.find((w) => w.id === wsId());
  const recipe = () => (agent() ? state.recipes[agent()!] : undefined);

  createEffect(
    on(agent, () => {
      setModel(recipe()?.launchModel ? (recipe()?.defaultModel ?? recipe()?.models[0]?.id ?? null) : null);
      setThinking(recipe()?.defaultThinking ?? null);
    })
  );
  createEffect(() => {
    if (!agent() && Object.keys(state.recipes).length) setAgent(defaultAgent());
    if (!wsId() && state.workspaces.length) setWsId(state.workspaces[0].id);
  });
  createEffect(
    on([mode, wsId, agent, () => state.connected], () => {
      if (mode() !== "resume" || !wsId() || !agent() || !state.connected) return;
      if (!recipe()?.resumable) return setPast([]);
      setPast(null);
      request({ type: "sessions_list", payload: { workspaceId: wsId()!, agentKind: agent()! } })
        .then((ack) => setPast(ack.sessions ?? []))
        .catch((e) => {
          setPast([]);
          showToast(e.message || t("new.listFailed"));
        });
    })
  );

  const go = (paneId: string) => {
    selectPane(paneId);
    navigate({ name: "session", from: "home" });
  };

  const create = (extra: { firstMessage?: string; resumeSessionId?: string }) => {
    if (!wsId() || !agent()) return Promise.reject({ message: t("new.pickFirst") });
    const payload = {
      workspaceId: wsId()!,
      agentKind: agent()!,
      ...(model() ? { modelId: model()! } : {}),
      ...(thinking() && recipe()?.models.find((m) => m.id === model())?.thinkingLevels?.includes(thinking()!) ? { thinking: thinking()! } : {}),
      ...extra,
    };
    return request({ type: "create_tab_and_agent", payload }).then((ack) => go(ack.paneId));
  };

  const thinkingLabel = () => (thinking() ? ` · ${thinking()}` : "");

  return (
    <div class="page">
      <div class="hdr">
        <button class="cbtn" aria-label={t("common.back")} onClick={() => navigate({ name: "home" })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">{t("new.title")}</div>
        </div>
        <div style={{ width: "44px" }} />
      </div>
      <div style={{ padding: "0 16px" }}>
        <div class="seg">
          <button class={mode() === "new" ? "on" : ""} onClick={() => setMode("new")}>
            {t("new.segNew")}
          </button>
          <button class={mode() === "resume" ? "on" : ""} onClick={() => setMode("resume")}>
            {t("new.segResume")}
          </button>
        </div>
        <div class="chipr" style={{ "margin-top": "10px", "flex-wrap": "wrap" }}>
          <button class="chip" onClick={() => setSheet("ws")}>
            <Icon name="folder" />
            {ws()?.label ?? t("new.pickWorkspace")}
            <Icon name="chevD" />
          </button>
          <button class="chip" onClick={() => setSheet("agent")}>
            <Icon name="spark" />
            {agent() ? agentLabel(agent()) : "Agent"}
            <Icon name="chevD" />
          </button>
          <Show when={mode() === "new" && recipe()?.launchModel}>
            <button class="chip" onClick={() => setSheet("model")}>
              <Icon name="layers" />
              {(model() ? formatModelName(agent(), model()) : t("new.defaultModel")) + thinkingLabel()}
              <Icon name="chevD" />
            </button>
          </Show>
        </div>
        <Show when={mode() === "new" && recipe() && !recipe()!.launchModel}>
          <p class="note" style={{ margin: "8px 2px 0" }}>
            {recipe()!.lastUsed
              ? t("new.lastUsed", {
                  agent: agentLabel(agent()),
                  model: formatModelName(agent(), recipe()!.lastUsed!.model) + (recipe()!.lastUsed!.thinking ? ` · ${recipe()!.lastUsed!.thinking}` : ""),
                })
              : t("new.lastUsedUnknown", { agent: agentLabel(agent()) })}
          </p>
        </Show>
      </div>

      <div class="scroll">
        <Show
          when={mode() === "resume"}
          fallback={
            <div class="newempty">
              <Logo />
              <div class="big">{t("new.start")}</div>
              <div class="mono" style={{ "font-size": "13px", "overflow-wrap": "anywhere" }}>
                {ws()?.folder ?? ""}
              </div>
              <p class="note" style={{ "margin-top": "14px" }}>
                {t("new.startHint")}
              </p>
            </div>
          }
        >
          <div class="reslist">
            <Show when={recipe()?.resumable} fallback={<p class="note">{t("new.notResumable", { agent: agentLabel(agent()) })}</p>}>
              <Show when={past()} fallback={<div class="newempty"><span class="spin" style={{ margin: "0 auto" }} /></div>}>
                <Show when={past()!.length} fallback={<p class="note">{t("new.noPast", { agent: agentLabel(agent()) })}</p>}>
                  <p class="note">{t("new.resumeHint")}</p>
                  <div class="card">
                    <For each={past()!}>
                      {(s) => (
                        <button
                          class="li"
                          disabled={!!busy()}
                          onClick={() => {
                            setBusy(s.id);
                            create({ resumeSessionId: s.id })
                              .catch((e) => showToast(e.message || t("new.resumeFailed")))
                              .finally(() => setBusy(null));
                          }}
                        >
                          <Icon name="clock" />
                          <div class="tx">
                            <div style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{s.title || t("new.untitled")}</div>
                            <small>{[ago(s.updatedAt), s.model ? formatModelName(agent(), s.model) : null].filter(Boolean).join(" · ")}</small>
                          </div>
                          <Show when={busy() === s.id} fallback={<Icon name="chevR" sm />}>
                            <span class="spin" />
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
        <div style={{ height: "120px" }} />
      </div>

      <Show when={mode() === "new"}>
        <div class="dock">
          <Composer draftId={null} placeholder={t("new.firstMessage")} onSend={(text) => create({ firstMessage: text })} />
        </div>
      </Show>

      <Show when={sheet() === "ws"}>
        <Sheet title={t("new.workspace")} onClose={() => setSheet(null)}>
          <div class="card">
            <For each={state.workspaces}>
              {(w) => (
                <button
                  class="li"
                  onClick={() => {
                    setWsId(w.id);
                    setSheet(null);
                  }}
                >
                  <Icon name="folder" />
                  <div class="tx">
                    {w.label}
                    <small class="mono">{w.folder}</small>
                  </div>
                  <Show when={w.id === wsId()}>
                    <span class="ck">
                      <Icon name="check" />
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <p class="note">{t("new.workspaceNote")}</p>
        </Sheet>
      </Show>
      <Show when={sheet() === "agent"}>
        <Sheet title="Agent" onClose={() => setSheet(null)}>
          <div class="card">
            <For each={Object.values(state.recipes)}>
              {(r) => (
                <button
                  class="li"
                  onClick={() => {
                    setAgent(r.kind);
                    setSheet(null);
                  }}
                >
                  <Icon name="spark" />
                  <div class="tx">{r.label}</div>
                  <Show when={r.kind === agent()}>
                    <span class="ck">
                      <Icon name="check" />
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Sheet>
      </Show>
      <Show when={sheet() === "model" && agent()}>
        <ModelPickerSheet
          agent={agent()!}
          recipe={recipe()}
          model={model()}
          thinking={thinking()}
          onClose={() => setSheet(null)}
          onPick={(chosenModel, chosenThinking) => {
            setModel(chosenModel);
            setThinking(chosenThinking);
          }}
        />
      </Show>
    </div>
  );
}

/** Design C Model Picker sheet (§6.4) */
function ModelPickerSheet(props: {
  agent: string;
  recipe: AgentRecipeSummary | undefined;
  model: string | null;
  thinking: string | null;
  onPick: (modelId: string, thinking: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [refreshing, setRefreshing] = createSignal(false);
  const [selectedModel, setSelectedModel] = createSignal<string | null>(props.model);
  const [selectedThinking, setSelectedThinking] = createSignal<string | null>(props.thinking);

  const models = () => props.recipe?.models ?? [];
  const current = () => models().find((m) => m.id === selectedModel());
  const levels = () => current()?.thinkingLevels ?? [];

  const shown = () => {
    const q = query().trim().toLowerCase();
    return q
      ? models().filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : models();
  };

  const selectModel = (id: string) => {
    setSelectedModel(id);
    const target = models().find((m) => m.id === id);
    const lvls = target?.thinkingLevels ?? [];
    let nextThinking: string | null = null;
    if (lvls.length > 0) {
      if (selectedThinking() && lvls.includes(selectedThinking()!)) {
        nextThinking = selectedThinking();
      } else {
        nextThinking = lvls[0] ?? null;
      }
    }
    setSelectedThinking(nextThinking);
    props.onPick(id, nextThinking);
  };

  const selectThinking = (lvl: string) => {
    setSelectedThinking(lvl);
    if (selectedModel()) {
      props.onPick(selectedModel()!, lvl);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    refreshModels(props.agent)
      .catch((e) => showToast(e.message || t("model.refreshFailed")))
      .finally(() => setRefreshing(false));
  };

  return (
    <Sheet
      full
      flush
      title={t("model.title")}
      sub={props.recipe?.label}
      onClose={props.onClose}
      right={
        <button
          class="cbtn"
          style={{ color: "var(--accent)" }}
          aria-label={t("model.refresh")}
          disabled={refreshing()}
          onClick={refresh}
        >
          <Show when={refreshing()} fallback={<Icon name="refresh" sm />}>
            <span class="spin" />
          </Show>
        </button>
      }
    >
      <div class="model-pinned-card">
        <div class="nm">{selectedModel() ? formatModelName(props.agent, selectedModel()) : (current()?.label ?? t("model.model"))}</div>
        <Show when={selectedModel()}>
          <div class="id mono">{selectedModel()}</div>
        </Show>
        <div class="thinking-row">
          <Show
            when={levels().length > 0}
            fallback={<span class="unsupported">{t("model.noThinking")}</span>}
          >
            <For each={levels()}>
              {(l) => (
                <button
                  class={`chip${l === selectedThinking() ? " hi" : ""}`}
                  onClick={() => selectThinking(l)}
                >
                  {l}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>

      <Show when={models().length > 5}>
        <div class="searchbar">
          <Icon name="search" sm />
          <input
            placeholder={t("model.search")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
          />
        </div>
      </Show>

      <div class="card" style={{ "margin-top": "6px", "overflow-y": "auto" }}>
        <For each={shown()} fallback={<p class="note">{t("model.none")}</p>}>
          {(m) => {
            const count = m.thinkingLevels?.length ?? 0;
            return (
              <button
                class="li"
                onClick={() => selectModel(m.id)}
              >
                <div class="tx">
                  <div style={{ "font-weight": 600 }}>{formatModelName(props.agent, m.id)}</div>
                  <small class="mono">{m.id}</small>
                </div>
                <Show when={count > 0}>
                  <span class="v" style={{ "font-size": "13px", "margin-right": "6px" }}>
                    {t("model.levelsCount", { count })}
                  </span>
                </Show>
                <Show when={m.id === selectedModel()}>
                  <span class="ck">
                    <Icon name="check" />
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Sheet>
  );
}
