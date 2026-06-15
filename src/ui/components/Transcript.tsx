import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Spinner } from "./Spinner.js";
import { renderMarkdown } from "../markdown.js";
import type { TranscriptItem, ToolItem } from "../store.js";

const PREVIEW_LINES = 8;

function ResultPreview({ text, error }: { text: string; error: boolean }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, PREVIEW_LINES);
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Text key={i} color={error ? theme.error : theme.dim}>
          {"  │ " + l}
        </Text>
      ))}
      {lines.length > PREVIEW_LINES ? (
        <Text color={theme.dim}>{`  │ … +${lines.length - PREVIEW_LINES} more line(s)`}</Text>
      ) : null}
    </Box>
  );
}

export function ToolCall({ tool }: { tool: ToolItem }) {
  const icon =
    tool.status === "running" ? (
      <Spinner color={theme.tool} />
    ) : tool.status === "done" ? (
      <Text color={theme.success}>✔</Text>
    ) : (
      <Text color={theme.error}>✗</Text>
    );
  const dur =
    tool.durationMs != null
      ? `${(tool.durationMs / 1000).toFixed(1)}s`
      : tool.status === "running"
        ? "running…"
        : "";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {icon}
        <Text color={theme.tool}> {tool.name}</Text>
        <Text color={theme.dim}>{tool.detail ? ` · ${tool.detail}` : ""}</Text>
        {dur ? <Text color={theme.dim}>{"  " + dur}</Text> : null}
      </Box>
      {tool.result && tool.status !== "running" ? (
        <ResultPreview text={tool.result} error={tool.status === "error"} />
      ) : null}
    </Box>
  );
}

function Message({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "user" | "assistant" }>;
}) {
  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text color={theme.user} bold>
          {"› "}
        </Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{renderMarkdown(item.text)}</Text>
    </Box>
  );
}

function SystemOutput({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {item.title ? (
        <Text color={item.tone === "error" ? theme.error : theme.accent} bold>
          {item.title}
        </Text>
      ) : null}
      {item.body.split("\n").map((l, i) => (
        <Text key={i} color={theme.dim}>
          {l}
        </Text>
      ))}
    </Box>
  );
}

export function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
    case "assistant":
      return <Message item={item} />;
    case "tool":
      return <ToolCall tool={item.tool} />;
    case "system":
      return <SystemOutput item={item} />;
  }
}
