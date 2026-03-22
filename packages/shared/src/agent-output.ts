interface JsonRecord {
  [key: string]: unknown;
}

interface StreamBlockState {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: string;
  raw?: JsonRecord | null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function formatCompactJson(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return formatCompactJson(value);
}

function appendLabeledValue(lines: string[], label: string, value: unknown) {
  const formatted = formatScalar(value);
  if (formatted) lines.push(`${label}: ${formatted}`);
}

function extractTextFromContentBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;

    if ((rec.type === 'text' || rec.type === 'output_text') && typeof rec.text === 'string') {
      const text = rec.text.trim();
      if (text) parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join('\n').trim() : null;
}

function extractToolResultContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;

    if (typeof rec.text === 'string' && rec.text.trim()) {
      parts.push(rec.text.trim());
      continue;
    }

    const json = formatCompactJson(block);
    if (json) parts.push(json);
  }

  return parts.length > 0 ? parts.join('\n').trim() : null;
}

function looksLikeStreamJsonEvent(event: JsonRecord): boolean {
  if (typeof event.type !== 'string') return false;
  return [
    'system',
    'assistant',
    'user',
    'result',
    'stream_event',
    'rate_limit_event',
  ].includes(event.type);
}

function getOpenCodePart(event: JsonRecord): JsonRecord | null {
  return asRecord(event.part);
}

function looksLikeOpenCodeEvent(event: JsonRecord): boolean {
  if (typeof event.type !== 'string') return false;

  if (
    [
      'step_start',
      'step_finish',
      'text',
      'reasoning',
      'tool_use',
      'tool_call',
      'tool_result',
    ].includes(event.type)
  ) {
    return true;
  }

  const part = getOpenCodePart(event);
  const partType = typeof part?.type === 'string' ? part.type : '';
  return [
    'step-start',
    'step-finish',
    'text',
    'reasoning',
    'tool',
    'tool-call',
    'tool-result',
  ].includes(partType);
}

function getOpenCodeMessageId(event: JsonRecord): string | null {
  const part = getOpenCodePart(event);
  return typeof part?.messageID === 'string' ? part.messageID : null;
}

function extractFromOpenCodeTextEvent(event: JsonRecord): string | null {
  if (event.type !== 'text') return null;

  const part = getOpenCodePart(event);
  if (!part || typeof part.text !== 'string') return null;

  const text = part.text.trim();
  return text || null;
}

function extractFromOpenCodeReasoningEvent(event: JsonRecord): string | null {
  if (event.type !== 'reasoning') return null;

  const part = getOpenCodePart(event);
  if (!part) return null;

  const directText =
    typeof part.text === 'string'
      ? part.text
      : typeof part.reasoning === 'string'
        ? part.reasoning
        : typeof part.content === 'string'
          ? part.content
          : null;
  if (!directText) return null;

  const text = directText.trim();
  return text || null;
}

function isTopLevelThinkingEvent(event: JsonRecord): boolean {
  return event.type === 'thinking';
}

function extractTopLevelThinkingDelta(event: JsonRecord): string | null {
  if (!isTopLevelThinkingEvent(event) || event.subtype !== 'delta') return null;
  if (typeof event.text !== 'string') return null;
  return event.text;
}

function getOpenCodeToolEventParts(event: JsonRecord): {
  toolName: string;
  toolId?: string;
  input?: string;
  output?: string;
} | null {
  if (!['tool_use', 'tool_call', 'tool_result'].includes(String(event.type))) return null;

  const part = getOpenCodePart(event);
  if (!part) return null;

  const state = asRecord(part.state);
  const toolName =
    typeof part.tool === 'string'
      ? part.tool
      : typeof part.toolName === 'string'
        ? part.toolName
        : null;
  if (!toolName) return null;

  const result: {
    toolName: string;
    toolId?: string;
    input?: string;
    output?: string;
  } = { toolName };

  const toolId =
    typeof part.callID === 'string'
      ? part.callID
      : typeof part.toolCallId === 'string'
        ? part.toolCallId
        : typeof part.id === 'string'
          ? part.id
          : null;
  if (toolId) result.toolId = toolId;

  const input = formatCompactJson(state?.input ?? part.input);
  if (input) result.input = input;

  const output = formatScalar(state?.output ?? part.output);
  if (output) result.output = output;

  return result;
}

