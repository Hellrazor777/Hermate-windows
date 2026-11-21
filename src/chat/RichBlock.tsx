import { useEffect, useState } from "react";
import { sandboxedDoc, svgDataUrl } from "./blocks";

/** Turns diagram source into SVG text. Injected so tests need no browser. */
export type MermaidRender = (source: string) => Promise<string>;

let mermaidReady: Promise<MermaidRender> | null = null;
let counter = 0;

/** Loads mermaid on first use (it is large) in its strictest mode. */
function realMermaid(): Promise<MermaidRender> {
  mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true });
    return async (source) => {
      const id = `mmd-${++counter}`;
      try {
        return (await mermaid.render(id, source)).svg;
      } finally {
        // A failed render can leave its scratch element (with an error graphic) in the page.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    };
  });
  return mermaidReady;
}

/** Model-written HTML in an isolated frame. Rendered only inside `HtmlBlock`, after the user opts in. */
export function SandboxFrame({ html }: { html: string }) {
  return (
    <iframe
      className="sandbox-frame"
      title="Generated page"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={sandboxedDoc(html)}
    />
  );
}

/** Model-written HTML is never run on sight: the source shows, and the user chooses to run it. */
export function HtmlBlock({ source }: { source: string }) {
  const [running, setRunning] = useState(false);
  return (
    <div className="rich">
      <div className="rich-bar">
        <span className="muted">Generated page (runs isolated: no network, no access to Hermate)</span>
        <button onClick={() => setRunning((r) => !r)}>{running ? "Show code" : "Run preview"}</button>
      </div>
      {running ? (
        <SandboxFrame html={source} />
      ) : (
        <pre>
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}

/** A diagram, drawn as an image. Falls back to the source while it does not parse (e.g. mid-stream). */
export function MermaidBlock({ source, render }: { source: string; render?: MermaidRender }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSvg(null);
    (render ? Promise.resolve(render) : realMermaid())
      .then((r) => r(source))
      .then((out) => current && setSvg(out))
      .catch(() => current && setSvg(null));
    return () => {
      current = false;
    };
  }, [source, render]);
  if (svg === null) {
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <div className="rich">
      <img className="diagram" alt="Diagram" src={svgDataUrl(svg)} />
    </div>
  );
}
