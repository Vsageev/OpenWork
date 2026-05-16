// Shared types and utilities for the card-based system

export type Permission =
  | 'users:read'
  | 'users:create'
  | 'users:update'
  | 'users:delete'
  | 'collections:read'
  | 'collections:create'
  | 'collections:update'
  | 'collections:delete'
  | 'cards:read'
  | 'cards:create'
  | 'cards:update'
  | 'cards:delete'
  | 'boards:read'
  | 'boards:create'
  | 'boards:update'
  | 'boards:delete'
  | 'messages:read'
  | 'messages:send'
  | 'backups:read'
  | 'backups:create'
  | 'backups:delete'
  | 'settings:read'
  | 'settings:update'
  | 'audit-logs:read'
  | 'templates:read'
  | 'templates:create'
  | 'templates:update'
  | 'templates:delete'
  | 'webhooks:read'
  | 'webhooks:create'
  | 'webhooks:update'
  | 'webhooks:delete';

// Auth types
export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: AuthUser;
}

// Re-export utilities
export {
  formatBytes,
  formatDate,
  formatTimeAgo,
  createListResponse,
  safeJsonParse,
  debounce,
} from './utils.js';

export type { ListResponse } from './utils.js';
export {
  CODEX_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
  DEFAULT_AGENT_RUN_ERROR_MESSAGE,
  STREAM_JSON_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
  extractAgentOutputErrorText,
  extractAgentOutputIncompleteText,
  extractFinalResponseText,
  formatAgentOutputForDisplay,
  formatAgentRunErrorMessage,
  parseAgentOutputBlocks,
} from './agent-output.js';
export type {
  OutputBlock,
  OutputBlockType,
  SystemInitBlock,
  ThinkingBlock,
  AssistantTextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ResultBlock,
  RateLimitBlock,
  MessageMetaBlock,
  PlainTextBlock,
} from './agent-output.js';
export {
  RUNNER_PROTOCOL_VERSION,
  parseRunnerJobIntent,
  parseRunnerServerMessage,
  parseServerRunnerMessage,
} from './runner-protocol.js';
export type {
  RunnerAgentKind,
  RunnerApprovalMode,
  RunnerAttachment,
  RunnerAttachmentTextExtraction,
  RunnerAttachmentTextExtractionStatus,
  RunnerAttachmentType,
  RunnerCapabilities,
  RunnerJobIntent,
  RunnerOutputStream,
  RunnerProvider,
  RunnerProtocolVersion,
  RunnerRejectionCode,
  RunnerServerMessage,
  ServerRunnerMessage,
} from './runner-protocol.js';