function formatOpenCodeUsage(tokens: unknown): string | null {
  const rec = asRecord(tokens);
  if (!rec) return null;

  const parts: string[] = [];
  appendLabeledValue(parts, 'Input', rec.input);
  appendLabeledValue(parts, 'Output', rec.output);
  appendLabeledValue(parts, 'Reasoning', rec.reasoning);

  const cache = asRecord(rec.cache);
  if (cache) {
    appendLabeledValue(parts, 'Cache read', cache.read);
    appendLabeledValue(parts, 'Cache write', cache.write);
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

function parseOpenCodeUsage(tokens: unknown): ResultBlock['usage'] | undefined {
  const rec = asRecord(tokens);
  if (!rec) return undefined;

  const usage: ResultBlock['usage'] = {};
  if (typeof rec.input === 'number') usage.inputTokens = rec.input;
  if (typeof rec.output === 'number') usage.outputTokens = rec.output;

  const cache = asRecord(rec.cache);
  if (cache && typeof cache.read === 'number') usage.cacheRead = cache.read;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function buildOpenCodeStepMeta(
  event: JsonRecord,
  label: 'Step started' | 'Step completed',
): MessageMetaBlock | null {
  const part = getOpenCodePart(event);
  if (!part) return null;

  const details: Record<string, string> = {};
  if (typeof part.messageID === 'string') details['Message'] = part.messageID;
  if (typeof event.sessionID === 'string') details['Session'] = event.sessionID;
  if (typeof part.reason === 'string') details['Stop reason'] = part.reason;
  if (typeof part.cost === 'number') details['Cost'] = String(part.cost);

  const usage = formatOpenCodeUsage(part.tokens);
  if (usage) details['Usage'] = usage;

  return Object.keys(details).length > 0 ? { type: 'message_meta', label, details } : null;
}

function extractOpenCodeFinalText(events: JsonRecord[]): string | null {
  let targetMessageId: string | null = null;
  const parts: string[] = [];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const text = extractFromOpenCodeTextEvent(events[i]);
    if (!text) continue;

    const messageId = getOpenCodeMessageId(events[i]);
    if (!targetMessageId) {
      targetMessageId = messageId;
    }

    if (targetMessageId && messageId && messageId !== targetMessageId) {
      continue;
    }

    parts.unshift(text);
  }

  const deduped = dedupeAdjacentParts(parts);
  return deduped.length > 0 ? deduped.join('\n\n').trim() : null;
}

function extractFromResultEvent(event: JsonRecord): string | null {
  if (event.type !== 'result') return null;

  if (typeof event.result === 'string') {
    const text = event.result.trim();
    return text || null;
  }

  const resultRecord = asRecord(event.result);
  if (!resultRecord) return null;

  const directText =
    typeof resultRecord.text === 'string'
      ? resultRecord.text
      : typeof resultRecord.output_text === 'string'
        ? resultRecord.output_text
        : null;

  if (!directText) return null;
  const text = directText.trim();
  return text || null;
}

function extractFromAssistantEvent(event: JsonRecord): string | null {
  if (event.type === 'assistant') {
    const message = asRecord(event.message);
    const messageText = message ? extractTextFromContentBlocks(message.content) : null;
    if (messageText) return messageText;

    const directText = extractTextFromContentBlocks(event.content);
    if (directText) return directText;
  }

  if (event.role === 'assistant') {
    const directText = extractTextFromContentBlocks(event.content);
    if (directText) return directText;
  }

  return null;
}

function dedupeAdjacentParts(parts: string[]): string[] {
  const deduped: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (deduped[deduped.length - 1]?.trim() === trimmed) continue;
    deduped.push(trimmed);
  }
  return deduped;
}

function appendStreamDelta(existing: string | undefined, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingTrimmed = existing.trim();
  const incomingTrimmed = incoming.trim();
  if (
    (existingTrimmed === '{}' && incomingTrimmed.startsWith('{'))
    || (existingTrimmed === '[]' && incomingTrimmed.startsWith('['))
  ) {
    return incoming;
  }
  if (existing.includes(incoming)) return existing;
  if (incoming.includes(existing)) return incoming;

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.endsWith(incoming.slice(0, overlap))) {
      return `${existing}${incoming.slice(overlap)}`;
    }
  }

  return `${existing}${incoming}`;
}

function extractJsonObjects(output: string): string[] | null {
  const chunks: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < output.length; i += 1) {
    const char = output[i];

    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== '{') return null;
      start = i;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        chunks.push(output.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return start === -1 ? chunks : null;
}

function parseStructuredEvents(output: string): JsonRecord[] | null {
  const rawEvents = extractJsonObjects(output.trim());
  if (!rawEvents || rawEvents.length === 0) return null;

  const parsedEvents: JsonRecord[] = [];
  let structuredEventCount = 0;

  for (const rawEvent of rawEvents) {
    try {
      const parsed = JSON.parse(rawEvent);
      const event = asRecord(parsed);
      if (!event) continue;
      parsedEvents.push(event);
      if (looksLikeStreamJsonEvent(event) || looksLikeOpenCodeEvent(event)) {
        structuredEventCount += 1;
      }
    } catch {
      return null;
    }
  }

  return structuredEventCount > 0 ? parsedEvents : null;
}

function formatUsage(usage: unknown): string | null {
  const rec = asRecord(usage);
  if (!rec) return null;

  const parts: string[] = [];
  appendLabeledValue(parts, 'Input', rec.input_tokens);
  appendLabeledValue(parts, 'Output', rec.output_tokens);
  appendLabeledValue(parts, 'Cache read', rec.cache_read_input_tokens);
  appendLabeledValue(parts, 'Cache create', rec.cache_creation_input_tokens);

  const cacheCreation = asRecord(rec.cache_creation);
  if (cacheCreation) {
    appendLabeledValue(parts, 'Ephemeral 5m cache', cacheCreation.ephemeral_5m_input_tokens);
    appendLabeledValue(parts, 'Ephemeral 1h cache', cacheCreation.ephemeral_1h_input_tokens);
  }

  appendLabeledValue(parts, 'Service tier', rec.service_tier);
  appendLabeledValue(parts, 'Inference geo', rec.inference_geo);

  return parts.length > 0 ? parts.join(', ') : null;
}

