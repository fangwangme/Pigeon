import { createEffect, createSignal, For, on, Show } from "solid-js";
import { navigate, setLocalePref, setReduceTransparency, setState, showToast, state, systemReducesTransparency } from "../state/store";
import { initWebSocket, isInAppBrowser, request, sendConfigPatch } from "../state/ws";
import { ACCENTS, resolveMode } from "../themes";
import type { AccentName, DeviceInfo, QuotaProvidersConfig, ThemeMode, UsageGetPayload } from "../../../types/protocol";
import { ago, Icon, Logo } from "./ui";
import { LOCALES, rich, t, type LocalePref, type MessageId } from "../i18n";
import { fmtCost } from "./UsagePage";
import { formatYMD } from "../../../shared/usage";

/** §8.1: the newest devices shown before the rest are folded away. */
const DEVICES_SHOWN = 5;

const MODES: Array<[ThemeMode, MessageId]> = [
  ["system", "settings.followSystem"],
  ["light", "settings.light"],
  ["dark", "settings.dark"],
];

/** §8.1, §10.1: 跟随系统 plus every language, each named in its own language. */
const LANGUAGES: Array<[LocalePref, () => string]> = [
  ["system", () => t("settings.followSystem")],
  ...(Object.entries(LOCALES) as Array<[LocalePref, { label: string }]>).map(([code, l]): [LocalePref, () => string] => [code, () => l.label]),
];

function installApp(): void {
  const prompt = (window as any).__pigeonDeferredPrompt;
  if (!prompt) return;
  prompt.prompt();
  prompt.userChoice.finally(() => setState("canInstallPWA", false));
}

