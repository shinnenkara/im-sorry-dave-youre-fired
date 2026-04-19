import { z } from "zod";

import type { ReviewConfig } from "../types.js";
import { clickupTasksProviderSchema } from "./clickupTasks.js";
import { githubCodeProviderSchema } from "./githubCode.js";
import { slackCommsProviderSchema } from "./slackComms.js";

type ProviderSlot = "tasks" | "comms" | "code";

interface ProviderSchemaRegistration {
  slot: ProviderSlot;
  type: string;
  schema: z.ZodTypeAny;
}

export const providerSchemaRegistry: ProviderSchemaRegistration[] = [
  {
    slot: "tasks",
    type: "clickup-mcp",
    schema: clickupTasksProviderSchema,
  },
  {
    slot: "comms",
    type: "slack-mcp",
    schema: slackCommsProviderSchema,
  },
  {
    slot: "code",
    type: "github-cli",
    schema: githubCodeProviderSchema,
  },
];

function buildSlotSchema(slot: ProviderSlot): z.ZodTypeAny {
  const slotSchemas = providerSchemaRegistry
    .filter((entry) => entry.slot === slot)
    .map((entry) => entry.schema);

  if (slotSchemas.length === 0) {
    throw new Error(`No provider schemas registered for slot "${slot}"`);
  }
  if (slotSchemas.length === 1) {
    return slotSchemas[0]!;
  }

  const first = slotSchemas[0]!;
  const second = slotSchemas[1]!;
  const rest = slotSchemas.slice(2);
  return z.discriminatedUnion("type", [first, second, ...rest] as [any, any, ...any[]]);
}

export const providersSchema = z
  .object({
    tasks: buildSlotSchema("tasks").optional(),
    comms: buildSlotSchema("comms").optional(),
    code: buildSlotSchema("code").optional(),
  })
  .refine((value) => Boolean(value.tasks || value.comms || value.code), {
    message: "At least one provider must be configured",
  }) as z.ZodType<ReviewConfig["providers"]>;
