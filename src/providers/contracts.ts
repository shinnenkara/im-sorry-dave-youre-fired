import type { ReviewSubjectConfig } from "../config/types.js";

export type EvidenceSource = "tasks" | "comms" | "code";

export interface NormalizedEvidence {
  id: string;
  source: EvidenceSource;
  title: string;
  summary: string;
  citation: string;
  url?: string;
  occurredAt?: string;
  tags?: string[];
}

export interface ProviderQueryRequest {
  subject: ReviewSubjectConfig;
  timeframe: string;
  queries: string[];
}

export interface ITaskProvider {
  readonly name: string;
  getCompletedTasks(request: ProviderQueryRequest): Promise<NormalizedEvidence[]>;
}

export interface ICommProvider {
  readonly name: string;
  getConversations(request: ProviderQueryRequest): Promise<NormalizedEvidence[]>;
}

export interface ICodeProvider {
  readonly name: string;
  getMergedPRs(request: ProviderQueryRequest): Promise<NormalizedEvidence[]>;
  getCodeReviews(request: ProviderQueryRequest): Promise<NormalizedEvidence[]>;
}
