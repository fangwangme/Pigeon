import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { navigate, state } from "../state/store";
import { fetchQuota } from "../state/ws";
import { quotaLevel, quotaPace } from "../../../shared/quota";
import { Icon } from "./ui";
import { t } from "../i18n";

const ORDERED_PROVIDERS = ["claude", "codex", "antigravity"] as const;

const PROVIDER_NAMES: Record<string, string> = {
  claude: "CLAUDE CODE",
  codex: "CODEX",
  antigravity: "ANTIGRAVITY",
};

export function formatDurationShort(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  const D = 1440;
  if (min >= D) return `${Math.floor(min / D)}d ${Math.floor((min % D) / 60)}h`;
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function QuotaPage() {
  const [refreshing, setRefreshing] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    if (!state.quotaSnapshots || state.quotaSnapshots.length === 0) {
      void fetchQuota(false);
    }
    const timer = setInterval(() => setNow(Date.now()), 30000);
    onCleanup(() => clearInterval(timer));
  });

  const doRefresh = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      await fetchQuota(true);
    } finally {
      setRefreshing(false);
    }
  };

  const backTarget = () => (state.route.name === "quota" ? (state.route.from ?? "home") : "home");

  const used = () => state.quotaDisplay === "used";

  const enabledProviders = () => {
    const list: typeof state.quotaSnapshots = [];
    for (const key of ORDERED_PROVIDERS) {
      if (state.quotaProviders[key] === false) continue;
      const found = state.quotaSnapshots.find((s) => s.provider === key);
      if (found) list.push(found);
    }
    return list;
  };

  const hasAnyData = () => enabledProviders().some((p) => p.snapshot && p.snapshot.windows && p.snapshot.windows.length > 0);

  return (
    <div class="page">
      {/* Shared Header */}
      <div class="hdr" style={{ padding: "12px 12px 8px" }}>
        <button class="cbtn" aria-label={t("common.back")} onClick={() => navigate({ name: backTarget() })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">{t("quota.title")}</div>
          <div class="s">
            {refreshing()
              ? t("quota.refreshing")
              : state.quotaUpdated
              ? t("quota.refreshedAt", { time: formatTime(state.quotaUpdated) })
              : ""}
          </div>
        </div>
        <button class="cbtn" aria-label={t("app.reload")} onClick={doRefresh}>
          <Show
            when={refreshing()}
            fallback={<Icon name="clock" />}
          >
            <span
              style={{
                width: "16px",
                height: "16px",
                "border-radius": "50%",
                border: "2px solid var(--line2)",
                "border-top-color": "var(--accent)",
                "box-sizing": "border-box",
                display: "block",
                animation: "spin .8s linear infinite",
              }}
            />
          </Show>
        </button>
      </div>

      <div class="scroll">
        <div style={{ padding: "0 16px calc(30px + env(safe-area-inset-bottom))" }}>
          {/* Segmented switch */}
          <div style={{ "margin-top": "6px" }}>
            <div
              style={{
                display: "grid",
                "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                gap: "0",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                "border-radius": "12px",
                padding: "3px",
              }}
            >
              <span
                style={{
                  height: "38px",
                  "border-radius": "9px",
                  background: "var(--code)",
                  display: "grid",
                  "place-items": "center",
                  "font-weight": 600,
                  "font-size": "14.5px",
                }}
              >
                {t("quota.tabQuota")}
              </span>
              <button
                style={{
                  height: "38px",
                  "border-radius": "9px",
                  display: "grid",
                  "place-items": "center",
                  "font-weight": 500,
                  "font-size": "14.5px",
                  color: "var(--muted)",
                }}
                onClick={() => navigate({ name: "usage", from: backTarget() })}
              >
                {t("quota.tabUsage")}
              </button>
            </div>
          </div>

          {/* Empty state */}
          <Show when={!hasAnyData()}>
            <div
              style={{
                margin: "14px 0 0",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                "border-radius": "18px",
                padding: "28px 20px",
                "text-align": "center",
                color: "var(--muted)",
                "font-size": "14px",
              }}
            >
              {t("quota.noData")}
              <div style={{ "margin-top": "12px" }}>
                <button
                  onClick={() => navigate({ name: "settings" })}
                  style={{ color: "var(--accent)", "font-weight": 600 }}
                >
                  {t("quota.manageProviders")}
                </button>
              </div>
            </div>
          </Show>

          {/* Provider cards */}
          <div style={{ "margin-top": "10px", display: "flex", "flex-direction": "column", gap: "12px" }}>
            <For each={enabledProviders()}>
              {(p) => {
                const providerDotColor = () => {
                  const windows = p.snapshot?.windows ?? [];
                  const hasExhausted = windows.some(
                    (w) => quotaLevel(w.usedPercent) === "exhausted" || quotaPace(w, now())?.kind === "ahead"
                  );
                  if (hasExhausted) return "var(--danger)";
                  const hasWarn = windows.some(
                    (w) => quotaLevel(w.usedPercent) === "warn" || quotaPace(w, now())?.kind === "on_track"
                  );
                  if (hasWarn) return "var(--warn)";
                  return "var(--addfg)";
                };

                return (
                  <div>
                    {/* Error banner above card if failed */}
                    <Show when={p.error}>
                      <div
                        style={{
                          background: "var(--dangerbg)",
                          border: "1px solid var(--danger)",
                          "border-radius": "14px",
                          padding: "10px 14px",
                          "font-size": "13px",
                          color: "var(--danger)",
                          display: "flex",
                          gap: "8px",
                          "align-items": "center",
                          "margin-bottom": "8px",
                        }}
                      >
                        <Icon name="alert" sm />
                        <span>{t("quota.errorPrefix", { error: p.error!.message })}</span>
                      </div>
                    </Show>

                    {/* Card */}
                    <Show when={p.snapshot}>
                      <div
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--line)",
                          "border-radius": "18px",
                          padding: "14px 16px 8px",
                        }}
                      >
                        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                          <span
                            style={{
                              width: "8px",
                              height: "8px",
                              "border-radius": "50%",
                              background: providerDotColor(),
                              flex: "none",
                            }}
                          />
                          <span
                            style={{
                              "font-weight": 700,
                              "font-size": "15px",
                              "letter-spacing": ".02em",
                              color: "var(--fg)",
                            }}
                          >
                            {PROVIDER_NAMES[p.provider] || p.provider.toUpperCase()}
                          </span>
                        </div>
                        <Show when={state.quotaShowAccount !== false && (p.snapshot?.plan || p.snapshot?.account)}>
                          <div style={{ "font-size": "12.5px", color: "var(--muted)", "margin-top": "2px" }}>
                            <Show when={p.snapshot?.plan}>
                              <b style={{ color: "var(--fg)", "font-weight": 600 }}>{p.snapshot?.plan} · </b>
                            </Show>
                            <span>{p.snapshot?.account ?? ""}</span>
                          </div>
                        </Show>

                        {/* Windows */}
                        <For each={p.snapshot?.windows ?? []}>
                          {(w) => {
                            const u = () => w.usedPercent;
                            const lvl = () => quotaLevel(u());
                            const pResult = () => quotaPace(w, now());

                            const tag = () => {
                              if (!w.family) return w.label;
                              if (w.label.toLowerCase().includes(w.family.toLowerCase())) return w.label;
                              return `${w.label} · ${w.family}`;
                            };

                            const resetText = () => {
                              if (u() <= 0) return t("quota.notStarted");
                              if (!w.resetsAt) return "";
                              const diff = w.resetsAt - now();
                              return t("quota.resetIn", { time: formatDurationShort(diff) });
                            };

                            const barWidth = () => {
                              const share = used() ? u() : Math.max(0, 100 - u());
                              return `${Math.min(100, Math.max(0, share))}%`;
                            };

                            const statusColor = () => {
                              const l = lvl();
                              if (l === "exhausted") return "var(--danger)";
                              const pace = pResult();
                              if (pace?.kind === "ahead") return "var(--danger)";
                              if (pace?.kind === "on_track" || l === "warn") return "var(--warn)";
                              return "var(--addfg)";
                            };

                            const barColor = () => statusColor();

                            const markerPos = () => {
                              const pace = pResult();
                              if (!pace) return null;
                              const exp = used() ? pace.expectedPercent : 100 - pace.expectedPercent;
                              return Math.min(100, Math.max(0, exp));
                            };

                            const firstText = () =>
                              used()
                                ? t("quota.used", { pct: Math.round(u()).toString() })
                                : t("quota.remaining", { pct: Math.round(Math.max(0, 100 - u())).toString() });

                            const firstColor = () => {
                              if (statusColor() === "var(--danger)") return "var(--danger)";
                              if (statusColor() === "var(--warn)") return "var(--warn)";
                              return "var(--fg)";
                            };

                            const paceInfo = () => {
                              if (u() >= 100) return { text: t("quota.exhausted"), color: "var(--danger)" };
                              const pace = pResult();
                              if (!pace) return null;
                              if (pace.kind === "on_track") return { text: t("quota.onTrack"), color: "var(--warn)" };
                              if (pace.kind === "ahead") {
                                const eta = pace.etaMs ? formatDurationShort(pace.etaMs) : "";
                                return {
                                  text: t("quota.ahead", { deficit: Math.round(pace.deficit).toString(), eta }),
                                  color: "var(--danger)",
                                };
                              }
                              return {
                                text: t("quota.behind", { deficit: Math.round(-pace.deficit).toString() }),
                                color: "var(--addfg)",
                              };
                            };

                            return (
                              <div style={{ padding: "10px 0 8px", "border-top": "1px solid var(--line)", "margin-top": "8px" }}>
                                <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
                                  <span style={{ "font-size": "13.5px", "font-weight": 650, flex: 1, "letter-spacing": ".01em" }}>
                                    {tag()}
                                  </span>
                                  <span style={{ "font-size": "12.5px", color: "var(--muted)", "font-variant-numeric": "tabular-nums" }}>
                                    {resetText()}
                                  </span>
                                </div>
                                <div style={{ position: "relative", height: "14px", margin: "5px 0", display: "flex", "align-items": "center" }}>
                                  <div
                                    style={{
                                      width: "100%",
                                      height: "8px",
                                      "border-radius": "4px",
                                      background: "var(--line2)",
                                      overflow: "hidden",
                                    }}
                                  >
                                    <div
                                      style={{
                                        height: "8px",
                                        width: barWidth(),
                                        background: barColor(),
                                        transition: "width .2s ease-out",
                                      }}
                                    />
                                  </div>
                                  <Show when={markerPos() !== null}>
                                    <span
                                      style={{
                                        position: "absolute",
                                        top: 0,
                                        left: `calc(${markerPos()!.toFixed(1)}% - 1px)`,
                                        width: "2px",
                                        height: "14px",
                                        "border-radius": "1px",
                                        background: "var(--fg)",
                                        "box-shadow": "0 0 0 1px var(--surface)",
                                      }}
                                    />
                                  </Show>
                                </div>
                                <div style={{ display: "flex", "align-items": "baseline", gap: "10px", "font-size": "12.5px", "font-variant-numeric": "tabular-nums" }}>
                                  <span style={{ color: firstColor(), "font-weight": 600 }}>{firstText()}</span>
                                  <span style={{ flex: 1 }} />
                                  <Show when={paceInfo()}>
                                    <span style={{ color: paceInfo()!.color, "font-weight": 550, "text-align": "right" }}>
                                      {paceInfo()!.text}
                                    </span>
                                  </Show>
                                </div>
                              </div>
                            );
                          }}
                        </For>

                        {/* Reset Credits */}
                        <Show when={p.snapshot?.credits && p.snapshot.credits.length > 0}>
                          <div
                            style={{
                              "border-top": "1px solid var(--line)",
                              "margin-top": "8px",
                              padding: "10px 0 6px",
                              "font-size": "12.5px",
                            }}
                          >
                            <div style={{ display: "flex", color: "var(--fg)", "font-weight": 600 }}>
                              <span style={{ flex: 1 }}>{t("quota.creditsTitle")}</span>
                              <span>{t("quota.creditsExpiry")}</span>
                            </div>
                            <For each={p.snapshot?.credits}>
                              {(c) => (
                                <div style={{ display: "flex", color: "var(--muted)", "margin-top": "4px", "font-variant-numeric": "tabular-nums" }}>
                                  <span style={{ flex: 1 }}>{c.amount}</span>
                                  <span>{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Manage queried providers button */}
          <div style={{ "margin-top": "14px" }}>
            <button
              onClick={() => navigate({ name: "settings" })}
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                gap: "6px",
                width: "100%",
                "min-height": "44px",
                "border-radius": "12px",
                border: "1px solid var(--line2)",
                color: "var(--accent)",
                "font-size": "14px",
                "font-weight": 550,
                background: "none",
              }}
            >
              <Icon name="sliders" sm />
              {t("quota.manageProviders")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
