import { Component, Show, createSignal } from "solid-js";
import { state, closePairingModal } from "../state/store";
import { pairWithCode, initWebSocket } from "../state/ws";

export const PairingModal: Component = () => {
  const [hostInput, setHostInput] = createSignal("");
  const [codeInput, setCodeInput] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);

  const handleConnect = async () => {
    const code = codeInput().trim();
    if (!code) {
      setErrorMessage("请输入配对码");
      return;
    }

    setConnecting(true);
    setErrorMessage("");

    try {
      const ok = await pairWithCode(hostInput().trim(), code);
      if (ok) {
        closePairingModal();
        initWebSocket();
      } else {
        setErrorMessage("配对失败，请检查电脑地址与配对码是否正确");
      }
    } catch (e: any) {
      setErrorMessage(e?.message || "连接失败");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Show when={state.pairingModalOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 60,
          background: "var(--bg)",
          color: "var(--fg)",
          display: "flex",
          "flex-direction": "column",
          "overflow-y": "auto",
          padding: "48px 24px 28px",
          gap: "24px",
          "box-sizing": "border-box",
        }}
      >
        {/* Close button at top right */}
        <button
          aria-label="关闭"
          class="touch-target"
          onClick={closePairingModal}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            width: "44px",
            height: "44px",
            border: 0,
            background: "transparent",
            color: "var(--muted)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        {/* Title area */}
        <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "14px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              "border-radius": "14px",
              background: "var(--sel)",
              border: "1px solid var(--selb)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--accent)",
            }}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 11l18-7-7 18-2.5-8z" />
              <path d="M11.5 14L21 4" />
            </svg>
          </div>
          <h1 style={{ margin: 0, "font-size": "26px", "font-weight": 700, "line-height": 1.25 }}>
            连接到你的电脑
          </h1>
          <p style={{ margin: 0, "font-size": "15px", "line-height": 1.6, color: "var(--muted)" }}>
            Pigeon 在电脑上运行，手机只是遥控器。配对一次后，手机会记住这台电脑。
          </p>
        </div>

        {/* QR Code instruction card */}
        <div
          style={{
            background: "var(--sheet)",
            border: "1px solid var(--codeb)",
            "border-radius": "16px",
            padding: "16px",
            display: "flex",
            gap: "16px",
            "align-items": "center",
          }}
        >
          <div
            style={{
              width: "112px",
              height: "112px",
              "flex-shrink": 0,
              "border-radius": "10px",
              background: "#FFFFFF",
              border: "1px solid var(--codeb)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
            }}
          >
            <svg
              width="88"
              height="88"
              viewBox="0 0 25 25"
              role="img"
              aria-label="终端里显示的配对二维码示意"
              shape-rendering="crispEdges"
            >
              <g fill="#111418">
                <path d="M0 0h7v7H0zM18 0h7v7h-7zM0 18h7v7H0z" />
              </g>
              <g fill="#FFFFFF">
                <path d="M1 1h5v5H1zM19 1h5v5h-5zM1 19h5v5H1z" />
              </g>
              <g fill="#111418">
                <path d="M2 2h3v3H2zM20 2h3v3h-3zM2 20h3v3H2z" />
                <path d="M8 0h1v1H8zM10 1h2v1h-2zM9 3h1v2H9zM12 2h1v3h-1zM14 0h2v1h-2zM15 3h1v1h-1zM8 6h1v1H8zM10 6h1v1h-1zM12 6h1v1h-1zM14 5h1v2h-1zM16 6h1v1h-1zM0 8h2v1H0zM3 8h1v2H3zM5 9h2v1H5zM8 8h3v1H8zM12 9h1v1h-1zM14 8h2v1h-2zM17 8h1v2h-1zM19 8h2v1h-2zM22 9h3v1h-3zM1 11h1v2H1zM4 11h2v1H4zM8 10h1v3H8zM10 11h2v1h-2zM13 11h1v1h-1zM15 10h1v2h-1zM18 11h2v1h-2zM21 11h1v2h-1zM23 12h2v1h-2zM0 14h1v1H0zM2 13h3v1H2zM6 14h1v2H6zM9 14h2v1H9zM12 13h1v3h-1zM14 14h2v1h-2zM17 13h1v1h-1zM19 14h3v1h-3zM23 15h1v2h-1zM8 16h2v1H8zM11 17h1v1h-1zM14 16h1v2h-1zM16 17h2v1h-2zM19 16h1v2h-1zM21 17h2v1h-2zM8 19h1v2H8zM10 19h2v1h-2zM13 19h1v1h-1zM15 19h1v2h-1zM17 20h3v1h-3zM21 19h1v1h-1zM23 19h2v2h-2zM9 22h2v1H9zM12 21h1v3h-1zM14 23h2v1h-2zM17 22h1v1h-1zM19 23h1v2h-1zM21 22h2v1h-2zM23 24h2v1h-2zM8 24h2v1H8z" />
              </g>
            </svg>
          </div>
          <ol
            style={{
              margin: 0,
              padding: 0,
              "list-style": "none",
              display: "flex",
              "flex-direction": "column",
              gap: "10px",
              "font-size": "13px",
              "line-height": 1.5,
            }}
          >
            <li style={{ display: "flex", gap: "8px" }}>
              <span
                style={{
                  width: "20px",
                  height: "20px",
                  "flex-shrink": 0,
                  "border-radius": "10px",
                  background: "var(--accentbg)",
                  color: "var(--accentt)",
                  "font-size": "11px",
                  "font-weight": 700,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                }}
              >
                1
              </span>
              <span>
                在电脑终端运行{" "}
                <code
                  style={{
                    "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    "font-size": "12px",
                    background: "var(--code)",
                    border: "1px solid var(--codeb)",
                    "border-radius": "4px",
                    padding: "1px 4px",
                  }}
                >
                  pigeon start
                </code>
              </span>
            </li>
            <li style={{ display: "flex", gap: "8px" }}>
              <span
                style={{
                  width: "20px",
                  height: "20px",
                  "flex-shrink": 0,
                  "border-radius": "10px",
                  background: "var(--accentbg)",
                  color: "var(--accentt)",
                  "font-size": "11px",
                  "font-weight": 700,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                }}
              >
                2
              </span>
              <span>用手机相机扫终端里的二维码</span>
            </li>
            <li style={{ display: "flex", gap: "8px" }}>
              <span
                style={{
                  width: "20px",
                  height: "20px",
                  "flex-shrink": 0,
                  "border-radius": "10px",
                  background: "var(--accentbg)",
                  color: "var(--accentt)",
                  "font-size": "11px",
                  "font-weight": 700,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                }}
              >
                3
              </span>
              <span>打开链接，自动完成配对</span>
            </li>
          </ol>
        </div>

        {/* Divider */}
        <div style={{ display: "flex", "align-items": "center", gap: "12px", color: "var(--faint)", "font-size": "12px" }}>
          <span style={{ flex: 1, height: "1px", background: "var(--codeb)" }} />
          扫不了码？手动输入
          <span style={{ flex: 1, height: "1px", background: "var(--codeb)" }} />
        </div>

        {/* Manual inputs */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "14px" }}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <label for="pair-host" style={{ "font-size": "13px", color: "var(--muted)" }}>
              电脑地址
            </label>
            <input
              id="pair-host"
              value={hostInput()}
              onInput={(e) => setHostInput(e.currentTarget.value)}
              placeholder="https://my-laptop.tailnet.ts.net"
              style={{
                height: "48px",
                "box-sizing": "border-box",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                "border-radius": "12px",
                color: "var(--fg)",
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                "font-size": "14px",
                padding: "0 14px",
              }}
            />
          </div>

          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <label for="pair-code" style={{ "font-size": "13px", color: "var(--muted)" }}>
              配对码
            </label>
            <input
              id="pair-code"
              value={codeInput()}
              onInput={(e) => setCodeInput(e.currentTarget.value)}
              placeholder="终端里显示的配对码"
              style={{
                height: "48px",
                "box-sizing": "border-box",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                "border-radius": "12px",
                color: "var(--fg)",
                "font-family": "inherit",
                "font-size": "15px",
                "letter-spacing": "0.08em",
                padding: "0 14px",
              }}
            />
          </div>

          <Show when={errorMessage()}>
            <div style={{ color: "var(--delfg)", "font-size": "13px" }}>{errorMessage()}</div>
          </Show>
        </div>

        <div style={{ flex: 1 }} />

        {/* Action Button */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
          <button
            class="touch-target"
            onClick={handleConnect}
            disabled={connecting()}
            style={{
              width: "100%",
              height: "52px",
              "border-radius": "12px",
              border: 0,
              background: "var(--accent)",
              color: "var(--onaccent)",
              "font-size": "16px",
              "font-weight": 600,
              cursor: connecting() ? "not-allowed" : "pointer",
              opacity: connecting() ? 0.7 : 1,
            }}
          >
            {connecting() ? "连接中..." : "连接"}
          </button>
          <p style={{ margin: 0, "font-size": "12px", "line-height": 1.5, color: "var(--faint)", "text-align": "center" }}>
            配对码只显示在你电脑的终端里，不会经过任何第三方服务器
          </p>
        </div>
      </div>
    </Show>
  );
};
