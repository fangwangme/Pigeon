import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { draftKey, readPref, showToast, state, writePref } from "../state/store";
import { requestSkills, uploadFile } from "../state/ws";
import type { SkillEntry } from "../../../types/protocol";
import { Icon, Sheet } from "./ui";
import { openImage } from "./overlays";
import { t, type MessageId } from "../i18n";

let textareaEl: HTMLTextAreaElement | undefined;

/** Puts focus in the composer (prompt cards hand the turn back this way, §4.1). */
export function focusComposer(): void {
  setTimeout(() => textareaEl?.focus(), 60);
}

interface Attachment {
  key: number;
  name: string;
  preview?: string;
  id?: string;
}

const SOURCE_LABEL: Record<SkillEntry["source"], MessageId> = { project: "skills.project", user: "skills.user", plugin: "skills.plugin", builtin: "skills.builtin" };

/** `protocol.md` §5.7: a built-in command's description in the current language, else the daemon's English. */
const COMMAND_TEXT: Record<string, MessageId> = {
  compact: "cmd.compact",
  clear: "cmd.clear",
  new: "cmd.new",
  review: "cmd.review",
  init_claude_md: "cmd.init_claude_md",
  init_agents_md: "cmd.init_agents_md",
};

function skillDescription(s: SkillEntry): string {
  const id = s.descriptionId && COMMAND_TEXT[s.descriptionId];
  return id ? t(id) : s.description;
}

function groupOf(e: SkillEntry): "project" | "user" | "plugin" | "command" {
  if (e.source === "builtin") return "command";
  return e.source;
}

const GROUP_LABEL: Record<"project" | "user" | "plugin" | "command", MessageId> = { project: "skills.project", user: "skills.user", plugin: "skills.plugin", command: "skills.command" };
const GROUP_ORDER = ["project", "user", "plugin", "command"] as const;

