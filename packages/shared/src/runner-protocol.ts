export const RUNNER_PROTOCOL_VERSION = '1.1';

export type RunnerProtocolVersion = typeof RUNNER_PROTOCOL_VERSION;
export type RunnerAgentKind = 'dev_agent';
export type RunnerProvider = 'claude' | 'codex' | 'qwen' | 'cursor' | 'opencode';
export type RunnerApprovalMode = 'none' | 'on_request' | 'never' | 'dangerous';
export type RunnerOutputStream = 'stdout' | 'stderr';

export type RunnerAttachmentType = 'image' | 'file';
export type RunnerAttachmentTextExtractionStatus =
  | 'available'
  | 'not_applicable'
  | 'failed'
  | 'truncated'
  | 'unknown';

export interface RunnerAttachmentTextExtraction {
  status: RunnerAttachmentTextExtractionStatus;
  textPath?: string;
  charCount?: number;
  truncated?: boolean;
  error?: string;
}

export interface RunnerAttachment {
  type: RunnerAttachmentType;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExtraction: RunnerAttachmentTextExtraction;
  manifest?: Record<string, unknown>;
}

export interface RunnerCapabilities {
  protocolVersion: RunnerProtocolVersion;
  os: string;
  arch: string;
  runnerVersion: string;
  workspaceRoot?: string;
  supportedAgentKinds: RunnerAgentKind[];
  supportedProviders: RunnerProvider[];
  supportsCancellation: boolean;
  supportsArtifacts: boolean;
  policy: {
    workspaceRootRequired: boolean;
    allowedTools: RunnerProvider[];
    approvalModes: RunnerApprovalMode[];
    envAccess: boolean;
    secretAccess: boolean;
    network: boolean;
    shell: boolean;
  };
}

export interface RunnerJobIntent {
  runId: string;
  agentId: string;
  agentKind: RunnerAgentKind;
  provider: RunnerProvider;
  modelPreference: {
    displayName: string;
    modelId?: string | null;
    thinkingLevel?: 'low' | 'medium' | 'high' | null;
  };
  prompt: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  workspace: {
    type: 'local_path';
    path: string;
    workspaceId?: string | null;
  };
  attachments?: RunnerAttachment[];
  allowedOperations: {
    tools: RunnerProvider[];
    approvalMode: RunnerApprovalMode;
    env: boolean;
    secrets: boolean;
    network: boolean;
    shell: boolean;
  };
  environment?: {
    variables: Array<{
      name: string;
      value: string;
      source: 'runtime' | 'workspace_api' | 'agent_env';
      secret: boolean;
    }>;
  };
  timeoutMs?: number;
}

export type RunnerRejectionCode =
  | 'protocol_version_mismatch'
  | 'unsupported_agent_kind'
  | 'unsupported_provider'
  | 'policy_denied'
  | 'invalid_job'
  | 'spawn_failed'
  | 'missing_final_message'
  | 'runner_failed'
  | 'runner_cancelled';

export type ServerRunnerMessage =
  | { type: 'server_hello'; protocolVersion: RunnerProtocolVersion; runnerId: string }
  | {
      type: 'job_offer';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      job: RunnerJobIntent;
    }
  | { type: 'cancel'; protocolVersion: RunnerProtocolVersion; jobId: string; runId: string };

export type RunnerServerMessage =
  | {
      type: 'runner_hello';
      protocolVersion: RunnerProtocolVersion;
      runnerId: string;
      name: string;
      capabilities: RunnerCapabilities;
    }
  | { type: 'job_accepted'; protocolVersion: RunnerProtocolVersion; jobId: string; runId: string }
  | {
      type: 'job_rejected';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId?: string;
      code: RunnerRejectionCode;
      message: string;
    }
  | {
      type: 'output_event';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      stream: RunnerOutputStream;
      text: string;
    }
  | {
      type: 'final_message';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      text: string;
    }
  | {
      type: 'artifact';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      artifact: { name: string; path: string; mimeType?: string };
    }
  | {
      type: 'completed';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      code: number | null;
      stdout: string;
      stderr: string;
    }
  | {
      type: 'failed';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      code: number | null;
      message: string;
      stdout: string;
      stderr: string;
    }
  | {
      type: 'cancelled';
      protocolVersion: RunnerProtocolVersion;
      jobId: string;
      runId: string;
      message?: string;
      stdout: string;
      stderr: string;
    }
  | {
      type: 'protocol_error';
      protocolVersion: RunnerProtocolVersion;
      jobId?: string;
      code: RunnerRejectionCode;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunnerProvider(value: unknown): value is RunnerProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'qwen' ||
    value === 'cursor' ||
    value === 'opencode'
  );
}

