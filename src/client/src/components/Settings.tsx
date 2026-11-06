import { createEffect, createSignal, For, on, Show } from "solid-js";
import { navigate, setReduceTransparency, setState, showToast, state, systemReducesTransparency } from "../state/store";
import { initWebSocket, request, sendConfigPatch } from "../state/ws";
import { ACCENTS, resolveMode } from "../themes";
import type { AccentName, DeviceInfo, ThemeMode } from "../../../types/protocol";
import { ago, Icon } from "./ui";

const MODES: Array<[ThemeMode, string]> = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
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
  const reduce = () => state.reduceTransparency ?? systemReducesTransparency();
  const load = () =>
    request({ type: "devices_list" })
      .then((ack) => setDevices(ack.devices ?? []))
      .catch(() => setDevices(null));
  createEffect(on(() => state.connected, (c) => c && void load()));
  const revoke = (d: DeviceInfo) =>
    request({ type: "device_revoke", payload: { deviceId: d.deviceId } })
      .then(() => {
        showToast(`已移除 ${d.deviceName}`);
        void load();
      })
      .catch((e) => showToast(e.message || "移除失败"));

  return (
    <div class="page">
      <div class="hdr">
        <button class="cbtn" aria-label="返回" onClick={() => navigate({ name: "home" })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">设置</div>
        </div>
        <div style={{ width: "44px" }} />
      </div>
      <div class="scroll">
        <div class="settings">
          <div class="sec">外观</div>
          <div class="seg">
            <For each={MODES}>
              {([m, label]) => (
                <button class={state.themeMode === m ? "on" : ""} onClick={() => sendConfigPatch({ themeMode: m })}>
                  {label}
                </button>
              )}
            </For>
          </div>
          <div class="card" style={{ "margin-top": "10px" }}>
            <div class="li">
              <div class="tx">强调色</div>
              <div class="sw">
                <For each={Object.entries(ACCENTS) as Array<[AccentName, (typeof ACCENTS)[AccentName]]>}>
                  {([name, a]) => (
                    <button class={state.accent === name ? "on" : ""} aria-label={a.label} onClick={() => sendConfigPatch({ accent: name })}>
                      <i style={{ background: a[resolveMode(state.themeMode)] }} />
                    </button>
                  )}
                </For>
              </div>
            </div>
            <button class="li" onClick={() => setReduceTransparency(!reduce())}>
              <div class="tx">
                降低透明度
                <small>浮层改为不透明背景，只对这台手机生效</small>
              </div>
              <span class={`tg${reduce() ? "" : " off"}`} />
            </button>
          </div>
          <p class="note">外观会同步到所有配对的手机；降低透明度只保存在这台手机上。</p>

          <div class="sec">通知</div>
          <div class="card">
            <div class="li off">
              <div class="tx">推送通知</div>
              <button class="tg off" disabled aria-label="推送通知" />
            </div>
            <div class="li off">
              <div class="tx">Agent 等你时</div>
              <button class="tg off" disabled aria-label="Agent 等你时" />
            </div>
            <div class="li off">
              <div class="tx">Agent 完成时</div>
              <button class="tg off" disabled aria-label="Agent 完成时" />
            </div>
          </div>
          <p class="note">推送投递尚未接通。</p>

          <div class="sec">设备与配对</div>
          <div class="card">
            <div class="li">
              <Icon name="laptop" />
              <div class="tx">电脑</div>
              <span class="v">{state.connected ? "已连接" : "未连接"}</span>
            </div>
            <div class="li">
              <Icon name="layers" />
              <div class="tx">Herdr</div>
              <span class="v">{state.herdrConnected ? "正常" : "没有响应"}</span>
            </div>
          </div>
          <div class="sec">已配对的设备</div>
          <div class="card">
            <Show when={devices()} fallback={<div class="li off">{state.connected ? "读取中…" : "离线"}</div>}>
              <For each={devices()!} fallback={<div class="li off">没有设备</div>}>
                {(d) => (
                  <div class="li">
                    <Icon name="phone" />
                    <div class="tx">
                      {d.deviceName}
                      {d.isThisDevice ? "（本机）" : ""}
                      <small>最近使用 {ago(d.lastUsedAt)}</small>
                    </div>
                    <button class="lnk" style={{ color: "var(--danger)" }} onClick={() => revoke(d)}>
                      移除
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <p class="note">
            配对另一台手机：在电脑上运行 <code class="mono">pigeon pair</code>，用那台手机扫描二维码。移除立即生效。
          </p>

          <div class="sec">关于</div>
          <div class="card">
            <div class="li">
              <div class="tx">版本</div>
              <span class="v mono">{state.serverVersion ?? "—"}</span>
            </div>
            <Show
              when={state.canInstallPWA}
              fallback={
                <div class="li">
                  <div class="tx">
                    安装为应用
                    <small>在浏览器菜单里选择“添加到主屏幕”</small>
                  </div>
                </div>
              }
            >
              <button class="li" onClick={installApp}>
                <div class="tx">安装为应用</div>
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
  return (
    <div class="page">
      <div class="pair">
        <div class="logo">P</div>
        <div style={{ "font-size": "24px", "font-weight": 700 }}>连接你的电脑</div>
        <p class="note" style={{ "font-size": "15px" }}>
          Pigeon 需要先和电脑上的 Pigeon 配对。
        </p>
        <div class="steps">
          <div>
            <span>
              在电脑的终端里运行 <code class="mono">pigeon pair</code>
            </span>
          </div>
          <div>
            <span>用手机相机扫描终端里的二维码</span>
          </div>
          <div>
            <span>在浏览器中打开链接，配对完成后会回到首页</span>
          </div>
        </div>
        <button class="btn acc" onClick={() => void initWebSocket()}>
          我已配对，重试
        </button>
      </div>
    </div>
  );
}
