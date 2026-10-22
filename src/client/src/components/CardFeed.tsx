import { Component, For, createSignal, createEffect, onMount } from "solid-js";
import { state } from "../state/store";
import type { Card } from "../../types/protocol";
import { InteractionCard } from "./InteractionCard";

export const CardFeed: Component = () => {
  let feedContainer: HTMLDivElement | undefined;
  const [collapsedCards, setCollapsedCards] = createSignal<Record<string, boolean>>({});

  const toggleCollapse = (id: string) => {
    setCollapsedCards((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const scrollToBottom = () => {
    if (feedContainer) {
      feedContainer.scrollTop = feedContainer.scrollHeight;
    }
  };

  createEffect(() => {
    // When cards change, auto-scroll to bottom
    const _ = state.cards.length;
    setTimeout(scrollToBottom, 50);
  });

  return (
    <main
      ref={feedContainer}
      style={{
        flex: 1,
        "overflow-y": "auto",
        "-webkit-overflow-scrolling": "touch",
        padding: "12px",
        background: "var(--color-bg)",
        display: "flex",
        "flex-direction": "column",
        gap: "10px",
      }}
    >
      <For each={state.cards}>
        {(card) => {
          const isCollapsed = () => !!collapsedCards()[card.id];

          switch (card.kind) {
            case "thought":
              return (
                <div
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    "border-radius": "8px",
                    overflow: "hidden",
                  }}
                >
                  <button
                    class="touch-target"
                    onClick={() => toggleCollapse(card.id)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      background: "transparent",
                      border: "none",
                      color: "var(--color-faint)",
                      "font-size": "13px",
                      "font-weight": "500",
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      cursor: "pointer",
                      "text-align": "left",
                    }}
                  >
                    <span>💭 {card.title || "Thinking"}</span>
                    <span>{isCollapsed() ? "▼" : "▲"}</span>
                  </button>
                  {!isCollapsed() && (
                    <div
                      style={{
                        padding: "8px 12px",
                        "font-size": "13px",
                        color: "var(--color-fg)",
                        "border-top": "1px solid var(--color-border)",
                        "white-space": "pre-wrap",
                      }}
                    >
                      {card.body}
                    </div>
                  )}
                </div>
              );

            case "tool_call":
              return (
                <div
                  style={{
                    background: "var(--color-surface)",
                    border: `1px solid ${
                      card.status === "error" ? "var(--color-danger)" : "var(--color-border)"
                    }`,
                    "border-radius": "8px",
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      "margin-bottom": "6px",
                    }}
                  >
                    <span
                      style={{
                        "font-size": "12px",
                        "font-weight": "700",
                        color: "var(--color-accent)",
                        "text-transform": "uppercase",
                      }}
                    >
                      $ {card.title}
                    </span>
                    <span
                      style={{
                        "font-size": "11px",
                        padding: "2px 6px",
                        "border-radius": "4px",
                        background:
                          card.status === "error"
                            ? "var(--color-danger)"
                            : "var(--color-border)",
                        color: card.status === "error" ? "#fff" : "var(--color-fg)",
                      }}
                    >
                      {card.exitCode !== undefined ? `exit ${card.exitCode}` : card.status}
                    </span>
                  </div>

                  <div
                    style={{
                      "font-family": "monospace",
                      "font-size": "13px",
                      color: "var(--color-fg)",
                      "margin-bottom": card.output ? "6px" : "0",
                      "word-break": "break-all",
                    }}
                  >
                    {card.command}
                  </div>

                  {card.output && (
                    <pre
                      style={{
                        background: "var(--color-bg)",
                        padding: "8px",
                        "border-radius": "4px",
                        "font-size": "12px",
                        "font-family": "monospace",
                        color: "var(--color-faint)",
                        "max-height": "160px",
                        overflow: "y-auto",
                        "white-space": "pre-wrap",
                        "word-break": "break-all",
                      }}
                    >
                      {card.output}
                    </pre>
                  )}
                </div>
              );

            case "diff":
              return (
                <div
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    "border-radius": "8px",
                    overflow: "hidden",
                  }}
                >
                  <button
                    class="touch-target"
                    onClick={() => toggleCollapse(card.id)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      background: "transparent",
                      border: "none",
                      color: "var(--color-fg)",
                      "font-size": "13px",
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      cursor: "pointer",
                      "font-family": "monospace",
                    }}
                  >
                    <span>📄 {card.filePath}</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <span style={{ color: "var(--color-success)" }}>+{card.additions}</span>
                      <span style={{ color: "var(--color-danger)" }}>-{card.deletions}</span>
                      <span>{isCollapsed() ? "▼" : "▲"}</span>
                    </div>
                  </button>
                  {!isCollapsed() && (
                    <pre
                      style={{
                        padding: "8px 12px",
                        "font-size": "12px",
                        "font-family": "monospace",
                        color: "var(--color-fg)",
                        "border-top": "1px solid var(--color-border)",
                        "max-height": "200px",
                        overflow: "y-auto",
                        "white-space": "pre",
                        background: "var(--color-bg)",
                      }}
                    >
                      {card.diff}
                    </pre>
                  )}
                </div>
              );

            case "interaction":
              return <InteractionCard interaction={card} />;

            case "markdown":
            default:
              return (
                <div
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    "border-radius": "8px",
                    padding: "10px 12px",
                    "font-size": "14px",
                    color: "var(--color-fg)",
                    "line-height": "1.5",
                    "white-space": "pre-wrap",
                  }}
                >
                  {(card as any).content || (card as any).text}
                </div>
              );
          }
        }}
      </For>

      {/* If there is a pending interaction not in cards, render it at the bottom */}
      {state.pendingInteraction &&
        !state.cards.some((c) => c.kind === "interaction" && (c as any).interactionId === state.pendingInteraction?.interactionId) && (
          <InteractionCard interaction={state.pendingInteraction} />
        )}
    </main>
  );
};
