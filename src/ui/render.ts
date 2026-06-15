import pc from "picocolors";

const RESULT_PREVIEW_LINES = 8;

export function renderText(delta: string): void {
  process.stdout.write(delta);
}

export function renderToolCall(summary: string): void {
  process.stdout.write(pc.cyan(`\n  ⏺ ${summary}\n`));
}

export function renderToolResult(content: string, isError: boolean): void {
  const lines = content.split("\n");
  const shown = lines.slice(0, RESULT_PREVIEW_LINES);
  const indented = shown.map((l) => `    ${l}`).join("\n");
  const color = isError ? pc.red : pc.dim;
  process.stdout.write(color(indented) + "\n");
  if (lines.length > RESULT_PREVIEW_LINES) {
    process.stdout.write(
      pc.dim(`    … +${lines.length - RESULT_PREVIEW_LINES} more line(s)\n`)
    );
  }
}

export function renderError(msg: string): void {
  process.stdout.write(pc.red(`\n  ✗ ${msg}\n`));
}
