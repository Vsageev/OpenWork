import { Fragment, useEffect, useRef, useState } from 'react';
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Terminal,
  AlertTriangle,
  Copy,
  Check,
  Layers,
  FileText,
  Brain,
  Wrench,
  Cpu,
  CircleAlert,
  Info,
  Hash,
  Zap,
} from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent';
import {
  extractFinalResponseText,
  formatAgentOutputForDisplay,
  parseAgentOutputBlocks,
} from 'shared';
import type { OutputBlock } from 'shared';
import { api } from '../lib/api';
import { getAgentModelDefinition } from '../lib/agent-models';
import styles from './RunLogPanel.module.css';

interface AgentRunDetail {
  id: string;
  agentId: string;
  model?: string | null;
  modelId?: string | null;
  status: 'running' | 'completed' | 'error';
  errorMessage: string | null;
  stdout: string | null;
  stderr: string | null;
  responseText: string | null;
  triggerPrompt: string | null;
}

function formatModelLabel(model?: string | null, modelId?: string | null): string | null {
  if (!model && !modelId) return null;
  const provider = getAgentModelDefinition(model);
  const providerName = provider?.name ?? model ?? '';
  if (modelId) return `${providerName} / ${modelId}`;
  return providerName || null;
}

function LogCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className={styles.logCopyBtn} onClick={handleCopy} title={copied ? 'Copied!' : 'Copy to clipboard'}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function SimpleLogView({ blocks }: { blocks: OutputBlock[] }) {
  const filtered = blocks.filter(
    (b) => b.type === 'assistant_text' || b.type === 'tool_call' || b.type === 'result' || b.type === 'thinking',
  );
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());

  if (filtered.length === 0) {
    return <span className={styles.logEmpty}>No displayable content</span>;
  }

  const toggleThinking = (idx: number) => {
    setExpandedThinking(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  return (
    <div className={styles.simpleLog}>
      {filtered.map((block, i) => {
        if (block.type === 'thinking') {
          const isExpanded = expandedThinking.has(i);
          return (
            <div key={i} className={styles.simpleThinking}>
              <button className={styles.simpleThinkingToggle} onClick={() => toggleThinking(i)}>
                <Brain size={12} />
                <span>Thinking</span>
                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {isExpanded && (
                <div className={styles.simpleThinkingContent}>
                  <MarkdownContent compact>{block.content}</MarkdownContent>
                </div>
              )}
            </div>
          );
        }

        if (block.type === 'assistant_text') {
          return (
            <div key={i} className={styles.simpleText}>
              <MarkdownContent compact>{block.content}</MarkdownContent>
            </div>
          );
        }

        if (block.type === 'tool_call') {
          return (
            <div key={i} className={styles.simpleToolCall}>
              <Wrench size={12} />
              <span className={styles.simpleToolName}>{block.toolName}</span>
              {block.input && (() => {
                try {
                  const parsed = JSON.parse(block.input);
                  const summary = Object.entries(parsed)
                    .slice(0, 3)
                    .map(([k, v]) => {
                      const val = typeof v === 'string'
                        ? (v.length > 60 ? v.slice(0, 57) + '...' : v)
                        : JSON.stringify(v);
                      return `${k}=${val}`;
                    })
                    .join(', ');
                  return summary ? <span className={styles.simpleToolArgs}>{summary}</span> : null;
                } catch {
                  return <span className={styles.simpleToolArgs}>{block.input.slice(0, 80)}</span>;
                }
              })()}
            </div>
          );
        }

        if (block.type === 'result') {
          return (
            <div key={i} className={block.isError ? styles.simpleError : styles.simpleResult}>
              {block.text && <div className={styles.simpleText}><MarkdownContent compact>{block.text}</MarkdownContent></div>}
              {block.usage && (
                <div className={styles.simpleUsage}>
                  {block.usage.inputTokens != null && <span>In: {block.usage.inputTokens.toLocaleString()}</span>}
                  {block.usage.outputTokens != null && <span>Out: {block.usage.outputTokens.toLocaleString()}</span>}
                  {block.durationMs != null && <span>{(block.durationMs / 1000).toFixed(1)}s</span>}
                  {block.stopReason && <span>{block.stopReason}</span>}
                </div>
              )}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

function StructuredLogView({ blocks }: { blocks: OutputBlock[] }) {
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<number>>(() => {
    const collapsed = new Set<number>();
    blocks.forEach((b, i) => {
      if (b.type === 'thinking' || b.type === 'tool_result' || b.type === 'message_meta') collapsed.add(i);
    });
    return collapsed;
  });

  const toggleBlock = (index: number) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className={styles.structuredLog}>
      {blocks.map((block, i) => {
        const isCollapsed = collapsedBlocks.has(i);

        if (block.type === 'system_init') {
          return (
            <div key={i} className={styles.slBlock}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <Cpu size={13} className={styles.slIconSystem} />
                <span className={styles.slBlockTitle}>Session</span>
                {block.model && <span className={styles.slBadge}>{block.model}</span>}
                {block.version && <span className={styles.slMeta}>v{block.version}</span>}
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && (
                <div className={styles.slBlockBody}>
                  <div className={styles.slKvGrid}>
                    {block.model && <><span className={styles.slKvLabel}>Model</span><span className={styles.slKvValue}>{block.model}</span></>}
                    {block.permissionMode && <><span className={styles.slKvLabel}>Permissions</span><span className={styles.slKvValue}>{block.permissionMode}</span></>}
                    {block.cwd && <><span className={styles.slKvLabel}>Working dir</span><span className={styles.slKvValue}>{block.cwd}</span></>}
                    {block.sessionId && <><span className={styles.slKvLabel}>Session</span><span className={styles.slKvValue}>{block.sessionId}</span></>}
                  </div>
                  {block.tools && block.tools.length > 0 && (
                    <div className={styles.slTagRow}>
                      <span className={styles.slKvLabel}>Tools</span>
                      <div className={styles.slTags}>
                        {block.tools.map((t: string, j: number) => <span key={j} className={styles.slTag}>{t}</span>)}
                      </div>
                    </div>
                  )}
                  {block.mcpServers && block.mcpServers.length > 0 && (
                    <div className={styles.slTagRow}>
                      <span className={styles.slKvLabel}>MCP</span>
                      <div className={styles.slTags}>
                        {block.mcpServers.map((s: { name: string; status?: string }, j: number) => (
                          <span key={j} className={styles.slTag}>{s.name}{s.status ? ` (${s.status})` : ''}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {block.agents && block.agents.length > 0 && (
                    <div className={styles.slTagRow}>
                      <span className={styles.slKvLabel}>Agents</span>
                      <div className={styles.slTags}>
                        {block.agents.map((a: string, j: number) => <span key={j} className={styles.slTag}>{a}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        }

        if (block.type === 'thinking') {
          const lines = block.content.split('\n').length;
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockThinking}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <Brain size={13} className={styles.slIconThinking} />
                <span className={styles.slBlockTitle}>Thinking</span>
                <span className={styles.slMeta}>{lines} line{lines !== 1 ? 's' : ''}</span>
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && (
                <pre className={styles.slPre}>{block.content}</pre>
              )}
            </div>
          );
        }

        if (block.type === 'assistant_text') {
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockAssistant}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <MessageSquare size={13} className={styles.slIconAssistant} />
                <span className={styles.slBlockTitle}>Assistant</span>
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && (
                <div className={styles.slMarkdown}><MarkdownContent>{block.content}</MarkdownContent></div>
              )}
            </div>
          );
        }

        if (block.type === 'tool_call') {
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockTool}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <Wrench size={13} className={styles.slIconTool} />
                <span className={styles.slBlockTitle}>Tool call</span>
                <span className={styles.slBadgeTool}>{block.toolName}</span>
                {block.toolId && <span className={styles.slMeta}>{block.toolId.slice(0, 12)}</span>}
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && block.input && (
                <pre className={`${styles.slPre} ${styles.slPreCode}`}>{block.input}</pre>
              )}
            </div>
          );
        }

        if (block.type === 'tool_result') {
          const truncated = block.content.length > 300;
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockToolResult}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <Hash size={13} className={styles.slIconToolResult} />
                <span className={styles.slBlockTitle}>Tool result</span>
                {block.toolId && <span className={styles.slMeta}>{block.toolId.slice(0, 12)}</span>}
                {isCollapsed && truncated && <span className={styles.slMeta}>{block.content.length} chars</span>}
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && (
                <div className={styles.slMarkdown}><MarkdownContent>{block.content}</MarkdownContent></div>
              )}
            </div>
          );
        }

        if (block.type === 'result') {
          return (
            <div key={i} className={`${styles.slBlock} ${block.isError ? styles.slBlockError : styles.slBlockResult}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                {block.isError ? <CircleAlert size={13} className={styles.slIconError} /> : <Zap size={13} className={styles.slIconResult} />}
                <span className={styles.slBlockTitle}>{block.isError ? 'Error' : 'Result'}</span>
                {block.stopReason && <span className={styles.slBadge}>{block.stopReason}</span>}
                {block.durationMs != null && <span className={styles.slMeta}>{(block.durationMs / 1000).toFixed(1)}s</span>}
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && (
                <div className={styles.slBlockBody}>
                  {block.text && <div className={styles.slMarkdown}><MarkdownContent>{block.text}</MarkdownContent></div>}
                  {block.usage && (
                    <div className={styles.slUsageRow}>
                      {block.usage.inputTokens != null && <span className={styles.slUsageStat}>In: {block.usage.inputTokens.toLocaleString()}</span>}
                      {block.usage.outputTokens != null && <span className={styles.slUsageStat}>Out: {block.usage.outputTokens.toLocaleString()}</span>}
                      {block.usage.cacheRead != null && <span className={styles.slUsageStat}>Cache read: {block.usage.cacheRead.toLocaleString()}</span>}
                      {block.usage.cacheCreate != null && <span className={styles.slUsageStat}>Cache write: {block.usage.cacheCreate.toLocaleString()}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        }

        if (block.type === 'rate_limit') {
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockRateLimit}`}>
              <div className={styles.slBlockHeader}>
                <CircleAlert size={13} className={styles.slIconWarning} />
                <span className={styles.slBlockTitle}>Rate limited</span>
                {block.retryAfter && <span className={styles.slMeta}>retry in {block.retryAfter}s</span>}
              </div>
              {block.message && <div className={styles.slBlockBody}><span className={styles.slMeta}>{block.message}</span></div>}
            </div>
          );
        }

        if (block.type === 'message_meta') {
          return (
            <div key={i} className={`${styles.slBlock} ${styles.slBlockMeta}`}>
              <button className={styles.slBlockHeader} onClick={() => toggleBlock(i)}>
                <Info size={13} className={styles.slIconMeta} />
                <span className={styles.slBlockTitle}>{block.label}</span>
                {Object.entries(block.details).slice(0, 2).map(([k, v]: [string, string]) => (
                  <span key={k} className={styles.slMeta}>{k}: {v}</span>
                ))}
                {isCollapsed ? <ChevronRight size={13} className={styles.slChevron} /> : <ChevronDown size={13} className={styles.slChevron} />}
              </button>
              {!isCollapsed && Object.keys(block.details).length > 2 && (
                <div className={styles.slBlockBody}>
                  <div className={styles.slKvGrid}>
                    {Object.entries(block.details).map(([k, v]: [string, string]) => (
                      <Fragment key={k}><span className={styles.slKvLabel}>{k}</span><span className={styles.slKvValue}>{v}</span></Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        }

        if (block.type === 'plain_text') {
          return (
            <div key={i} className={styles.slBlock}>
              <pre className={styles.slPre}>{block.content}</pre>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export function RunLogPanel({ runId, runStatus }: { runId: string; runStatus: 'running' | 'completed' | 'error' }) {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [logViewMode, setLogViewMode] = useState<'simple' | 'detailed'>('simple');
  const [expandedSections, setExpandedSections] = useState<{ prompt: boolean; response: boolean; error: boolean; stdout: boolean; stderr: boolean }>({
    prompt: false,
    response: false,
    error: false,
    stdout: false,
    stderr: false,
  });
  const previousStatusRef = useRef<string>(runStatus);

  useEffect(() => {
    let cancelled = false;
    api<AgentRunDetail>(`/agent-runs/${runId}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [runId]);

  useEffect(() => {
    if (runStatus !== 'running') return undefined;

    let cancelled = false;
    const interval = setInterval(() => {
      api<AgentRunDetail>(`/agent-runs/${runId}`)
        .then((data) => {
          if (!cancelled) setDetail(data);
        })
        .catch(() => {});
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId, runStatus]);

  useEffect(() => {
    const wasRunning = previousStatusRef.current === 'running';
    previousStatusRef.current = runStatus;

    if (wasRunning && runStatus !== 'running') {
      api<AgentRunDetail>(`/agent-runs/${runId}`)
        .then((data) => setDetail(data))
        .catch(() => {});
    }
  }, [runId, runStatus]);

  if (loading) {
    return <div className={styles.logPanel}><span className={styles.logLoading}>Loading logs...</span></div>;
  }

  if (!detail) {
    return <div className={styles.logPanel}><span className={styles.logEmpty}>Failed to load run details</span></div>;
  }

  const hasStdout = detail.stdout && detail.stdout.trim().length > 0;
  const hasStderr = detail.stderr && detail.stderr.trim().length > 0;
  const hasError = detail.errorMessage && detail.errorMessage.trim().length > 0;
  const shortResponse = detail.responseText?.trim() || null;
  const stdoutText = detail.stdout?.trim() || null;
  const parsedBlocks = stdoutText ? parseAgentOutputBlocks(stdoutText) : null;
  const formattedStdout = stdoutText ? formatAgentOutputForDisplay(stdoutText) : null;
  const formattedStderr = detail.stderr?.trim()
    ? formatAgentOutputForDisplay(detail.stderr.trim())
    : null;
  const showResponse = Boolean(shortResponse);
  const promptText = detail.triggerPrompt?.trim() || null;
  const hasContent = promptText || showResponse || hasStdout || hasStderr || hasError;
  const isExpandable = (text?: string | null) => {
    if (!text) return false;
    return text.length > 2000 || text.split('\n').length > 18;
  };
  const canExpandPrompt = isExpandable(promptText);
  const canExpandResponse = isExpandable(shortResponse);
  const canExpandError = isExpandable(detail.errorMessage);
  const canExpandStdout = isExpandable(formattedStdout);
  const canExpandStderr = isExpandable(formattedStderr);
  const toggleSection = (section: 'prompt' | 'response' | 'error' | 'stdout' | 'stderr') => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const modelLabel = formatModelLabel(detail.model, detail.modelId);

  return (
    <div className={styles.logPanel}>
      {modelLabel && (
        <div className={styles.modelInfo}>
          <Cpu size={13} />
          <span>{modelLabel}</span>
        </div>
      )}
      {promptText && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <FileText size={13} />
            <span>Prompt</span>
            {canExpandPrompt && (
              <button
                className={`${styles.logExpandBtn} ${expandedSections.prompt ? styles.logExpandBtnExpanded : ''}`}
                onClick={() => toggleSection('prompt')}
                aria-expanded={expandedSections.prompt}
                title={expandedSections.prompt ? 'Collapse full log view' : 'Expand to full log view'}
              >
                {expandedSections.prompt ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expandedSections.prompt ? 'Collapse' : 'View full'}
              </button>
            )}
            <LogCopyButton text={promptText} />
          </div>
          <pre className={`${styles.logPre} ${styles.logPrePrompt} ${canExpandPrompt && !expandedSections.prompt ? styles.logPreCollapsed : ''} ${expandedSections.prompt ? styles.logPreExpanded : ''}`}>{promptText}</pre>
        </div>
      )}
      {showResponse && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <MessageSquare size={13} />
            <span>Answer</span>
            {canExpandResponse && (
              <button
                className={`${styles.logExpandBtn} ${expandedSections.response ? styles.logExpandBtnExpanded : ''}`}
                onClick={() => toggleSection('response')}
                aria-expanded={expandedSections.response}
                title={expandedSections.response ? 'Collapse full log view' : 'Expand to full log view'}
              >
                {expandedSections.response ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expandedSections.response ? 'Collapse' : 'View full'}
              </button>
            )}
            <LogCopyButton text={shortResponse!} />
          </div>
          <pre className={`${styles.logPre} ${canExpandResponse && !expandedSections.response ? styles.logPreCollapsed : ''} ${expandedSections.response ? styles.logPreExpanded : ''}`}>{shortResponse}</pre>
        </div>
      )}
      {hasError && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <AlertTriangle size={13} />
            <span>Error</span>
            {canExpandError && (
              <button
                className={`${styles.logExpandBtn} ${expandedSections.error ? styles.logExpandBtnExpanded : ''}`}
                onClick={() => toggleSection('error')}
                aria-expanded={expandedSections.error}
                title={expandedSections.error ? 'Collapse full log view' : 'Expand to full log view'}
              >
                {expandedSections.error ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expandedSections.error ? 'Collapse' : 'View full'}
              </button>
            )}
            <LogCopyButton text={detail.errorMessage!} />
          </div>
          <pre className={`${styles.logPre} ${styles.logPreError} ${canExpandError && !expandedSections.error ? styles.logPreCollapsed : ''} ${expandedSections.error ? styles.logPreExpanded : ''}`}>{detail.errorMessage}</pre>
        </div>
      )}
      {hasStdout && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <Terminal size={13} />
            <span>{parsedBlocks ? 'Logs' : 'Output'}</span>
            {parsedBlocks && (
              <div className={styles.logModePills}>
                <button
                  className={`${styles.logModePill} ${logViewMode === 'simple' ? styles.logModePillActive : ''}`}
                  onClick={() => setLogViewMode('simple')}
                >
                  Simple
                </button>
                <button
                  className={`${styles.logModePill} ${logViewMode === 'detailed' ? styles.logModePillActive : ''}`}
                  onClick={() => setLogViewMode('detailed')}
                >
                  Detailed
                </button>
              </div>
            )}
            {!parsedBlocks && canExpandStdout && (
              <button
                className={`${styles.logExpandBtn} ${expandedSections.stdout ? styles.logExpandBtnExpanded : ''}`}
                onClick={() => toggleSection('stdout')}
                aria-expanded={expandedSections.stdout}
                title={expandedSections.stdout ? 'Collapse full log view' : 'Expand to full log view'}
              >
                {expandedSections.stdout ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expandedSections.stdout ? 'Collapse' : 'View full'}
              </button>
            )}
            <LogCopyButton text={detail.stdout!} />
          </div>
          {parsedBlocks ? (
            logViewMode === 'simple'
              ? <SimpleLogView blocks={parsedBlocks} />
              : <StructuredLogView blocks={parsedBlocks} />
          ) : (
            <pre className={`${styles.logPre} ${canExpandStdout && !expandedSections.stdout ? styles.logPreCollapsed : ''} ${expandedSections.stdout ? styles.logPreExpanded : ''}`}>{formattedStdout}</pre>
          )}
        </div>
      )}
      {hasStderr && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <Layers size={13} />
            <span>Full Logs</span>
            {canExpandStderr && (
              <button
                className={`${styles.logExpandBtn} ${expandedSections.stderr ? styles.logExpandBtnExpanded : ''}`}
                onClick={() => toggleSection('stderr')}
                aria-expanded={expandedSections.stderr}
                title={expandedSections.stderr ? 'Collapse full log view' : 'Expand to full log view'}
              >
                {expandedSections.stderr ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {expandedSections.stderr ? 'Collapse' : 'View full'}
              </button>
            )}
            <LogCopyButton text={detail.stderr!} />
          </div>
          <pre className={`${styles.logPre} ${canExpandStderr && !expandedSections.stderr ? styles.logPreCollapsed : ''} ${expandedSections.stderr ? styles.logPreExpanded : ''}`}>{formattedStderr}</pre>
        </div>
      )}
      {!hasContent && (
        <span className={styles.logEmpty}>No logs available for this run</span>
      )}
    </div>
  );
}