function renderContentBlock(block: JsonRecord): string | null {
  const type = typeof block.type === 'string' ? block.type : 'content';

  if (type === 'text' || type === 'output_text') {
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    return text ? `Assistant\n${text}` : null;
  }

  if (type === 'thinking') {
    const thinking = typeof block.thinking === 'string' ? block.thinking.trim() : '';
    return thinking ? `Thinking\n${thinking}` : null;
  }

  if (type === 'tool_use') {
    const lines = [`Tool call: ${typeof block.name === 'string' ? block.name : 'unknown'}`];
    appendLabeledValue(lines, 'ID', block.id);
    const input = formatCompactJson(block.input);
    if (input) lines.push(`Input:\n${input}`);
    return lines.join('\n').trim();
  }

  if (type === 'tool_result') {
    const lines = ['Tool result'];
    appendLabeledValue(lines, 'ID', block.tool_use_id);
    const content = extractToolResultContent(block.content);
    if (content) lines.push(content);
    return lines.join('\n').trim();
  }

  const formatted = formatCompactJson(block);
  return formatted ? `${type}\n${formatted}` : null;
}

function renderAssistantEvent(event: JsonRecord): string | null {
  const sections: string[] = [];

  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(event.content) ? event.content : null;
  if (content) {
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      const rendered = renderContentBlock(rec);
      if (rendered) sections.push(rendered);
    }
  }

  if (sections.length > 0) return sections.join('\n\n').trim();
  return extractFromAssistantEvent(event);
}

function renderSystemInitEvent(event: JsonRecord): string | null {
  if (event.subtype !== 'init') return null;

  const lines = ['Session initialized'];
  appendLabeledValue(lines, 'Model', event.model);
  appendLabeledValue(lines, 'Session', event.session_id);
  appendLabeledValue(lines, 'Cwd', event.cwd);
  appendLabeledValue(lines, 'Permission mode', event.permissionMode);
  appendLabeledValue(lines, 'Version', event.claude_code_version);
  appendLabeledValue(lines, 'Output style', event.output_style);

  if (Array.isArray(event.tools) && event.tools.length > 0) {
    lines.push(`Tools: ${event.tools.map((tool) => String(tool)).join(', ')}`);
  }

  if (Array.isArray(event.mcp_servers) && event.mcp_servers.length > 0) {
    const servers = event.mcp_servers
      .map((server) => {
        const rec = asRecord(server);
        if (!rec) return null;
        const name = typeof rec.name === 'string' ? rec.name : 'unknown';
        const status = typeof rec.status === 'string' ? ` (${rec.status})` : '';
        return `${name}${status}`;
      })
      .filter((value): value is string => Boolean(value));
    if (servers.length > 0) lines.push(`MCP servers: ${servers.join(', ')}`);
  }

  if (Array.isArray(event.agents) && event.agents.length > 0) {
    lines.push(`Agents: ${event.agents.map((agent) => String(agent)).join(', ')}`);
  }

  if (Array.isArray(event.skills) && event.skills.length > 0) {
    lines.push(`Skills: ${event.skills.map((skill) => String(skill)).join(', ')}`);
  }

  if (Array.isArray(event.plugins) && event.plugins.length > 0) {
    const plugins = event.plugins
      .map((plugin) => {
        const rec = asRecord(plugin);
        if (!rec) return null;
        return typeof rec.name === 'string' ? rec.name : null;
      })
      .filter((value): value is string => Boolean(value));
    if (plugins.length > 0) lines.push(`Plugins: ${plugins.join(', ')}`);
  }

  return lines.join('\n').trim();
}

function renderResultEvent(event: JsonRecord): string | null {
  const lines: string[] = [];
  const resultText = extractFromResultEvent(event);
  if (resultText) lines.push(`Result\n${resultText}`);

  appendLabeledValue(lines, 'Duration ms', event.duration_ms);
  const usage = formatUsage(event.usage);
  if (usage) lines.push(`Usage: ${usage}`);
  appendLabeledValue(lines, 'Stop reason', event.stop_reason);
  appendLabeledValue(lines, 'Subtype', event.subtype);
  appendLabeledValue(lines, 'Is error', event.is_error);

  return lines.length > 0 ? lines.join('\n') : null;
}

function renderRateLimitEvent(event: JsonRecord): string | null {
  const lines = ['Rate limit'];
  appendLabeledValue(lines, 'Message', event.message);
  appendLabeledValue(lines, 'Retry after', event.retry_after);
  return lines.length > 1 ? lines.join('\n') : null;
}

function renderOpenCodeToolEvent(event: JsonRecord): string | null {
  const tool = getOpenCodeToolEventParts(event);
  if (!tool) return null;

  const sections: string[] = [];
  const callLines = [`Tool call: ${tool.toolName}`];
  appendLabeledValue(callLines, 'ID', tool.toolId);
  if (tool.input) callLines.push(`Input:\n${tool.input}`);
  sections.push(callLines.join('\n').trim());

  if (tool.output) {
    const resultLines = ['Tool result'];
    appendLabeledValue(resultLines, 'ID', tool.toolId);
    resultLines.push(tool.output);
    sections.push(resultLines.join('\n').trim());
  }

  return sections.join('\n\n').trim();
}

