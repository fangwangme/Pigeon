import { marked } from "marked";
import DOMPurify from "dompurify";

const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // architecture.md §5: links open outside the PWA so the live session is never navigated away.
    link(token) {
      const html = marked.Renderer.prototype.link.call(this, token);
      return html.replace(/^<a /, `<a ${LINK_ATTRS} `);
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderMarkdown(content: string): string {
  if (!content) return "";
  try {
    const rawHtml = marked.parse(content) as string;
    if (typeof window !== "undefined" && typeof window.document !== "undefined") {
      return DOMPurify.sanitize(rawHtml, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target"],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      });
    }
    // In headless environments without DOMParser, strip script/handlers or escape
    return rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, "")
      .replace(/href\s*=\s*["']\s*javascript:[^"']*["']/gi, "");
  } catch {
    return escapeHtml(content);
  }
}
