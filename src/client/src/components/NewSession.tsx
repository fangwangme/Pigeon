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
  const [defaultModel, setDefaultModel] = createSignal<string | null>(null);
  const [defaultThinking, setDefaultThinking] = createSignal<string | null>(null);
  const [pickedModel, setPickedModel] = createSignal<string | null>(null);
  const [pickedThinking, setPickedThinking] = createSignal<string | null>(null);
  const [touched, setTouched] = createSignal(false);
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
    on([wsId, agent], () => {
      setTouched(false);
      setPickedModel(null);
      setPickedThinking(null);
      setDefaultModel(null);
      setDefaultThinking(null);
    })
  );

  let defaultsSeq = 0;
  createEffect(
    on([wsId, agent, () => state.connected], ([w, a, conn]) => {
      const seq = ++defaultsSeq;
      if (!conn || !w || !a || !state.recipes[a]?.launchModel) return;
      request({ type: "launch_defaults", payload: { workspaceId: w, agentKind: a } })
        .then((ack) => {
          if (seq !== defaultsSeq) return;
          setDefaultModel(typeof ack?.model === "string" ? ack.model : null);
          setDefaultThinking(typeof ack?.thinking === "string" ? ack.thinking : null);
        })
        .catch(() => {
          // Leave defaults empty if unreachable or unknown; never fall back to models[0].
        });
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
    const chosenModel = touched() ? pickedModel() : null;
    const chosenThinking = touched() ? pickedThinking() : null;
    const payload = {
      workspaceId: wsId()!,
      agentKind: agent()!,
      ...(chosenModel ? { modelId: chosenModel } : {}),
      ...(chosenThinking && recipe()?.models.find((m) => m.id === chosenModel)?.thinkingLevels?.includes(chosenThinking)
        ? { thinking: chosenThinking }
        : {}),
      ...extra,
    };
    return request({ type: "create_tab_and_agent", payload }).then((ack) => go(ack.paneId));
  };

  const displayedModel = () => (touched() ? pickedModel() : defaultModel());
  const displayedThinking = () => (touched() ? pickedThinking() : defaultThinking());
  const thinkingLabel = () => (displayedThinking() ? ` · ${displayedThinking()}` : "");
  const showDefaultTag = () => !touched() && !!defaultModel();

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
              {(displayedModel() ? formatModelName(agent(), displayedModel()) + thinkingLabel() : t("new.defaultModel"))}
              <Show when={showDefaultTag()}>
                <span class="mtag">{t("model.defaultTag")}</span>
              </Show>
              <Icon name="chevD" />
            </button>
          </Show>
        </div>
        <Show when={mode() === "new" && recipe()?.launchModel && !touched()}>
          <p class="note" style={{ margin: "8px 2px 0" }}>
            {t("new.followsDefaults", { agent: agentLabel(agent()) })}
          </p>
        </Show>
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
          defaultModel={defaultModel()}
          defaultThinking={defaultThinking()}
          model={displayedModel()}
          thinking={displayedThinking()}
          touched={touched()}
          onClose={() => setSheet(null)}
          onConfirm={(chosenModel, chosenThinking) => {
            setPickedModel(chosenModel);
            setPickedThinking(chosenThinking);
            setTouched(true);
            setSheet(null);
          }}
          onRestoreDefault={() => {
            setPickedModel(null);
            setPickedThinking(null);
            setTouched(false);
            setSheet(null);
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
  defaultModel: string | null;
  defaultThinking: string | null;
  model: string | null;
  thinking: string | null;
  touched: boolean;
  onConfirm: (modelId: string | null, thinking: string | null) => void;
  onRestoreDefault: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [refreshing, setRefreshing] = createSignal(false);
  const [stagedModel, setStagedModel] = createSignal<string | null>(props.model);
  const [stagedThinking, setStagedThinking] = createSignal<string | null>(props.thinking);
  const [stagedRestored, setStagedRestored] = createSignal(!props.touched);

  const models = () => props.recipe?.models ?? [];
  const current = () => models().find((m) => m.id === stagedModel());
  const levels = () => current()?.thinkingLevels ?? [];
  const isDefaultModel = () => props.defaultModel !== null && stagedModel() === props.defaultModel;

  const shown = () => {
    const q = query().trim().toLowerCase();
    return q
      ? models().filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : models();
  };

  const selectModel = (id: string) => {
    setStagedModel(id);
    setStagedRestored(false);
    const target = models().find((m) => m.id === id);
    const lvls = target?.thinkingLevels ?? [];
    let nextThinking: string | null = null;
    if (lvls.length > 0) {
      if (stagedThinking() && lvls.includes(stagedThinking()!)) {
        nextThinking = stagedThinking();
      } else {
        nextThinking = lvls[0] ?? null;
      }
    }
    setStagedThinking(nextThinking);
  };

  const selectThinking = (lvl: string) => {
    setStagedThinking(lvl);
    setStagedRestored(false);
  };

  const restoreDefault = () => {
    setStagedModel(props.defaultModel);
    setStagedThinking(props.defaultThinking);
    setStagedRestored(true);
  };

  const confirm = () => {
    if (stagedRestored()) {
      props.onRestoreDefault();
      return;
    }
    props.onConfirm(stagedModel(), stagedThinking());
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
        <button class="btn acc sh-confirm" onClick={confirm}>
          {t("common.confirm")}
        </button>
      }
    >
      <div class="model-pinned-card">
        <div class="model-card-top">
          <div class="model-card-title">
            <span class="nm">
              {stagedModel() ? formatModelName(props.agent, stagedModel()) : (current()?.label ?? t("new.defaultModel"))}
            </span>
            <Show when={isDefaultModel()}>
              <span class="mtag">{t("model.agentDefault")}</span>
            </Show>
          </div>
          <Show when={props.defaultModel !== null && !stagedRestored()}>
            <button class="lnk" style={{ "flex-shrink": 0, "font-size": "12.5px" }} onClick={restoreDefault}>
              {t("model.restoreDefault")}
            </button>
          </Show>
        </div>
        <Show when={stagedModel()}>
          <div class="id mono">{stagedModel()}</div>
        </Show>
        <div class="thinking-row">
          <Show
            when={levels().length > 0}
            fallback={
              <Show when={stagedThinking()} fallback={<span class="unsupported">{t("model.noThinking")}</span>}>
                <span class="chip hi">{stagedThinking()}</span>
              </Show>
            }
          >
            <For each={levels()}>
              {(l) => (
                <button
                  class={`chip${l === stagedThinking() ? " hi" : ""}`}
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
        <div class="model-search-row">
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
        </div>
      </Show>

      <div class="card" style={{ "margin-top": "6px", "overflow-y": "auto" }}>
        <For
          each={shown()}
          fallback={<p class="note" style={{ padding: "10px 14px" }}>{t("model.none")}</p>}
        >
          {(m) => {
            const count = m.thinkingLevels?.length ?? 0;
            const isDefault = () => props.defaultModel !== null && m.id === props.defaultModel;
            return (
              <button
                class="li"
                onClick={() => selectModel(m.id)}
              >
                <div class="tx">
                  <div style={{ display: "flex", "align-items": "center", gap: "6px", "font-weight": 600 }}>
                    <span>{formatModelName(props.agent, m.id)}</span>
                    <Show when={isDefault()}>
                      <span class="mtag">{t("model.defaultTag")}</span>
                    </Show>
                  </div>
                  <small class="mono">{m.id}</small>
                </div>
                <Show when={count > 0}>
                  <span class="v" style={{ "font-size": "13px", "margin-right": "6px" }}>
                    {t("model.levelsCount", { count })}
                  </span>
                </Show>
                <Show when={m.id === stagedModel()}>
                  <span class="ck">
                    <Icon name="check" />
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={models().length <= 5}>
          <button class="li" style={{ color: "var(--accent)" }} disabled={refreshing()} onClick={refresh}>
            <Show when={refreshing()} fallback={<Icon name="refresh" sm />}>
              <span class="spin" />
            </Show>
            <div class="tx">{t("model.refreshList")}</div>
          </button>
        </Show>
      </div>
    </Sheet>
  );
}
