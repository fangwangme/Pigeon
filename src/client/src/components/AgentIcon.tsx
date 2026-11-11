import type { Component } from "solid-js";
import { Match, Switch } from "solid-js";

export const AgentIcon: Component<{ kind: string; class?: string }> = (props) => {
  return (
    <span class={`ag-badge ${props.kind} ${props.class || ""}`} aria-label={props.kind}>
      <Switch fallback={<span class="ag-txt">{props.kind.slice(0, 2).toUpperCase()}</span>}>
        <Match when={props.kind === "claude"}>
          <svg viewBox="0 0 24 24" fill="currentColor" class="ag-svg">
            <path d="M13.5 3L11 8.5L5.5 11L11 13.5L13.5 19L16 13.5L21.5 11L16 8.5L13.5 3Z" />
          </svg>
        </Match>
        <Match when={props.kind === "codex"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="ag-svg">
            <circle cx="12" cy="12" r="7.5" />
            <path d="M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7L6.7 17.3" />
          </svg>
        </Match>
        <Match when={props.kind === "agy"}>
          <svg viewBox="0 0 24 24" fill="currentColor" class="ag-svg">
            <path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z" />
            <circle cx="18" cy="6" r="2" />
          </svg>
        </Match>
        <Match when={props.kind === "opencode"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="ag-svg">
            <polyline points="7 8 3 12 7 16" />
            <polyline points="17 8 21 12 17 16" />
            <line x1="14" y1="5" x2="10" y2="19" />
          </svg>
        </Match>
        <Match when={props.kind === "pi"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" class="ag-svg">
            <path d="M4 7h16M8 7v11M16 7v10c0 1 1 1 2 1" />
          </svg>
        </Match>
      </Switch>
    </span>
  );
};
