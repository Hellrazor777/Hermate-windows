import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blockKind, sandboxedDoc, SANDBOX_CSP, svgDataUrl } from "./blocks";
import Markdown from "./Markdown";
import { HtmlBlock, SandboxFrame } from "./RichBlock";

describe("blockKind", () => {
  it("picks the renderer from the fence language", () => {
    expect(blockKind("language-mermaid")).toBe("mermaid");
    expect(blockKind("language-HTML")).toBe("html");
    expect(blockKind("language-ts")).toBeNull();
    expect(blockKind(undefined)).toBeNull();
  });
});

describe("sandbox", () => {
  it("puts a policy that blocks all network before the model's HTML", () => {
    const doc = sandboxedDoc("<script>fetch('https://evil.example')</script>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|https?:/);
  });

  it("is a sandboxed frame that cannot reach the app", () => {
    const out = renderToStaticMarkup(createElement(SandboxFrame, { html: "<p>hi</p>" }));
    expect(out).toContain('sandbox="allow-scripts"');
    for (const bad of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) {
      expect(out).not.toContain(bad);
    }
  });

  it("does not run HTML until the user asks", () => {
    const out = renderToStaticMarkup(createElement(HtmlBlock, { source: "<b>x</b>" }));
    expect(out).not.toContain("<iframe");
    expect(out).toContain("Run preview");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("in chat", () => {
  const md = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));
  it("routes html fences to the opt-in block, and leaves other code alone", () => {
    expect(md("```html\n<p>x</p>\n```")).toContain("Run preview");
    expect(md("```ts\nconst a = 1\n```")).not.toContain("Run preview");
    expect(md("```mermaid\ngraph TD; A-->B\n```")).toContain("graph TD");
  });
});

describe("svgDataUrl", () => {
  it("round-trips unicode as an image data URL", () => {
    const url = svgDataUrl("<svg>é✓</svg>");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("<svg>é✓</svg>");
  });
});
