import { Box, Static, Text, useApp, useInput } from "ink";
import { theme } from "./theme.js";
import { useStore, store } from "./store.js";
import { Header, type HeaderProps } from "./components/Header.js";
import { TranscriptRow, ToolCall } from "./components/Transcript.js";
import { Input } from "./components/Input.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { StatusBar } from "./components/StatusBar.js";
import type { Session } from "../session.js";

export function App({
  session,
  header,
}: {
  session: Session;
  header: HeaderProps;
}) {
  const state = useStore();
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (state.busy) session.interrupt();
      else exit();
    }
  });

  const onSubmit = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    const action = await session.submit(t);
    if (action === "quit") exit();
  };

  // Ink's <Static> always renders above the live frame, so the header must live
  // inside Static (as the first item) to pin to the very top of the scrollback.
  const items: Array<{ kind: "header"; id: string } | (typeof state.transcript)[number]> =
    [{ kind: "header", id: "__header" }, ...state.transcript];

  return (
    <Box flexDirection="column">
      {/* Header + finalized history — rendered once, scrolls naturally. */}
      <Static items={items}>
        {(item) =>
          item.kind === "header" ? (
            <Header key={item.id} {...header} />
          ) : (
            <TranscriptRow key={item.id} item={item} />
          )
        }
      </Static>

      {/* Live region for the in-progress turn. */}
      {state.liveText ? (
        <Box marginTop={1}>
          <Text>{state.liveText}</Text>
        </Box>
      ) : null}
      {state.liveTools.map((t) => (
        <ToolCall key={t.id} tool={t} />
      ))}

      {/* One of: permission prompt, working indicator, or input. */}
      {state.pendingPermission ? (
        <PermissionPrompt
          summary={state.pendingPermission.summary}
          onAnswer={(a) =>
            store.resolvePermission(state.pendingPermission!.id, a)
          }
        />
      ) : state.busy ? (
        <Box marginTop={1}>
          <Text color={theme.dim}>working… (Ctrl-C to interrupt)</Text>
        </Box>
      ) : (
        <Input onSubmit={onSubmit} />
      )}

      <StatusBar
        status={state.status}
        busy={state.busy}
        model={state.model}
        thread={state.thread}
        bgRunning={state.shells.filter((s) => s.status === "running").length}
      />
    </Box>
  );
}
