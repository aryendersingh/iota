import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

/** Minimal controlled input: typing, backspace, ⏎ to submit. Ctrl-* is left to
 * the global handler in <App>. */
export function Input({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.return) {
      const v = value;
      setValue("");
      onSubmit(v);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box marginTop={1}>
      <Text color={theme.user}>{"› "}</Text>
      <Text>{value}</Text>
      <Text color={theme.dim}>▋</Text>
    </Box>
  );
}
