import { marked } from "marked";
// @ts-ignore - marked-terminal ships its own types but not a package.json export
import { markedTerminal } from "marked-terminal";

let configured = false;
function configure(): void {
  if (configured) return;
  // Renders headings, lists, emphasis, and syntax-highlighted code blocks
  // (via cli-highlight) to ANSI suitable for an Ink <Text>.
  marked.use(markedTerminal() as any);
  configured = true;
}

/** Render markdown to an ANSI string. Falls back to raw text on any error. */
export function renderMarkdown(md: string): string {
  configure();
  try {
    const out = marked.parse(md, { async: false }) as string;
    return out.replace(/\n+$/, "");
  } catch {
    return md;
  }
}
