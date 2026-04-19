import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface LogLine {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  status?: "running" | "done";
}

function colorForLevel(level: LogLine["level"]): "gray" | "yellow" | "red" {
  if (level === "warn") {
    return "yellow";
  }
  if (level === "error") {
    return "red";
  }
  return "gray";
}

export function ProviderLog({ lines }: { lines: readonly LogLine[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Event log</Text>
      {lines.map((line) => (
        <Box key={line.id}>
          {line.status === "running" ? (
            <Text color={colorForLevel(line.level)}>
              <Spinner type="dots" /> {line.message}
            </Text>
          ) : (
            <Text color={colorForLevel(line.level)}>• {line.message}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
