import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";

import type { ReviewConfig } from "../config/types.js";
import { runReviewPipeline, type PipelineEvent } from "../pipeline/orchestrator.js";

import { Header } from "./components/Header.js";
import { PhaseList, type PhaseItem, type PhaseStatus } from "./components/PhaseList.js";
import { ProviderLog, type LogLine } from "./components/ProviderLog.js";

type PhaseId = "planning" | "gathering" | "synthesis" | "output";

const phaseLabels: Record<PhaseId, string> = {
  planning: "Phase 1: Planning",
  gathering: "Phase 2: Data gathering",
  synthesis: "Phase 3: Synthesis",
  output: "Phase 4: Output",
};

interface AppProps {
  config: ReviewConfig;
  dryRun: boolean;
}

function updatePhase(current: PhaseItem[], target: PhaseId, status: PhaseStatus): PhaseItem[] {
  return current.map((phase) => (phase.id === target ? { ...phase, status } : phase));
}

export function App({ config, dryRun }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [phases, setPhases] = useState<PhaseItem[]>([
    { id: "planning", label: phaseLabels.planning, status: "pending" },
    { id: "gathering", label: phaseLabels.gathering, status: "pending" },
    { id: "synthesis", label: phaseLabels.synthesis, status: "pending" },
    { id: "output", label: phaseLabels.output, status: "pending" },
  ]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [resultPath, setResultPath] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const appName = "im-sorry-dave-youre-fired";
  const completed = useMemo(() => phases.every((phase) => phase.status === "success"), [phases]);

  useEffect(() => {
    let isCancelled = false;
    let logId = 0;

    const run = async () => {
      try {
        const onEvent = (event: PipelineEvent) => {
          if (isCancelled) {
            return;
          }

          void process.stderr.write(`[review] [${event.phase}] ${event.message}\n`);

          setPhases((current) => {
            const runningUpdated = updatePhase(current, event.phase, "running");
            return runningUpdated;
          });

          setLogs((current) => {
            if (event.operationId) {
              const existingIndex = current.findIndex((line) => line.id === event.operationId);
              const nextLine: LogLine = {
                id: event.operationId,
                level: event.level,
                message: event.message,
                status: event.operationState === "running" ? "running" : "done",
              };

              if (existingIndex >= 0) {
                const updated = [...current];
                updated[existingIndex] = nextLine;
                return updated;
              }

              return [...current, nextLine];
            }

            return [
              ...current,
              {
                id: `log-${++logId}`,
                level: event.level,
                message: event.message,
                status: "done",
              },
            ];
          });

          if (event.level === "warn" || event.intermediate) {
            return;
          }

          setPhases((current) => updatePhase(current, event.phase, "success"));
        };

        const result = await runReviewPipeline({
          config,
          dryRun,
          onEvent,
        });

        if (isCancelled) {
          return;
        }

        if (dryRun) {
          setResultPath("Dry run completed (no file generated).");
        } else {
          setResultPath(result.outputPath);
        }
      } catch (error) {
        if (isCancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        setPhases((current) => {
          const firstRunning = current.find((phase) => phase.status === "running")?.id as PhaseId | undefined;
          if (!firstRunning) {
            return current;
          }
          return updatePhase(current, firstRunning, "error");
        });
      } finally {
        if (!isCancelled) {
          setTimeout(() => exit(), 100);
        }
      }
    };

    void run();
    return () => {
      isCancelled = true;
    };
  }, [config, dryRun, exit]);

  return (
    <Box flexDirection="column">
      <Header appName={appName} />
      <PhaseList phases={phases} />
      <ProviderLog lines={logs} />
      {completed && resultPath ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="green">Done: {resultPath}</Text>
        </Box>
      ) : null}
      {errorMessage ? (
        <Box marginTop={1}>
          <Text color="red">Error: {errorMessage}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
