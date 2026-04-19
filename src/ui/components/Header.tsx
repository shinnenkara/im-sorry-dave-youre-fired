import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  appName: string;
}

export function Header({ appName }: HeaderProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {appName}
      </Text>
      <Text dimColor>AI-assisted enterprise performance review automation</Text>
    </Box>
  );
}