function renderOpenCodeStepFinishEvent(event: JsonRecord): string | null {
  if (event.type !== 'step_finish') return null;

  const part = getOpenCodePart(event);
  if (!part) return null;

  const lines = ['Step finished'];
  appendLabeledValue(lines, 'Reason', part.reason);
  appendLabeledValue(lines, 'Cost', part.cost);
  const usage = formatOpenCodeUsage(part.tokens);
  if (usage) lines.push(`Usage: ${usage}`);
  return lines.length > 1 ? lines.join('\n') : null;
}

function createStreamBlock(contentBlock: JsonRecord): StreamBlockState {
  const type = typeof contentBlock.type === 'string' ? contentBlock.type : 'content';
  const block: StreamBlockState = { type, raw: contentBlock };

  if (type === 'thinking' && typeof contentBlock.thinking === 'string') {
    block.thinking = contentBlock.thinking;
  }

  if ((type === 'text' || type === 'output_text') && typeof contentBlock.text === 'string') {
    block.text = contentBlock.text;
  }

  if (type === 'tool_use') {
    if (typeof contentBlock.name === 'string') block.name = contentBlock.name;
    if (typeof contentBlock.id === 'string') block.id = contentBlock.id;
    const input = formatCompactJson(contentBlock.input);
    if (input) block.input = input;
  }

  if (type === 'tool_result') {
    const content = extractToolResultContent(contentBlock.content);
    if (content) block.text = content;
    if (typeof contentBlock.tool_use_id === 'string') block.id = contentBlock.tool_use_id;
  }

  return block;
}

function renderStreamBlock(block: StreamBlockState): string | null {
  if (block.type === 'thinking') {
    const thinking = block.thinking?.trim();
    return thinking ? `Thinking\n${thinking}` : null;
  }

  if (block.type === 'text' || block.type === 'output_text') {
    const text = block.text?.trim();
    return text ? `Assistant\n${text}` : null;
  }

  if (block.type === 'tool_use') {
    const lines = [`Tool call: ${block.name || 'unknown'}`];
    appendLabeledValue(lines, 'ID', block.id);
    const input = block.input?.trim();
    if (input) lines.push(`Input:\n${input}`);
    return lines.join('\n').trim();
  }

  if (block.type === 'tool_result') {
    const lines = ['Tool result'];
    appendLabeledValue(lines, 'ID', block.id);
    const text = block.text?.trim();
    if (text) lines.push(text);
    return lines.join('\n').trim();
  }

  const raw = formatCompactJson(block.raw);
  return raw ? `${block.type}\n${raw}` : null;
}

function formatPartialStreamContent(events: JsonRecord[]): string {
  const streamBlocks = new Map<number, StreamBlockState>();

  for (const event of events) {
    if (event.type !== 'stream_event') continue;

    const inner = asRecord(event.event);
    if (!inner || typeof inner.type !== 'string') continue;

    if (inner.type === 'content_block_start') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      const contentBlock = asRecord(inner.content_block);
      if (contentBlock) streamBlocks.set(index, createStreamBlock(contentBlock));
      continue;
    }

    if (inner.type !== 'content_block_delta') continue;

    const index = typeof inner.index === 'number' ? inner.index : 0;
    const delta = asRecord(inner.delta);
    if (!delta || typeof delta.type !== 'string') continue;
    const block = streamBlocks.get(index) || { type: 'content', raw: null };

    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      block.type = 'thinking';
      block.thinking = appendStreamDelta(block.thinking, delta.thinking);
    } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.type = 'text';
      block.text = appendStreamDelta(block.text, delta.text);
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.type = 'tool_use';
      block.input = appendStreamDelta(block.input, delta.partial_json);
    }

    streamBlocks.set(index, block);
  }

  const parts: string[] = [];

  const thinking = [...streamBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block.thinking?.trim() || '')
    .filter(Boolean)
    .join('\n\n');
  if (thinking) parts.push(`Thinking\n${thinking}`);

  const text = [...streamBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block.text || '')
    .join('')
    .trim();
  if (text) parts.push(`Assistant\n${text}`);

  return parts.join('\n\n').trim();
}

