import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { Spinner } from "./Spinner.js";
import type { Status } from "../store.js";

export function StatusBar({
  status,
  busy,
  model,
  thread,
  bgRunning,
}: {
  status: Status;
  busy: boolean;
  model: string;
  thread: string;
  bgRunning: number;
}) {
  return (
    <Box marginTop={1}>
      {busy ? <Spinner color={theme.accent} /> : <Text color={theme.success}>●</Text>}
      <Text color={theme.dim}>{` ${busy ? status : "ready"}  ·  ${model}  ·  ${thread}`}</Text>
      {bgRunning > 0 ? (
        <Text color={theme.tool}>{`  ·  ▸ ${bgRunning} bg`}</Text>
      ) : null}
      <Text color={theme.dim}>  ·  /help</Text>
    </Box>
  );
}
