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

export function renderMarkdown(content: string): string {
  if (!content) return "";
  const rawHtml = marked.parse(content) as string;
  if (typeof window !== "undefined" && typeof window.document !== "undefined") {
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  }
  // In headless environments without DOMParser, strip script/handlers and disallowed URI schemes (architecture.md §5).
  return rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*["']\s*(?!https?:|mailto:|\/|#)([a-z][a-z0-9+.\-]*:)[^"']*["']/gi, "");
}