function formatStructuredEventsForDisplay(events: JsonRecord[]): string {
  const parts: string[] = [];
  const streamBlocks = new Map<number, StreamBlockState>();
  let currentMessageBlocks: OutputBlock[] = [];
  let topLevelThinking = '';

  const flushBlock = (index: number) => {
    const block = streamBlocks.get(index);
    if (!block) return;
    const rendered = renderStreamBlock(block);
    if (rendered) parts.push(rendered);
    const output = buildStreamBlockOutput(block);
    if (output) currentMessageBlocks.push(output);
    streamBlocks.delete(index);
  };

  const flushTopLevelThinking = () => {
    const thinking = topLevelThinking.trim();
    if (thinking) parts.push(`Thinking\n${thinking}`);
    topLevelThinking = '';
  };

  for (const event of events) {
    const thinkingDelta = extractTopLevelThinkingDelta(event);
    if (thinkingDelta !== null) {
      topLevelThinking = appendStreamDelta(topLevelThinking, thinkingDelta);
      continue;
    }

    if (isTopLevelThinkingEvent(event)) {
      flushTopLevelThinking();
      continue;
    }

    flushTopLevelThinking();

    if (event.type === 'system') {
      const rendered = renderSystemInitEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type === 'assistant' || event.role === 'assistant') {
      const assistantBlocks = getAssistantEventBlocks(event);
      const streamedBlocks = [...currentMessageBlocks, ...getActiveStreamOutputs(streamBlocks)];
      if (assistantBlocks.length > 0 && outputBlocksMatch(streamedBlocks, assistantBlocks)) {
        continue;
      }
      const rendered = renderAssistantEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type === 'result') {
      const rendered = renderResultEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type === 'rate_limit_event') {
      const rendered = renderRateLimitEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type === 'reasoning') {
      const reasoning = extractFromOpenCodeReasoningEvent(event);
      if (reasoning) parts.push(`Thinking\n${reasoning}`);
      continue;
    }

    if (event.type === 'text') {
      const text = extractFromOpenCodeTextEvent(event);
      if (text) parts.push(`Assistant\n${text}`);
      continue;
    }

    if (['tool_use', 'tool_call', 'tool_result'].includes(String(event.type))) {
      const rendered = renderOpenCodeToolEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type === 'step_finish') {
      const rendered = renderOpenCodeStepFinishEvent(event);
      if (rendered) parts.push(rendered);
      continue;
    }

    if (event.type !== 'stream_event') continue;

    const inner = asRecord(event.event);
    if (!inner || typeof inner.type !== 'string') continue;

    if (inner.type === 'message_start') {
      currentMessageBlocks = [];
      const message = asRecord(inner.message);
      if (!message) continue;

      const lines = ['Assistant message started'];
      appendLabeledValue(lines, 'Model', message.model);
      appendLabeledValue(lines, 'Message ID', message.id);
      appendLabeledValue(lines, 'Role', message.role);
      const usage = formatUsage(message.usage);
      if (usage) lines.push(`Usage: ${usage}`);
      parts.push(lines.join('\n'));
      continue;
    }

    if (inner.type === 'content_block_start') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      const contentBlock = asRecord(inner.content_block);
      if (!contentBlock) continue;
      streamBlocks.set(index, createStreamBlock(contentBlock));
      continue;
    }

    if (inner.type === 'content_block_delta') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      const delta = asRecord(inner.delta);
      if (!delta || typeof delta.type !== 'string') continue;
      const block = streamBlocks.get(index) || { type: 'content', raw: null };

      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.type = 'thinking';
        block.thinking = appendStreamDelta(block.thinking, delta.thinking);
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.type = 'text';
        block.text = appendStreamDelta(block.text, delta.text);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.type = 'tool_use';
        block.input = appendStreamDelta(block.input, delta.partial_json);
      }

      streamBlocks.set(index, block);
      continue;
    }

    if (inner.type === 'content_block_stop') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      flushBlock(index);
      continue;
    }

    if (inner.type === 'message_delta') {
      const delta = asRecord(inner.delta);
      const usage = formatUsage(inner.usage);
      const lines: string[] = [];
      if (delta) {
        appendLabeledValue(lines, 'Stop reason', delta.stop_reason);
        appendLabeledValue(lines, 'Stop sequence', delta.stop_sequence);
      }
      if (usage) lines.push(`Usage: ${usage}`);
      if (lines.length > 0) parts.push(lines.join('\n'));
      continue;
    }
  }

  const remaining = [...streamBlocks.keys()].sort((a, b) => a - b);
  for (const index of remaining) {
    flushBlock(index);
  }
  flushTopLevelThinking();

  return dedupeAdjacentParts(parts).join('\n\n').trim();
}

// ── Structured block types for rich UI rendering ──

export type OutputBlockType =
  | 'system_init'
  | 'thinking'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'rate_limit'
  | 'message_meta'
  | 'plain_text';

export interface OutputBlockBase {
  type: OutputBlockType;
}

export interface SystemInitBlock extends OutputBlockBase {
  type: 'system_init';
  model?: string;
  sessionId?: string;
  cwd?: string;
  permissionMode?: string;
  version?: string;
  tools?: string[];
  mcpServers?: { name: string; status?: string }[];
  agents?: string[];
}

export interface ThinkingBlock extends OutputBlockBase {
  type: 'thinking';
  content: string;
}

export interface AssistantTextBlock extends OutputBlockBase {
  type: 'assistant_text';
  content: string;
}

export interface ToolCallBlock extends OutputBlockBase {
  type: 'tool_call';
  toolName: string;
  toolId?: string;
  input?: string;
}

export interface ToolResultBlock extends OutputBlockBase {
  type: 'tool_result';
  toolId?: string;
  content: string;
}

export interface ResultBlock extends OutputBlockBase {
  type: 'result';
  text?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheCreate?: number;
  };
  stopReason?: string;
  isError?: boolean;
}

export interface RateLimitBlock extends OutputBlockBase {
  type: 'rate_limit';
  message?: string;
  retryAfter?: string;
}

export interface MessageMetaBlock extends OutputBlockBase {
  type: 'message_meta';
  label: string;
  details: Record<string, string>;
}

