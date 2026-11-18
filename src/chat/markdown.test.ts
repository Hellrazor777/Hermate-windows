import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "./Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown (model output is untrusted)", () => {
  it("renders common markdown and GFM", () => {
    const out = html("# Title\n\n**bold** and `code`\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("<table>");
    expect(out).toContain("<del>gone</del>");
  });

  it("does not render raw HTML", () => {
    const out = html('<script>alert(1)</script><img src=x onerror="alert(1)"><b onclick="x()">hi</b>');
    // Shown as inert, escaped text; no element is created from it.
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b ");
  });

  it("strips javascript: links and never auto-follows links", () => {
    expect(html("[x](javascript:alert(1))")).not.toContain("javascript:");
    const out = html("[docs](https://example.com/a)");
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it("replaces images so no remote URL is fetched", () => {
    const out = html("![tracker](https://evil.example/pixel.png)");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("[image: tracker]");
  });

  it("handles unfinished markdown mid-stream", () => {
    expect(() => html("```ts\nconst a = ")).not.toThrow();
    expect(() => html("**half")).not.toThrow();
  });
});
