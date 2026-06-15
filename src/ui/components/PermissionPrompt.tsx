import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import type { PermAnswer } from "../../permissions.js";

export function PermissionPrompt({
  summary,
  onAnswer,
}: {
  summary: string;
  onAnswer: (a: PermAnswer) => void;
}) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y") onAnswer("yes");
    else if (c === "a") onAnswer("always");
    else if (c === "n" || key.escape) onAnswer("no");
  });
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
    >
      <Text color={theme.warn} bold>
        permission required
      </Text>
      <Text>{summary}</Text>
      <Text color={theme.dim}>[y]es   [n]o   [a]lways this kind</Text>
    </Box>
  );
}
