import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface HeaderProps {
  model: string;
  thread: string;
  context?: string;
  mcp?: string;
}

export function Header({ model, thread, context, mcp }: HeaderProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Text color={theme.accent} bold>
        ◇ iota
      </Text>
      <Text color={theme.dim}>
        {model}  ·  thread:{thread}
      </Text>
      {context ? <Text color={theme.dim}>context: {context}</Text> : null}
      {mcp ? <Text color={theme.dim}>{mcp}</Text> : null}
    </Box>
  );
}