export interface PlainTextBlock extends OutputBlockBase {
  type: 'plain_text';
  content: string;
}

export type OutputBlock =
  | SystemInitBlock
  | ThinkingBlock
  | AssistantTextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ResultBlock
  | RateLimitBlock
  | MessageMetaBlock
  | PlainTextBlock;

function outputBlocksMatch(left: OutputBlock[], right: OutputBlock[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) => outputBlocksEqual(block, right[index]));
}

function outputBlocksEqual(left: OutputBlock, right: OutputBlock): boolean {
  if (left.type !== right.type) return false;

  switch (left.type) {
    case 'thinking':
    case 'assistant_text':
    case 'plain_text':
      return left.content.trim() === (right as ThinkingBlock | AssistantTextBlock | PlainTextBlock).content.trim();
    case 'tool_call':
      return (
        left.toolName === (right as ToolCallBlock).toolName
        && (left.toolId || '') === ((right as ToolCallBlock).toolId || '')
        && (left.input || '').trim() === (((right as ToolCallBlock).input || '').trim())
      );
    case 'tool_result':
      return (
        (left.toolId || '') === ((right as ToolResultBlock).toolId || '')
        && left.content.trim() === (right as ToolResultBlock).content.trim()
      );
    case 'result':
      return (
        (left.text || '').trim() === (((right as ResultBlock).text || '').trim())
        && left.durationMs === (right as ResultBlock).durationMs
        && left.stopReason === (right as ResultBlock).stopReason
        && left.isError === (right as ResultBlock).isError
      );
    case 'message_meta':
      return (
        left.label === (right as MessageMetaBlock).label
        && JSON.stringify(left.details) === JSON.stringify((right as MessageMetaBlock).details)
      );
    case 'system_init':
      return JSON.stringify(left) === JSON.stringify(right);
    case 'rate_limit':
      return (
        (left.message || '') === ((right as RateLimitBlock).message || '')
        && (left.retryAfter || '') === ((right as RateLimitBlock).retryAfter || '')
      );
    default:
      return false;
  }
}

function buildSystemInitBlock(event: JsonRecord): SystemInitBlock {
  const block: SystemInitBlock = { type: 'system_init' };
  if (typeof event.model === 'string') block.model = event.model;
  if (typeof event.session_id === 'string') block.sessionId = event.session_id;
  if (typeof event.cwd === 'string') block.cwd = event.cwd;
  if (typeof event.permissionMode === 'string') block.permissionMode = event.permissionMode;
  if (typeof event.claude_code_version === 'string') block.version = event.claude_code_version;
  if (Array.isArray(event.tools) && event.tools.length > 0) {
    block.tools = event.tools.map((t) => String(t));
  }
  if (Array.isArray(event.mcp_servers) && event.mcp_servers.length > 0) {
    block.mcpServers = event.mcp_servers
      .map((s) => {
        const rec = asRecord(s);
        if (!rec) return null;
        const entry: { name: string; status?: string } = {
          name: typeof rec.name === 'string' ? rec.name : 'unknown',
        };
        if (typeof rec.status === 'string') entry.status = rec.status;
        return entry;
      })
      .filter((v): v is { name: string; status?: string } => v !== null);
  }
  if (Array.isArray(event.agents) && event.agents.length > 0) {
    block.agents = event.agents.map((a) => String(a));
  }
  return block;
}

function buildContentBlocks(content: unknown[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    const type = typeof rec.type === 'string' ? rec.type : '';

    if (type === 'thinking') {
      const thinking = typeof rec.thinking === 'string' ? rec.thinking.trim() : '';
      if (thinking) blocks.push({ type: 'thinking', content: thinking });
    } else if (type === 'text' || type === 'output_text') {
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      if (text) blocks.push({ type: 'assistant_text', content: text });
    } else if (type === 'tool_use') {
      const b: ToolCallBlock = {
        type: 'tool_call',
        toolName: typeof rec.name === 'string' ? rec.name : 'unknown',
      };
      if (typeof rec.id === 'string') b.toolId = rec.id;
      const input = formatCompactJson(rec.input);
      if (input) b.input = input;
      blocks.push(b);
    } else if (type === 'tool_result') {
      const content2 = extractToolResultContent(rec.content);
      blocks.push({
        type: 'tool_result',
        toolId: typeof rec.tool_use_id === 'string' ? rec.tool_use_id : undefined,
        content: content2 || '',
      });
    }
  }
  return blocks;
}

function buildStreamBlockOutput(block: StreamBlockState): OutputBlock | null {
  if (block.type === 'thinking') {
    const thinking = block.thinking?.trim();
    return thinking ? { type: 'thinking', content: thinking } : null;
  }
  if (block.type === 'text' || block.type === 'output_text') {
    const text = block.text?.trim();
    return text ? { type: 'assistant_text', content: text } : null;
  }
  if (block.type === 'tool_use') {
    const b: ToolCallBlock = {
      type: 'tool_call',
      toolName: block.name || 'unknown',
    };
    if (block.id) b.toolId = block.id;
    const input = block.input?.trim();
    if (input) {
      try {
        b.input = JSON.stringify(JSON.parse(input), null, 2);
      } catch {
        b.input = input;
      }
    }
    return b;
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolId: block.id,
      content: block.text?.trim() || '',
    };
  }
  return null;
}

