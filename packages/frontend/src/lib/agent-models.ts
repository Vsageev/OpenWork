export const AGENT_MODEL_PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    description: 'Strong reasoning, safety-focused. Best for complex workflows.',
    modelIds: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    description: 'Code-first agent model. Good for dev-oriented tasks.',
    modelIds: [
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2-codex',
      'gpt-5.2',
      'gpt-5.1-codex-max',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5-codex',
      'gpt-5-codex-mini',
      'gpt-5',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Cursor',
    description: 'Headless Cursor Agent CLI with current server-relevant model IDs.',
    modelIds: [
      'claude-4.6-opus-max-thinking',
      'claude-4.6-opus-high-thinking',
      'claude-4.6-sonnet-medium-thinking',
      'grok-4-20-thinking',
      'grok-4-20',
      'kimi-k2.5',
      'composer-2-fast',
      'composer-2',
      'gpt-5.4-medium',
      'gpt-5.3-codex',
      'gemini-3.1-pro',
      'claude-4-sonnet-thinking',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'Anomaly',
    description: 'Open-source coding agent with provider/model routing.',
    modelIds: [
      'openai/gpt-5.4',
      'openai/gpt-5.4-pro',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.3-codex-spark',
      'openai/gpt-5.2-codex',
      'openai/gpt-5.1-codex-max',
      'openai/gpt-5.1-codex',
      'openai/gpt-5-codex',
      'openai/o4-mini',
      'openai/o3',
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    vendor: 'Alibaba',
    description: 'Open-weight model. Good for self-hosted deployments.',
    modelIds: ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-max-2026-01-23'],
  },
] as const;

export type AgentModelProviderId = (typeof AGENT_MODEL_PROVIDERS)[number]['id'];

export function getAgentModelDefinition(model: string | null | undefined) {
  return AGENT_MODEL_PROVIDERS.find((provider) => provider.id === model);
}

export function getAgentModelDefaultId(model: string | null | undefined): string {
  return getAgentModelDefinition(model)?.modelIds[0] ?? '';
}

export function getAgentModelOptions(
  model: string | null | undefined,
  currentModelId?: string | null,
): string[] {
  const baseOptions: string[] = [...(getAgentModelDefinition(model)?.modelIds ?? [])];
  if (!currentModelId || baseOptions.includes(currentModelId)) {
    return baseOptions;
  }
  return [currentModelId, ...baseOptions];
}