function isRunnerProviderArray(value: unknown): value is RunnerProvider[] {
  return Array.isArray(value) && value.every(isRunnerProvider);
}

function isRunnerApprovalMode(value: unknown): value is RunnerApprovalMode {
  return value === 'none' || value === 'on_request' || value === 'never' || value === 'dangerous';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidRunnerAttachmentTextExtraction(
  value: unknown,
): value is RunnerAttachmentTextExtraction {
  if (!isRecord(value)) return false;
  if (
    value.status !== 'available' &&
    value.status !== 'not_applicable' &&
    value.status !== 'failed' &&
    value.status !== 'truncated' &&
    value.status !== 'unknown'
  ) {
    return false;
  }
  return (
    (value.textPath === undefined || typeof value.textPath === 'string') &&
    (value.charCount === undefined || isNonNegativeSafeInteger(value.charCount)) &&
    (value.truncated === undefined || typeof value.truncated === 'boolean') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isValidRunnerAttachment(value: unknown): value is RunnerAttachment {
  if (!isRecord(value)) return false;
  if (
    (value.type !== 'image' && value.type !== 'file') ||
    typeof value.path !== 'string' ||
    typeof value.filename !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !isNonNegativeSafeInteger(value.sizeBytes) ||
    !isValidRunnerAttachmentTextExtraction(value.textExtraction)
  ) {
    return false;
  }
  return value.manifest === undefined || isRecord(value.manifest);
}

function isRunnerAttachmentArray(value: unknown): value is RunnerAttachment[] {
  return Array.isArray(value) && value.every(isValidRunnerAttachment);
}

export function parseRunnerJobIntent(value: unknown): RunnerJobIntent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.runId !== 'string' ||
    typeof value.agentId !== 'string' ||
    value.agentKind !== 'dev_agent' ||
    !isRunnerProvider(value.provider) ||
    typeof value.prompt !== 'string' ||
    !isRecord(value.modelPreference) ||
    typeof value.modelPreference.displayName !== 'string' ||
    !isRecord(value.workspace) ||
    value.workspace.type !== 'local_path' ||
    typeof value.workspace.path !== 'string' ||
    !isRecord(value.allowedOperations) ||
    !isRunnerProviderArray(value.allowedOperations.tools) ||
    !isRunnerApprovalMode(value.allowedOperations.approvalMode) ||
    typeof value.allowedOperations.env !== 'boolean' ||
    typeof value.allowedOperations.secrets !== 'boolean' ||
    typeof value.allowedOperations.network !== 'boolean' ||
    typeof value.allowedOperations.shell !== 'boolean' ||
    (value.attachments !== undefined && !isRunnerAttachmentArray(value.attachments))
  ) {
    return null;
  }
  return value as unknown as RunnerJobIntent;
}

export function parseServerRunnerMessage(value: unknown): ServerRunnerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
    if (value.type === 'job_offer' && typeof value.jobId === 'string') {
      return value as ServerRunnerMessage;
    }
    if (
      value.type === 'cancel' &&
      typeof value.jobId === 'string' &&
      typeof value.runId === 'string'
    ) {
      return value as ServerRunnerMessage;
    }
    return null;
  }
  if (value.type === 'server_hello' && typeof value.runnerId === 'string') {
    return value as ServerRunnerMessage;
  }
  if (
    value.type === 'job_offer' &&
    typeof value.jobId === 'string' &&
    parseRunnerJobIntent(value.job)
  ) {
    return value as ServerRunnerMessage;
  }
  if (
    value.type === 'cancel' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string'
  ) {
    return value as ServerRunnerMessage;
  }
  return null;
}

export function parseRunnerServerMessage(value: unknown): RunnerServerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
    return value.type === 'protocol_error' ? (value as RunnerServerMessage) : null;
  }
  if (
    value.type === 'runner_hello' &&
    typeof value.runnerId === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.capabilities)
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'job_accepted' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'job_rejected' &&
    typeof value.jobId === 'string' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'output_event' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    (value.stream === 'stdout' || value.stream === 'stderr') &&
    typeof value.text === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'final_message' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.text === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'artifact' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    isRecord(value.artifact) &&
    typeof value.artifact.name === 'string' &&
    typeof value.artifact.path === 'string' &&
    (value.artifact.mimeType === undefined || typeof value.artifact.mimeType === 'string')
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'completed' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    (typeof value.code === 'number' || value.code === null) &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'failed' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    (typeof value.code === 'number' || value.code === null) &&
    typeof value.message === 'string' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'cancelled' &&
    typeof value.jobId === 'string' &&
    typeof value.runId === 'string' &&
    (value.message === undefined || typeof value.message === 'string') &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  if (
    value.type === 'protocol_error' &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  ) {
    return value as RunnerServerMessage;
  }
  return null;
}
