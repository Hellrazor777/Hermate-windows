import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model output. react-markdown does not render raw HTML and strips unsafe URL schemes
 * (javascript:, data: ...), so model text cannot inject markup or scripts. Links are shown but not
 * followed: the webview must never navigate away from the app, and opening them in the system
 * browser needs an explicit, separately reviewed opener (tracked as a follow-up).
 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} title={href} rel="noreferrer noopener" onClick={(e) => e.preventDefault()}>
              {children}
            </a>
          ),
          // Images would fetch arbitrary remote URLs (tracking, exfiltration): show the alt text only.
          img: ({ alt }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