/** §8.1 */
export function Settings() {
  const [devices, setDevices] = createSignal<DeviceInfo[] | null>(null);
  const [allDevices, setAllDevices] = createSignal(false);
  const shownDevices = () => (allDevices() ? devices()! : devices()!.slice(0, DEVICES_SHOWN));
  const hiddenCount = () => Math.max(0, (devices()?.length ?? 0) - DEVICES_SHOWN);
  const reduce = () => state.reduceTransparency ?? systemReducesTransparency();
  const load = () =>
    request({ type: "devices_list" })
      .then((ack) => setDevices(ack.devices ?? []))
      .catch(() => setDevices(null));
  createEffect(on(() => state.connected, (c) => c && void load()));

  const [usageSummaryText, setUsageSummaryText] = createSignal<string>("—");
  createEffect(
    on(
      () => state.connected && state.configReady && state.quotaUsageEnabled !== false,
      (on) => {
        if (on) {
          void request({
            type: "usage_get",
            payload: { preset: "7d", agents: ["claude", "codex", "agy", "opencode", "pi"] },
          })
            .then((res: UsageGetPayload) => {
              if (res && res.totals && res.days) {
                const now = new Date();
                const todayStr = formatYMD(now);
                const todayCost = res.days.find((d) => d.date === todayStr)?.cost ?? 0;
                setUsageSummaryText(t("settings.usageSummary", { today: fmtCost(todayCost), week: fmtCost(res.totals.cost) }));
              }
            })
            .catch(() => {});
        }
      }
    )
  );

  const quotaSummaryText = () => {
    const items: string[] = [];
    const used = state.quotaDisplay === "used";
    for (const pKey of ["claude", "codex", "antigravity"] as const) {
      if (state.quotaProviders[pKey] === false) continue;
      const snap = state.quotaSnapshots.find((s) => s.provider === pKey)?.snapshot;
      if (!snap || !snap.windows.length) continue;
      const w = snap.windows[0];
      const name = pKey === "claude" ? "Claude 5h" : pKey === "codex" ? "Codex" : "Antigravity";
      const pct = Math.round(used ? w.usedPercent : Math.max(0, 100 - w.usedPercent));
      const remOrUsed = used ? t("settings.quotaUsedSummary", { pct: pct.toString() }) : t("settings.quotaRemSummary", { pct: pct.toString() });
      items.push(`${name} ${remOrUsed}`);
    }
    return items.length ? items.join(" · ") : "—";
  };

  const revoke = (d: DeviceInfo) =>
    request({ type: "device_revoke", payload: { deviceId: d.deviceId } })
      .then(() => {
        showToast(t("settings.deviceRemoved", { name: d.deviceName }));
        void load();
      })
      .catch((e) => showToast(e.message || t("settings.removeFailed")));

  return (
    <div class="page">
      <div class="hdr">
        <button class="cbtn" aria-label={t("common.back")} onClick={() => navigate({ name: "home" })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">{t("settings.title")}</div>
        </div>
        <div style={{ width: "44px" }} />
      </div>
      <div class="scroll">
        <div class="settings">
          <div class="sec">{t("settings.appearance")}</div>
          <div class="seg">
            <For each={MODES}>
              {([m, label]) => (
                <button class={state.themeMode === m ? "on" : ""} onClick={() => sendConfigPatch({ themeMode: m })}>
                  {t(label)}
                </button>
              )}
            </For>
          </div>
          <div class="card" style={{ "margin-top": "10px" }}>
            <div class="li">
              <div class="tx">{t("settings.accent")}</div>
              <div class="sw">
                <For each={Object.entries(ACCENTS) as Array<[AccentName, (typeof ACCENTS)[AccentName]]>}>
                  {([name, a]) => (
                    <button class={state.accent === name ? "on" : ""} aria-label={t(a.label)} onClick={() => sendConfigPatch({ accent: name })}>
                      <i style={{ background: a[resolveMode(state.themeMode)] }} />
                    </button>
                  )}
                </For>
              </div>
            </div>
            <button class="li" onClick={() => setReduceTransparency(!reduce())}>
              <div class="tx">
                {t("settings.reduceTransparency")}
                <small>{t("settings.reduceTransparencyHint")}</small>
              </div>
              <span class={`tg${reduce() ? "" : " off"}`} />
            </button>
          </div>
          <p class="note">{t("settings.appearanceNote")}</p>

          <div class="sec">{t("settings.language")}</div>
          <div class="seg">
            <For each={LANGUAGES}>
              {([code, label]) => (
                <button class={state.localePref === code ? "on" : ""} onClick={() => setLocalePref(code)}>
                  {label()}
                </button>
              )}
            </For>
          </div>
          <p class="note">{t("settings.languageNote")}</p>

          <div class="sec">{t("settings.quotaUsage")}</div>
          <div class="card">
            <button class="li" onClick={() => sendConfigPatch({ quotaUsageEnabled: state.quotaUsageEnabled === false })}>
              <div class="tx">{t("settings.quotaUsageEnabled")}</div>
              <span class={`tg${state.quotaUsageEnabled !== false ? "" : " off"}`} />
            </button>
            <Show when={state.quotaUsageEnabled !== false}>
              <button class="li" onClick={() => navigate({ name: "quota", from: "settings" })}>
                <span style={{ width: "32px", height: "32px", "border-radius": "9px", background: "var(--accentbg)", color: "var(--accent)", display: "grid", "place-items": "center", flex: "none" }}>
                  <Icon name="gauge" sm />
                </span>
                <div class="tx">
                  {t("settings.subscriptionQuota")}
                  <small>{quotaSummaryText()}</small>
                </div>
                <Icon name="chevR" sm />
              </button>
              <button class="li" onClick={() => navigate({ name: "usage", from: "settings" })}>
                <span style={{ width: "32px", height: "32px", "border-radius": "9px", background: "var(--accentbg)", color: "var(--accent)", display: "grid", "place-items": "center", flex: "none" }}>
                  <Icon name="barChart" sm />
                </span>
                <div class="tx">
                  {t("settings.tokenUsage")}
                  <small>{usageSummaryText()}</small>
                </div>
                <Icon name="chevR" sm />
              </button>
              <div class="li">
                <div class="tx">{t("settings.quotaDisplay")}</div>
                <div
                  class="seg"
                  style={{
                    display: "grid",
                    "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                    width: "180px",
                    padding: "2px",
                    "border-radius": "9px",
                    flex: "none",
                  }}
                >
                  <button
                    class={state.quotaDisplay !== "used" ? "on" : ""}
                    style={{ height: "30px", "font-size": "13px" }}
                    onClick={() => sendConfigPatch({ quotaDisplay: "remaining" })}
                  >
                    {t("settings.remaining")}
                  </button>
                  <button
                    class={state.quotaDisplay === "used" ? "on" : ""}
                    style={{ height: "30px", "font-size": "13px" }}
                    onClick={() => sendConfigPatch({ quotaDisplay: "used" })}
                  >
                    {t("settings.used")}
                  </button>
                </div>
              </div>
              <button class="li" onClick={() => sendConfigPatch({ quotaButton: !state.quotaButton })}>
                <div class="tx">{t("settings.showQuotaButton")}</div>
                <span class={`tg${state.quotaButton ? "" : " off"}`} />
              </button>
              <button class="li" onClick={() => sendConfigPatch({ quotaShowAccount: state.quotaShowAccount === false })}>
                <div class="tx">{t("settings.quotaShowAccount")}</div>
                <span class={`tg${state.quotaShowAccount !== false ? "" : " off"}`} />
              </button>
              <div class="li">
                <div class="tx">{t("settings.usageScanMode")}</div>
                <div
                  class="seg"
                  style={{
                    display: "grid",
                    "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                    width: "180px",
                    padding: "2px",
                    "border-radius": "9px",
                    flex: "none",
                  }}
                >
                  <button
                    class={state.usageScanMode !== "realtime" ? "on" : ""}
                    style={{ height: "30px", "font-size": "12.5px" }}
                    onClick={() => sendConfigPatch({ usageScanMode: "scheduled" })}
                  >
                    {t("settings.usageScanScheduled")}
                  </button>
                  <button
                    class={state.usageScanMode === "realtime" ? "on" : ""}
                    style={{ height: "30px", "font-size": "12.5px" }}
                    onClick={() => sendConfigPatch({ usageScanMode: "realtime" })}
                  >
                    {t("settings.usageScanRealtime")}
                  </button>
                </div>
              </div>

              <Show when={state.usageScanMode !== "realtime"}>
                <div class="li" style={{ "justify-content": "space-between", "align-items": "center" }}>
                  <div class="tx">{t("settings.usageScanInterval")}</div>
                  <div style={{ display: "inline-flex", gap: "6px" }}>
                    <For each={["1m", "2m", "5m", "10m", "15m"] as const}>
                      {(interval) => {
                        const isSel = () => (state.usageScanInterval || "5m") === interval;
                        return (
                          <button
                            style={{
                              height: "28px",
                              padding: "0 8px",
                              "border-radius": "6px",
                              border: "1px solid var(--line)",
                              font: "inherit",
                              "font-size": "12px",
                              "font-weight": isSel() ? 650 : 500,
                              background: isSel() ? "var(--accentbg)" : "var(--surface)",
                              color: isSel() ? "var(--accent)" : "var(--fg)",
                              transition: "all .15s",
                            }}
                            onClick={() => sendConfigPatch({ usageScanInterval: interval })}
                          >
                            {interval}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
          <Show when={state.quotaUsageEnabled !== false}>
            <p class="note">{t("settings.usageScanModeHint")}</p>

            <div class="sec">{t("settings.queriedProviders")}</div>
            <div class="card">
              <For each={["claude", "codex", "antigravity"] as const}>
                {(pKey) => {
                  const isOn = () => state.quotaProviders[pKey] !== false;
                  const snap = () => state.quotaSnapshots.find((s) => s.provider === pKey);
                  const sub = () => {
                    if (!isOn()) return t("settings.providerDisabled");
                    const s = snap();
                    if (s?.snapshot?.plan) return t("settings.providerPlan", { plan: s.snapshot.plan });
                    if (s?.snapshot) return t("settings.providerActive");
                    return t("settings.providerActive");
                  };
                  const toggle = () => {
                    const updated: QuotaProvidersConfig = {
                      claude: state.quotaProviders.claude !== false,
                      codex: state.quotaProviders.codex !== false,
                      antigravity: state.quotaProviders.antigravity !== false,
                      [pKey]: !isOn(),
                    };
                    sendConfigPatch({ quotaProviders: updated });
                  };
                  return (
                    <button class="li" onClick={toggle}>
                      <div class="tx">
                        {pKey === "claude" ? "Claude Code" : pKey === "codex" ? "Codex" : "Antigravity"}
                        <small>{sub()}</small>
                      </div>
                      <span class={`tg${isOn() ? "" : " off"}`} />
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={state.quotaUsageEnabled === false}>
            <p class="note">{t("settings.quotaUsageDisabledHint")}</p>
          </Show>

          <div class="sec">{t("settings.notifications")}</div>
          <div class="card">
            <div class="li off">
              <div class="tx">{t("settings.push")}</div>
              <button class="tg off" disabled aria-label={t("settings.push")} />
            </div>
            <div class="li off">
              <div class="tx">{t("settings.pushWaiting")}</div>
              <button class="tg off" disabled aria-label={t("settings.pushWaiting")} />
            </div>
            <div class="li off">
              <div class="tx">{t("settings.pushDone")}</div>
              <button class="tg off" disabled aria-label={t("settings.pushDone")} />
            </div>
          </div>
          <p class="note">{t("settings.pushNotConnected")}</p>

          <div class="sec">{t("settings.devicesAndPairing")}</div>
          <div class="card">
            <div class="li">
              <Icon name="laptop" />
              <div class="tx">{t("settings.computer")}</div>
              <span class="v">{state.connected ? t("settings.connected") : t("settings.disconnected")}</span>
            </div>
            <div class="li">
              <Icon name="layers" />
              <div class="tx">Herdr</div>
              <span class="v">{state.herdrConnected ? t("settings.herdrOk") : t("settings.herdrDown")}</span>
            </div>
          </div>
          <div class="sec">{t("settings.pairedDevices")}</div>
          <div class="card">
            <Show when={devices()} fallback={<div class="li off">{state.connected ? t("common.loading") : t("common.offline")}</div>}>
              <For each={shownDevices()} fallback={<div class="li off">{t("settings.noDevices")}</div>}>
                {(d) => (
                  <div class="li">
                    <Icon name="phone" />
                    <div class="tx">
                      {d.deviceName}
                      {d.isThisDevice ? t("settings.thisDevice") : ""}
                      <small>{t("settings.lastUsed", { when: ago(d.lastUsedAt) })}</small>
                    </div>
                    <button class="lnk" style={{ color: "var(--danger)" }} onClick={() => revoke(d)}>
                      {t("common.remove")}
                    </button>
                  </div>
                )}
              </For>
              <Show when={hiddenCount() > 0}>
                <button class="li more" aria-expanded={allDevices()} onClick={() => setAllDevices(!allDevices())}>
                  <div class="tx">{allDevices() ? t("common.collapse") : t("settings.showMoreDevices", { count: hiddenCount() })}</div>
                  <span class={`chev${allDevices() ? "" : " shut"}`}>
                    <Icon name="chevD" sm />
                  </span>
                </button>
              </Show>
            </Show>
          </div>
          <p class="note">
            {rich("settings.pairHint", { cmd: <code class="mono">pigeon pair</code> })}
          </p>

          <div class="sec">{t("settings.about")}</div>
          <div class="card">
            <div class="li">
              <div class="tx">{t("settings.version")}</div>
              <span class="v mono">{state.serverVersion ?? "—"}</span>
            </div>
            <Show
              when={state.canInstallPWA}
              fallback={
                <div class="li">
                  <div class="tx">
                    {t("settings.install")}
                    <small>{t("settings.installHint")}</small>
                  </div>
                </div>
              }
            >
              <button class="li" onClick={installApp}>
                <div class="tx">{t("settings.install")}</div>
                <Icon name="chevR" sm />
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

/** §8.2: shown alone while this browser holds no valid pairing. */
export function Pairing() {
  const [copied, setCopied] = createSignal(false);
  const copyPairLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div class="page">
      <div class="pair">
        <Logo />
        <div style={{ "font-size": "24px", "font-weight": 700 }}>{t("pair.title")}</div>
        <p class="note" style={{ "font-size": "15px" }}>
          {t("pair.lead")}
        </p>
        <Show when={isInAppBrowser()}>
          <div class="banner warn" style={{ margin: "14px 0", "text-align": "left", width: "100%", "box-sizing": "border-box" }}>
            <Icon name="alert" />
            <div>
              <b>{t("pair.inAppTitle")}</b>
              <div style={{ "margin-top": "4px", "font-size": "13px" }}>{t("pair.inAppDesc")}</div>
            </div>
          </div>
        </Show>
        <div class="steps">
          <div>
            <span>
              {rich("pair.step1", { cmd: <code class="mono">pigeon pair</code> })}
            </span>
          </div>
          <div>
            <span>{t("pair.step2")}</span>
          </div>
          <div>
            <span>{t("pair.step3")}</span>
          </div>
        </div>
        <button class="btn acc" onClick={() => void initWebSocket()}>
          {t("pair.retry")}
        </button>
        <Show when={window.location.href.includes("#code=")}>
          <button class="lnk" style={{ "margin-top": "12px", "font-size": "14px" }} onClick={copyPairLink}>
            {copied() ? t("common.copied") : t("pair.copyLink")}
          </button>
        </Show>
      </div>
    </div>
  );
}
