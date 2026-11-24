/** Pure helpers for rich code blocks in chat (diagrams and sandboxed HTML). */

export type BlockKind = "mermaid" | "html" | null;

/** Which rich renderer, if any, a fenced block's language asks for. */
export function blockKind(className: string | undefined): BlockKind {
  const lang = /(?:^|\s)language-([\w-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
  return lang === "mermaid" ? "mermaid" : lang === "html" ? "html" : null;
}

/**
 * Content-Security-Policy for model-written HTML. Nothing can load or be sent anywhere: no network
 * (fetch, images, fonts, frames, forms all fall back to 'none'), only inline script and style, and
 * data: images. The iframe is also sandboxed without allow-same-origin, so it cannot reach the
 * app, its storage or its token.
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/** The iframe `srcdoc`: the policy comes first so nothing in the model's HTML can precede it. */
export function sandboxedDoc(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,sans-serif;margin:8px}</style>${html}`;
}

/** An SVG as an <img> source: images run no script and fetch nothing, whatever the SVG contains. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}
