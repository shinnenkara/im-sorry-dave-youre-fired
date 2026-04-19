import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export type PhaseStatus = "pending" | "running" | "success" | "error";

export interface PhaseItem {
  id: string;
  label: string;
  status: PhaseStatus;
}

function iconForStatus(status: PhaseStatus): React.JSX.Element {
  if (status === "running") {
    return (
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
    );
  }
  if (status === "success") {
    return <Text color="green">✔</Text>;
  }
  if (status === "error") {
    return <Text color="red">✖</Text>;
  }
  return <Text dimColor>•</Text>;
}

export function PhaseList({ phases }: { phases: readonly PhaseItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {phases.map((phase) => (
        <Box key={phase.id}>
          {iconForStatus(phase.status)}
          <Text> {phase.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
