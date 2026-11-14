import { marked } from "marked";
import DOMPurify from "dompurify";

const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';
const MD_CACHE_MAX = 500;
const mdCache = new Map<string, string>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // architecture.md §5: links open outside the PWA so the live session is never navigated away.
    link(token) {
      const html = marked.Renderer.prototype.link.call(this, token);
      return html.replace(/^<a /, `<a ${LINK_ATTRS} `);
    },
    code(token) {
      const html = marked.Renderer.prototype.code.call(this, token);
      const lang = escapeHtml((token.lang || "").trim().split(/\s+/)[0] || "");
      return `<div class="cb"><div class="cb-hdr"><span class="cb-lang">${lang}</span></div>${html}</div>`;
    },
  },
});

if (typeof window !== "undefined") {
  // Raw `<a>` tags in agent output bypass the renderer above; give them the same attributes.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export function renderMarkdown(content: string): string {
  if (!content) return "";
  const cached = mdCache.get(content);
  if (cached !== undefined) {
    mdCache.delete(content);
    mdCache.set(content, cached);
    return cached;
  }
  const rawHtml = marked.parse(content) as string;
  let result: string;
  if (typeof window !== "undefined" && typeof window.document !== "undefined") {
    result = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
      ADD_ATTR: ["target"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  } else {
    // In headless environments without DOMParser, strip script/handlers and disallowed URI schemes (architecture.md §5).
    result = rawHtml
      .replace(/<(script|style|form|textarea|select)[\s\S]*?<\/\1>/gi, "")
      .replace(/<(input|button)\b[^>]*\/?>/gi, "")
      .replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, "")
      .replace(/(href|src)\s*=\s*["']\s*(?!https?:|mailto:|\/|#)([a-z][a-z0-9+.\-]*:)[^"']*["']/gi, "");
  }
  if (mdCache.size >= MD_CACHE_MAX) {
    const oldest = mdCache.keys().next().value;
    if (oldest !== undefined) mdCache.delete(oldest);
  }
  mdCache.set(content, result);
  return result;
}