function getActiveStreamOutputs(streamBlocks: Map<number, StreamBlockState>): OutputBlock[] {
  return [...streamBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => buildStreamBlockOutput(block))
    .filter((block): block is OutputBlock => block !== null);
}

function getAssistantEventBlocks(event: JsonRecord): OutputBlock[] {
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(event.content)
      ? event.content
      : null;

  if (content) return buildContentBlocks(content);

  const text = extractFromAssistantEvent(event);
  return text ? [{ type: 'assistant_text', content: text }] : [];
}

function parseUsageRecord(usage: unknown): ResultBlock['usage'] | undefined {
  const rec = asRecord(usage);
  if (!rec) return undefined;
  const u: ResultBlock['usage'] = {};
  if (typeof rec.input_tokens === 'number') u.inputTokens = rec.input_tokens;
  else if (typeof rec.inputTokens === 'number') u.inputTokens = rec.inputTokens;
  if (typeof rec.output_tokens === 'number') u.outputTokens = rec.output_tokens;
  else if (typeof rec.outputTokens === 'number') u.outputTokens = rec.outputTokens;
  if (typeof rec.cache_read_input_tokens === 'number') u.cacheRead = rec.cache_read_input_tokens;
  else if (typeof rec.cacheReadTokens === 'number') u.cacheRead = rec.cacheReadTokens;
  if (typeof rec.cache_creation_input_tokens === 'number') u.cacheCreate = rec.cache_creation_input_tokens;
  else if (typeof rec.cacheWriteTokens === 'number') u.cacheCreate = rec.cacheWriteTokens;
  return Object.keys(u).length > 0 ? u : undefined;
}

function buildOpenCodeToolBlocks(event: JsonRecord): OutputBlock[] {
  const tool = getOpenCodeToolEventParts(event);
  if (!tool) return [];

  const blocks: OutputBlock[] = [
    {
      type: 'tool_call',
      toolName: tool.toolName,
      toolId: tool.toolId,
      input: tool.input,
    },
  ];

  if (tool.output) {
    blocks.push({
      type: 'tool_result',
      toolId: tool.toolId,
      content: tool.output,
    });
  }

  return blocks;
}