/** §6.3 */
export function SkillsSheet(props: { onPick: (e: SkillEntry) => void; onClose: () => void }) {
  onMount(() => requestSkills());
  const [seg, setSeg] = createSignal<"all" | (typeof GROUP_ORDER)[number]>("all");
  const present = () => GROUP_ORDER.filter((g) => state.skills.some((s) => groupOf(s) === g));
  return (
    <Sheet title={t("skills.title")} onClose={props.onClose} full>
      <Show when={present().length > 1}>
        <div class="seg" style={{ margin: "2px 0 6px" }}>
          <button class={seg() === "all" ? "on" : ""} onClick={() => setSeg("all")}>
            {t("skills.all")}
          </button>
          <For each={present()}>
            {(g) => (
              <button class={seg() === g ? "on" : ""} onClick={() => setSeg(g)}>
                {t(GROUP_LABEL[g])}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={state.skills.length === 0}>
        <p class="note">{t("skills.none")}</p>
      </Show>
      <For each={present().filter((g) => seg() === "all" || seg() === g)}>
        {(g) => (
          <>
            <div class="sec">{t(GROUP_LABEL[g])}</div>
            <For each={state.skills.filter((s) => groupOf(s) === g)}>
              {(s) => (
                <button class="sk" onClick={() => props.onPick(s)}>
                  <span class="nm mono">{s.invocation}</span>
                  <span class="ds">{skillDescription(s)}</span>
                  <Show when={s.kind === "command" && s.source !== "builtin"}>
                    <span class="src">{t("skills.command")}</span>
                  </Show>
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </Sheet>
  );
}

function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  if (!line.startsWith("/") || /\s/.test(line)) return null;
  return { start: lineStart, query: line.slice(1).toLowerCase() };
}

const isTouch = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export interface ComposerProps {
  draftId: string | null;
  placeholder: string;
  /** Resolves when sent; a rejection keeps the draft (§1.2). queueId is present when updating an in-place queued prompt. */
  onSend: (text: string, attachmentIds: string[], queueId?: string) => Promise<unknown>;
  working?: boolean;
  onStop?: () => void;
  allowAttachments?: boolean;
  onPlus?: () => void;
}

let insertHook: ((text: string) => void) | null = null;
/** Inserts a skill invocation into the visible composer (§6.3). */
export function insertIntoComposer(text: string): void {
  insertHook?.(text);
}

let restoreHook: ((text: string, uploadIds: string[]) => void) | null = null;
/** §3.5 **编辑**: a withdrawn queued prompt's text goes in at the caret and its uploads join the attachments. */
export function restoreIntoComposer(text: string, uploadIds: string[]): void {
  restoreHook?.(text, uploadIds);
}

let editQueueHook: ((queueId: string, text: string, uploadIds: string[]) => void) | null = null;
/** Modifies a queued prompt in-place on the server without changing queue position. */
export function editQueuedPrompt(queueId: string, text: string, uploadIds: string[]): void {
  editQueueHook?.(queueId, text, uploadIds);
}

let cancelEditQueueHook: ((queueId?: string) => void) | null = null;
export function cancelQueuedPromptEdit(queueId?: string): void {
  cancelEditQueueHook?.(queueId);
}

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal(readPref(draftKey(props.draftId)) ?? "");
  const [focused, setFocused] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [atts, setAtts] = createSignal<Attachment[]>([]);
  const [sending, setSending] = createSignal<boolean>(false);
  const [editingQueueId, setEditingQueueId] = createSignal<string | null>(null);
  let savedDraftBeforeEdit: { text: string; atts: Attachment[] } | null = null;
  let keySeq = 0;
  let ta: HTMLTextAreaElement | undefined;

  const save = (v: string) => {
    setText(v);
    writePref(draftKey(props.draftId), v || null);
  };
  const grow = () => {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 280)}px`;
  };

  const insert = (s: string) => {
    const el = ta;
    const v = text();
    const at = el ? el.selectionStart : v.length;
    const sq = slashQuery(v, at);
    const before = sq ? v.slice(0, sq.start) : v.slice(0, at);
    const next = `${before}${s} ${v.slice(at)}`;
    save(next);
    setTimeout(() => {
      if (!el) return;
      el.focus();
      const pos = before.length + s.length + 1;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
      grow();
    }, 20);
  };
  insertHook = insert;
  onCleanup(() => {
    if (insertHook === insert) insertHook = null;
    for (const a of atts()) if (a.preview) URL.revokeObjectURL(a.preview);
  });

  const slash = createMemo(() => (composing() ? null : slashQuery(text(), caret())));
  const slashItems = createMemo(() => {
    const q = slash();
    if (!q) return [];
    return state.skills.filter((s) => s.invocation.toLowerCase().includes(q.query) || s.name.toLowerCase().includes(q.query)).slice(0, 40);
  });

  createEffect(() => {
    if (slash()) requestSkills();
  });

  const addFiles = async (files: FileList | null | File[]) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const key = ++keySeq;
      const preview = f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name || "") ? URL.createObjectURL(f) : undefined;
      setAtts([...atts(), { key, name: f.name || t("plus.photo"), preview }]);
      try {
        const res = await uploadFile(f);
        setAtts(atts().map((a) => (a.key === key ? { ...a, id: res.id, preview: a.preview || `/api/uploads/${res.id}` } : a)));
      } catch (e) {
        setAtts(atts().filter((a) => a.key !== key));
        if (preview) URL.revokeObjectURL(preview);
        showToast((e as Error).message);
      }
    }
  };
  addFilesHook = addFiles;

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (items) {
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
        return;
      }
    }

    const textData = e.clipboardData?.getData("text/plain")?.trim();
    if (textData) {
      const uploadMatch = textData.match(/(?:^|\/)(up_[0-9a-f]{16})(?:-([^\s]+))?(\.(?:png|jpe?g|webp|gif|svg))?$/i);
      if (uploadMatch) {
        const uploadId = uploadMatch[1];
        const rawName = uploadMatch[2] ? `${uploadMatch[2]}${uploadMatch[3] || ""}` : (uploadMatch[3] ? `image${uploadMatch[3]}` : "image.png");
        const fileName = rawName.replace(/^-/, "");
        e.preventDefault();
        const key = ++keySeq;
        setAtts([...atts(), { key, name: fileName, id: uploadId, preview: `/api/uploads/${uploadId}` }]);
        return;
      }
    }
  };

  const restore = (s: string, uploadIds: string[]) => {
    const v = text();
    const at = ta ? ta.selectionStart : v.length;
    const before = v.slice(0, at);
    const gap = before && !before.endsWith("\n") && s ? "\n" : "";
    save(`${before}${gap}${s}${v.slice(at)}`);
    setAtts([...atts(), ...uploadIds.map((id) => ({ key: ++keySeq, name: t("composer.attachment"), id, preview: `/api/uploads/${id}` }))]);
    setTimeout(() => {
      if (!ta) return;
      ta.focus();
      const pos = before.length + gap.length + s.length;
      ta.setSelectionRange(pos, pos);
      setCaret(pos);
      grow();
    }, 20);
  };
  restoreHook = restore;

  const startEditQueue = (queueId: string, s: string, uploadIds: string[]) => {
    savedDraftBeforeEdit = { text: text(), atts: atts() };
    setEditingQueueId(queueId);
    save(s);
    setAtts(uploadIds.map((id) => ({ key: ++keySeq, name: t("composer.attachment"), id, preview: `/api/uploads/${id}` })));
    setTimeout(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(s.length, s.length);
      setCaret(s.length);
      grow();
    }, 20);
  };
  editQueueHook = startEditQueue;

  const cancelEdit = (qId?: string) => {
    if (qId && editingQueueId() !== qId) return;
    setEditingQueueId(null);
    if (!qId) {
      if (savedDraftBeforeEdit) {
        save(savedDraftBeforeEdit.text);
        setAtts(savedDraftBeforeEdit.atts);
      } else {
        save("");
        for (const a of atts()) if (a.preview) URL.revokeObjectURL(a.preview);
        setAtts([]);
      }
    }
    savedDraftBeforeEdit = null;
    setTimeout(grow, 0);
  };
  cancelEditQueueHook = cancelEdit;

  onCleanup(() => {
    if (restoreHook === restore) restoreHook = null;
    if (editQueueHook === startEditQueue) editQueueHook = null;
    if (cancelEditQueueHook === cancelEdit) cancelEditQueueHook = null;
  });

  const uploading = () => atts().some((a) => !a.id);
  const canSend = () => !sending() && !uploading() && (text().trim().length > 0 || atts().length > 0);
  const send = () => {
    if (!canSend()) return;
    const ids = atts().map((a) => a.id!);
    const qId = editingQueueId();
    setSending(true);
    props
      .onSend(text().trim(), ids, qId ?? undefined)
      .then(() => {
        savedDraftBeforeEdit = null;
        setEditingQueueId(null);
        save("");
        for (const a of atts()) if (a.preview) URL.revokeObjectURL(a.preview);
        setAtts([]);
        setTimeout(grow, 0);
      })
      .catch((e) => showToast(e?.message ? t("composer.notSentReason", { reason: e.message }) : t("composer.notSent")))
      .finally(() => setSending(false));
  };

  const open = () => focused() || atts().length > 0 || text().includes("\n") || !!editingQueueId();
  const showStop = () => props.working && !text().trim() && atts().length === 0;

  return (
    <>
      <Show when={slashItems().length}>
        <div class="pop" role="listbox">
          <For each={slashItems()}>
            {(s) => (
              <button
                class="sk"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(s.invocation)}
              >
                <span class="nm mono">{s.invocation}</span>
                <span class="ds">{skillDescription(s)}</span>
                <span class="src">{t(SOURCE_LABEL[s.source])}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class={`comp${open() ? " open" : ""}`}>
        <Show when={editingQueueId()}>
          <div class="qedit-bar">
            <span>{t("session.editingQueued")}</span>
            <button type="button" onClick={() => cancelEdit()}>
              {t("session.cancelEdit")}
            </button>
          </div>
        </Show>
        <Show when={atts().length}>
          <div class="thumbs">
            <For each={atts()}>
              {(a) => {
                const previewUrl = () => a.preview || (a.id ? `/api/uploads/${a.id}` : undefined);
                const isImg = () => Boolean(previewUrl()) || /\.(png|jpe?g|webp|gif|svg)$/i.test(a.name || "");
                return (
                  <div class={`thumb${isImg() ? "" : " file"}`}>
                    <Show when={previewUrl()} fallback={<span>{a.name}</span>}>
                      <img
                        src={previewUrl()!}
                        alt={a.name}
                        onClick={() => previewUrl() && openImage(previewUrl()!, a.name)}
                        style={{ cursor: "pointer" }}
                        onError={(e) => { (e.currentTarget as HTMLElement).style.display = "none"; }}
                      />
                    </Show>
                    <Show when={!a.id}>
                      <span class="spin" style={{ position: "absolute" }} />
                    </Show>
                    <button
                      class="rm"
                      aria-label={t("common.remove")}
                      onClick={() => {
                        if (a.preview && a.preview.startsWith("blob:")) URL.revokeObjectURL(a.preview);
                        setAtts(atts().filter((x) => x.key !== a.key));
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <textarea
          ref={(el) => {
            ta = el;
            textareaEl = el;
            setTimeout(grow, 0);
          }}
          rows={open() ? 2 : 1}
          value={text()}
          placeholder={props.placeholder}
          enterkeyhint={isTouch() ? "enter" : "send"}
          // mobile-ui-and-themes.md §1.2: no password, address or card suggestions above the keyboard.
          autocomplete="off"
          autocorrect="off"
          autocapitalize="sentences"
          spellcheck={false}
          inputmode="text"
          aria-autocomplete="none"
          data-form-type="other"
          onPaste={handlePaste}
          onFocus={() => {
            setFocused(true);
            setTimeout(grow, 0);
          }}
          onBlur={() => setTimeout(() => {
            setFocused(false);
            grow();
          }, 120)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            setCaret(e.currentTarget.selectionStart);
          }}
          onInput={(e) => {
            save(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
            grow();
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            // §1.2: never send while an IME (or dictation) is composing; touch Enter is a newline.
            if (e.key !== "Enter" || e.shiftKey || e.isComposing || composing() || e.keyCode === 229 || isTouch()) return;
            e.preventDefault();
            send();
          }}
        />
        <div class="compbar" style={{ display: open() ? "flex" : "contents" }}>
          <Show when={open()}>
            <Show when={props.onPlus}>
              <button class="rb" aria-label={t("plus.title")} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPlus!()}>
                <Icon name="plus" />
              </button>
            </Show>
            <span class="sp" />
          </Show>
          <Show
            when={showStop()}
            fallback={
              <button class="rb send" aria-label={t("composer.send")} disabled={!canSend()} onMouseDown={(e) => e.preventDefault()} onClick={send}>
                <Show when={!sending()} fallback={<span class="spin" />}>
                  <Icon name="up" />
                </Show>
              </button>
            }
          >
            <button class="rb stop" aria-label={t("composer.stop")} onClick={() => props.onStop?.()}>
              <Icon name="stop" />
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}

let addFilesHook: ((files: FileList | null) => Promise<void>) | null = null;

/** §6.1 + sheet: the system pickers, Skills and resume. A PWA cannot list the photo library, so 照片 is the system picker. */
export function PlusSheet(props: { onClose: () => void; onSkills?: () => void; onResume?: () => void }) {
  const picker = (e: Event & { currentTarget: HTMLInputElement }) => {
    const files = e.currentTarget.files;
    props.onClose();
    void addFilesHook?.(files);
  };
  return (
    <Sheet title={t("plus.title")} onClose={props.onClose}>
      <div class="tile3">
        <label>
          <Icon name="camera" />
          {t("plus.camera")}
          <input type="file" accept="image/*" capture="environment" hidden onChange={picker} />
        </label>
        <label>
          <Icon name="image" />
          {t("plus.photo")}
          <input type="file" accept="image/*" multiple hidden onChange={picker} />
        </label>
        <label>
          <Icon name="upload" />
          {t("plus.file")}
          <input type="file" multiple hidden onChange={picker} />
        </label>
      </div>
      <p class="note">{t("plus.note")}</p>
      <div class="card" style={{ "margin-top": "6px" }}>
        <Show when={props.onSkills}>
          <button class="li" onClick={() => props.onSkills!()}>
            <Icon name="spark" />
            <div class="tx">{t("skills.title")}</div>
            <Icon name="chevR" sm />
          </button>
        </Show>
        <Show when={props.onResume}>
          <button class="li" onClick={() => props.onResume!()}>
            <Icon name="clock" />
            <div class="tx">{t("plus.resume")}</div>
            <Icon name="chevR" sm />
          </button>
        </Show>
      </div>
    </Sheet>
  );
}