function structuredEventsToBlocks(events: JsonRecord[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const streamBlocks = new Map<number, StreamBlockState>();
  let currentMessageBlocks: OutputBlock[] = [];
  let topLevelThinking = '';

  const flushBlock = (index: number) => {
    const sb = streamBlocks.get(index);
    if (!sb) return;
    const ob = buildStreamBlockOutput(sb);
    if (ob) {
      blocks.push(ob);
      currentMessageBlocks.push(ob);
    }
    streamBlocks.delete(index);
  };

  const flushTopLevelThinking = () => {
    const thinking = topLevelThinking.trim();
    if (thinking) blocks.push({ type: 'thinking', content: thinking });
    topLevelThinking = '';
  };

  for (const event of events) {
    const thinkingDelta = extractTopLevelThinkingDelta(event);
    if (thinkingDelta !== null) {
      topLevelThinking = appendStreamDelta(topLevelThinking, thinkingDelta);
      continue;
    }

    if (isTopLevelThinkingEvent(event)) {
      flushTopLevelThinking();
      continue;
    }

    flushTopLevelThinking();

    if (event.type === 'system') {
      if (event.subtype === 'init') blocks.push(buildSystemInitBlock(event));
      continue;
    }

    if (event.type === 'assistant' || event.role === 'assistant') {
      const assistantBlocks = getAssistantEventBlocks(event);
      const streamedBlocks = [...currentMessageBlocks, ...getActiveStreamOutputs(streamBlocks)];
      if (assistantBlocks.length > 0 && outputBlocksMatch(streamedBlocks, assistantBlocks)) {
        continue;
      }
      if (assistantBlocks.length > 0) blocks.push(...assistantBlocks);
      continue;
    }

    if (event.type === 'result') {
      const rb: ResultBlock = { type: 'result' };
      const text = extractFromResultEvent(event);
      if (text) {
        // Skip result text if it duplicates the last assistant text block
        const lastAssistant = [...blocks].reverse().find((b) => b.type === 'assistant_text');
        if (!lastAssistant || (lastAssistant as AssistantTextBlock).content.trim() !== text.trim()) {
          rb.text = text;
        }
      }
      if (typeof event.duration_ms === 'number') rb.durationMs = event.duration_ms;
      rb.usage = parseUsageRecord(event.usage);
      if (typeof event.stop_reason === 'string') rb.stopReason = event.stop_reason;
      if (typeof event.is_error === 'boolean') rb.isError = event.is_error;
      blocks.push(rb);
      continue;
    }

    if (event.type === 'rate_limit_event') {
      const rl: RateLimitBlock = { type: 'rate_limit' };
      if (typeof event.message === 'string') rl.message = event.message;
      if (typeof event.retry_after === 'string') rl.retryAfter = event.retry_after;
      blocks.push(rl);
      continue;
    }

    if (event.type === 'step_start') {
      const meta = buildOpenCodeStepMeta(event, 'Step started');
      if (meta) blocks.push(meta);
      continue;
    }

    if (event.type === 'reasoning') {
      const thinking = extractFromOpenCodeReasoningEvent(event);
      if (thinking) blocks.push({ type: 'thinking', content: thinking });
      continue;
    }

    if (event.type === 'text') {
      const text = extractFromOpenCodeTextEvent(event);
      if (text) blocks.push({ type: 'assistant_text', content: text });
      continue;
    }

    if (['tool_use', 'tool_call', 'tool_result'].includes(String(event.type))) {
      const toolBlocks = buildOpenCodeToolBlocks(event);
      if (toolBlocks.length > 0) blocks.push(...toolBlocks);
      continue;
    }

    if (event.type === 'step_finish') {
      const part = getOpenCodePart(event);
      const usage = parseOpenCodeUsage(part?.tokens);
      const reason = typeof part?.reason === 'string' ? part.reason : undefined;

      if (usage || reason) {
        blocks.push({
          type: 'result',
          usage,
          stopReason: reason,
        });
      }

      const meta = buildOpenCodeStepMeta(event, 'Step completed');
      if (meta) blocks.push(meta);
      continue;
    }

    if (event.type !== 'stream_event') continue;

    const inner = asRecord(event.event);
    if (!inner || typeof inner.type !== 'string') continue;

    if (inner.type === 'message_start') {
      currentMessageBlocks = [];
      const message = asRecord(inner.message);
      if (message) {
        const details: Record<string, string> = {};
        if (typeof message.model === 'string') details['Model'] = message.model;
        if (typeof message.id === 'string') details['ID'] = message.id;
        const usage = parseUsageRecord(message.usage);
        if (usage?.inputTokens) details['Input tokens'] = String(usage.inputTokens);
        blocks.push({ type: 'message_meta', label: 'Message started', details });
      }
      continue;
    }

    if (inner.type === 'content_block_start') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      const contentBlock = asRecord(inner.content_block);
      if (contentBlock) streamBlocks.set(index, createStreamBlock(contentBlock));
      continue;
    }

    if (inner.type === 'content_block_delta') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      const delta = asRecord(inner.delta);
      if (!delta || typeof delta.type !== 'string') continue;
      const block = streamBlocks.get(index) || { type: 'content', raw: null };

      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.type = 'thinking';
        block.thinking = appendStreamDelta(block.thinking, delta.thinking);
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.type = 'text';
        block.text = appendStreamDelta(block.text, delta.text);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.type = 'tool_use';
        block.input = appendStreamDelta(block.input, delta.partial_json);
      }

      streamBlocks.set(index, block);
      continue;
    }

    if (inner.type === 'content_block_stop') {
      const index = typeof inner.index === 'number' ? inner.index : 0;
      flushBlock(index);
      continue;
    }

    if (inner.type === 'message_delta') {
      const delta = asRecord(inner.delta);
      const usage = parseUsageRecord(inner.usage);
      const details: Record<string, string> = {};
      if (delta && typeof delta.stop_reason === 'string') details['Stop reason'] = delta.stop_reason;
      if (usage?.outputTokens) details['Output tokens'] = String(usage.outputTokens);
      if (Object.keys(details).length > 0) {
        blocks.push({ type: 'message_meta', label: 'Message completed', details });
      }
      continue;
    }
  }

  const remaining = [...streamBlocks.keys()].sort((a, b) => a - b);
  for (const index of remaining) flushBlock(index);
  flushTopLevelThinking();

  return blocks;
}

/**
 * Parses agent stdout into structured typed blocks for rich UI rendering.
 * Returns null if the output is not structured (plain text).
 */
export function parseAgentOutputBlocks(output: string): OutputBlock[] | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const parsedEvents = parseStructuredEvents(trimmed);
  if (!parsedEvents) return null;

  const blocks = structuredEventsToBlocks(parsedEvents);
  return blocks.length > 0 ? blocks : null;
}

/**
 * Formats agent stdout for human-readable display.
 * - For structured logs (Claude/Qwen/OpenCode), renders readable structured events.
 * - For plain text output, returns stdout as-is (trimmed).
 */
export function formatAgentOutputForDisplay(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';

  const parsedEvents = parseStructuredEvents(output);
  if (!parsedEvents) return trimmed;

  return formatStructuredEventsForDisplay(parsedEvents) || formatPartialStreamContent(parsedEvents) || trimmed;
}

/**
 * Returns a concise final user-facing response from agent stdout.
 * - For structured logs (Claude/Qwen/OpenCode), extracts final result/assistant text.
 * - For plain text output, returns stdout as-is (trimmed).
 */
export function extractFinalResponseText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';

  const parsedEvents = parseStructuredEvents(stdout);
  if (!parsedEvents) return trimmed;

  for (let i = parsedEvents.length - 1; i >= 0; i -= 1) {
    const text = extractFromResultEvent(parsedEvents[i]);
    if (text) return text;
  }

  for (let i = parsedEvents.length - 1; i >= 0; i -= 1) {
    const text = extractFromAssistantEvent(parsedEvents[i]);
    if (text) return text;
  }

  const openCodeText = extractOpenCodeFinalText(parsedEvents);
  if (openCodeText) return openCodeText;

  return formatPartialStreamContent(parsedEvents);
}
