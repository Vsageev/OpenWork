import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, MessageSquare, Clock, Zap, ChevronDown, ChevronRight, ChevronUp, Terminal, AlertTriangle, ExternalLink, X, Filter, Copy, Check, Trash2, Layers, Square, FileText, Brain, Wrench, Cpu, CircleAlert, Info, Hash } from 'lucide-react';
import { PageHeader } from '../layout';
import { api } from '../lib/api';
import { AgentAvatar } from '../components/AgentAvatar';
import { toast } from '../stores/toast';
import styles from './AgentMonitorPage.module.css';
import { MarkdownContent } from '../ui/MarkdownContent';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { extractFinalResponseText, formatAgentOutputForDisplay, parseAgentOutputBlocks } from 'shared';
import type { OutputBlock } from 'shared';

type AgentRunTriggerType = 'chat' | 'cron_job' | 'card_assignment';

interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
  triggerType: AgentRunTriggerType;
  status: 'running' | 'completed' | 'error';
  conversationId: string | null;
  cardId: string | null;
  cronJobId: string | null;
  errorMessage: string | null;
  responseText?: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

interface AgentAvatarInfo {
  id: string;
  name?: string;
  avatarIcon: string;
  avatarBgColor: string;
  avatarLogoColor: string;
}

interface AgentRunDetail extends AgentRun {
  stdout: string | null;
  stderr: string | null;
  responseText: string | null;
  triggerPrompt: string | null;
}

interface AgentBatchRun {
  id: string;
  sourceType: 'board' | 'collection';
  sourceId: string;
  sourceName: string | null;
  agentId: string;
  agentName?: string | null;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
  prompt: string;
  maxParallel: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface AgentBatchItem {
  id: string;
  cardId: string;
  cardName: string | null;
  status: string;
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
}

type StatusFilter = 'all' | 'completed' | 'error' | 'running';
type TriggerFilter = 'all' | 'chat' | 'cron_job' | 'card_assignment';

const HISTORY_PAGE_SIZE = 50;
const ACTIVE_BATCH_RUNS_LIMIT = 20;
const RECENT_BATCH_RUNS_LIMIT = 10;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let elapsedNow = Date.now();
let elapsedTicker: ReturnType<typeof setInterval> | null = null;
const elapsedListeners = new Set<() => void>();

function emitElapsedTick() {
  elapsedNow = Date.now();
  for (const listener of elapsedListeners) {
    listener();
  }
}

function subscribeToElapsedNow(listener: () => void) {
  elapsedListeners.add(listener);
  if (!elapsedTicker) {
    elapsedTicker = setInterval(emitElapsedTick, 1000);
  }

  return () => {
    elapsedListeners.delete(listener);
    if (elapsedListeners.size === 0 && elapsedTicker) {
      clearInterval(elapsedTicker);
      elapsedTicker = null;
    }
  };
}

function getElapsedNowSnapshot() {
  return elapsedNow;
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const now = useSyncExternalStore(subscribeToElapsedNow, getElapsedNowSnapshot, getElapsedNowSnapshot);
  return <span>{formatDuration(now - new Date(startedAt).getTime())}</span>;
}

function TriggerBadge({ type }: { type: AgentRun['triggerType'] }) {
  const config: Record<AgentRunTriggerType, { label: string; className: string; icon: React.ReactNode }> = {
    chat: { label: 'Chat', className: styles.triggerChat, icon: <MessageSquare size={12} /> },
    cron_job: { label: 'Cron', className: styles.triggerCron, icon: <Clock size={12} /> },
    card_assignment: { label: 'Card', className: styles.triggerCard, icon: <Zap size={12} /> },
  };
  const c = config[type];
  return (
    <span className={`${styles.triggerBadge} ${c.className}`}>
      {c.icon} {c.label}
    </span>
  );
}

function StatusBadge({ status }: { status: AgentRun['status'] }) {
  const config = {
    running: { label: 'Running', className: styles.statusRunning },
    completed: { label: 'Completed', className: styles.statusCompleted },
    error: { label: 'Error', className: styles.statusError },
  };
  const c = config[status];
  return (
    <span className={`${styles.statusBadge} ${c.className}`}>
      {status === 'running' && <span className={styles.pulsingDot} />}
      {c.label}
    </span>
  );
}

function TriggerLink({ run, navigate }: { run: AgentRun; navigate: ReturnType<typeof useNavigate> }) {
  if (run.cardId) {
    return (
      <button
        className={styles.triggerLink}
        onClick={(e) => { e.stopPropagation(); navigate(`/cards/${run.cardId}`); }}
        title="Open card"
      >
        <ExternalLink size={12} />
        <span>Card</span>
      </button>
    );
  }
  if (run.conversationId) {
    const targetParams = new URLSearchParams({
      agentId: run.agentId,
      conversationId: run.conversationId,
    });
    return (
      <button
        className={styles.triggerLink}
        onClick={(e) => { e.stopPropagation(); navigate(`/agents?${targetParams.toString()}`); }}
        title="Open conversation"
      >
        <ExternalLink size={12} />
        <span>Chat</span>
      </button>
    );
  }
  if (run.triggerType === 'cron_job') {
    return (
      <button
        className={styles.triggerLink}
        onClick={(e) => { e.stopPropagation(); navigate(`/agents?agentId=${run.agentId}`); }}
        title="Open agent"
      >
        <ExternalLink size={12} />
        <span>Cron</span>
      </button>
    );
  }
  return null;
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

function RunLogPanel({ runId, runStatus }: { runId: string; runStatus: AgentRun['status'] }) {
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
  const previousStatusRef = useRef<AgentRun['status']>(runStatus);

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

  // Keep logs fresh while running so users can watch progress without reopening.
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

  // One final refresh when the run transitions out of running state.
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
  const extractedStdoutResponse = stdoutText ? extractFinalResponseText(stdoutText) : null;
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

  return (
    <div className={styles.logPanel}>
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

function BatchErrorPanel({ batch }: { batch: AgentBatchRun }) {
  const [items, setItems] = useState<AgentBatchItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const endpoint =
      batch.sourceType === 'board'
        ? `/boards/${batch.sourceId}/batch-runs/${batch.id}/items?status=failed&limit=100`
        : `/collections/${batch.sourceId}/agent-batch/runs/${batch.id}/items?status=failed&limit=100`;

    api<{ entries: AgentBatchItem[] }>(endpoint)
      .then((res) => setItems(res.entries))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [batch.id, batch.sourceType, batch.sourceId]);

  if (loading) return <div className={styles.batchErrors}><span className={styles.logLoading}>Loading errors...</span></div>;
  if (items.length === 0) return <div className={styles.batchErrors}><span className={styles.logEmpty}>No error details available</span></div>;

  return (
    <div className={styles.batchErrors}>
      {items.map((item) => (
        <div key={item.id} className={styles.batchErrorItem}>
          <span className={styles.batchErrorName}>{item.cardName || item.cardId.slice(0, 8)}</span>
          {item.errorMessage && (
            <pre className={styles.batchErrorMessage}>{item.errorMessage}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function AgentMonitorPage() {
  useDocumentTitle('Monitor');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const targetRunId = searchParams.get('runId');
  const [activeRuns, setActiveRuns] = useState<AgentRun[]>([]);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [agentAvatars, setAgentAvatars] = useState<Record<string, AgentAvatarInfo>>({});
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [killingRunId, setKillingRunId] = useState<string | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [activeBatchRuns, setActiveBatchRuns] = useState<AgentBatchRun[]>([]);
  const [recentBatchRuns, setRecentBatchRuns] = useState<AgentBatchRun[]>([]);
  const [recentBatchRunsLoading, setRecentBatchRunsLoading] = useState(false);
  const [cancellingBatchId, setCancellingBatchId] = useState<string | null>(null);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [cleaningBatch, setCleaningBatch] = useState(false);
  const prevActiveCountRef = useRef(0);
  const prevActiveBatchCountRef = useRef(0);
  const initializedFiltersRef = useRef(false);
  const avatarFetchInFlightRef = useRef<Set<string>>(new Set());
  const historyLoadMoreRef = useRef<HTMLDivElement | null>(null);

  // Filter state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const seedAgentAvatars = useCallback((entries: Array<{
    agentId: string;
    agentName?: string | null;
    avatarIcon?: string | null;
    avatarBgColor?: string | null;
    avatarLogoColor?: string | null;
  }>) => {
    setAgentAvatars((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const entry of entries) {
        if (!entry.agentId) continue;
        if (!entry.avatarIcon || !entry.avatarBgColor || !entry.avatarLogoColor) continue;

        const existing = next[entry.agentId];
        if (
          existing?.avatarIcon === entry.avatarIcon &&
          existing.avatarBgColor === entry.avatarBgColor &&
          existing.avatarLogoColor === entry.avatarLogoColor &&
          (existing.name ?? null) === (entry.agentName ?? null)
        ) {
          continue;
        }

        next[entry.agentId] = {
          id: entry.agentId,
          name: entry.agentName ?? existing?.name,
          avatarIcon: entry.avatarIcon,
          avatarBgColor: entry.avatarBgColor,
          avatarLogoColor: entry.avatarLogoColor,
        };
        changed = true;
      }

      return changed ? next : prev;
    });
  }, []);

  const fetchActive = useCallback(async () => {
    try {
      const res = await api<{ entries: AgentRun[] }>('/agent-runs/active');
      seedAgentAvatars(res.entries);
      setActiveRuns(res.entries);
      return res.entries.length;
    } catch {
      return 0;
    }
  }, [seedAgentAvatars]);

  const fetchActiveBatchRuns = useCallback(async () => {
    try {
      const res = await api<{ entries: AgentBatchRun[] }>(
        `/agent-batch-runs?status=active&limit=${ACTIVE_BATCH_RUNS_LIMIT}`,
      );
      seedAgentAvatars(res.entries);
      setActiveBatchRuns(res.entries);
      return res.entries.length;
    } catch {
      return 0;
    }
  }, [seedAgentAvatars]);

  const fetchRecentBatchRuns = useCallback(async () => {
    try {
      const completed = api<{ entries: AgentBatchRun[] }>(
        `/agent-batch-runs?status=completed&limit=${RECENT_BATCH_RUNS_LIMIT}`,
      ).catch(() => ({ entries: [] }));
      const failed = api<{ entries: AgentBatchRun[] }>(
        `/agent-batch-runs?status=failed&limit=${RECENT_BATCH_RUNS_LIMIT}`,
      ).catch(() => ({ entries: [] }));
      const cancelled = api<{ entries: AgentBatchRun[] }>(
        `/agent-batch-runs?status=cancelled&limit=${RECENT_BATCH_RUNS_LIMIT}`,
      ).catch(() => ({ entries: [] }));

      const [completedRes, failedRes, cancelledRes] = await Promise.all([completed, failed, cancelled]);
      const merged = [...completedRes.entries, ...failedRes.entries, ...cancelledRes.entries]
        .sort((a, b) => {
          const aTime = new Date(a.finishedAt || a.createdAt).getTime();
          const bTime = new Date(b.finishedAt || b.createdAt).getTime();
          return bTime - aTime;
        })
        .slice(0, RECENT_BATCH_RUNS_LIMIT);
      seedAgentAvatars(merged);
      setRecentBatchRuns(merged);
    } catch {
      // best effort
    }
  }, [seedAgentAvatars]);

  const fetchHistory = useCallback(async (
    {
      offset = 0,
      append = false,
      status = 'all',
      triggerType = 'all',
      agentId = 'all',
    }: {
      offset?: number;
      append?: boolean;
      status?: StatusFilter;
      triggerType?: TriggerFilter;
      agentId?: string;
    } = {},
  ) => {
    if (offset === 0) setHistoryLoading(true);
    else setLoadingMoreHistory(true);

    try {
      const params = new URLSearchParams({
        limit: String(HISTORY_PAGE_SIZE),
        offset: String(offset),
      });
      if (status !== 'all') params.set('status', status);
      if (triggerType !== 'all') params.set('triggerType', triggerType);
      if (agentId !== 'all') params.set('agentId', agentId);
      const res = await api<{ entries: AgentRun[]; total: number }>(`/agent-runs?${params.toString()}`);
      seedAgentAvatars(res.entries);
      setHistoryRuns((prev) => (append ? [...prev, ...res.entries] : res.entries));
      setHistoryTotal(res.total);
    } catch {
      if (!append) {
        setHistoryRuns([]);
        setHistoryTotal(0);
      }
    } finally {
      setHistoryLoading(false);
      setLoadingMoreHistory(false);
    }
  }, [seedAgentAvatars]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchActive(),
      fetchHistory({ status: 'all', triggerType: 'all', agentId: 'all' }),
      fetchActiveBatchRuns(),
    ]).then(([activeCount, _history, activeBatchCount]) => {
      if (cancelled) return;
      prevActiveCountRef.current = activeCount;
      prevActiveBatchCountRef.current = activeBatchCount;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchActive, fetchHistory, fetchActiveBatchRuns]);

  useEffect(() => {
    if (loading) return undefined;

    let cancelled = false;
    setRecentBatchRunsLoading(true);
    const timeoutId = window.setTimeout(() => {
      fetchRecentBatchRuns()
        .finally(() => {
          if (!cancelled) setRecentBatchRunsLoading(false);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [loading, fetchRecentBatchRuns]);

  // Scroll-based infinite loading — checks if sentinel is near viewport
  useEffect(() => {
    if (historyLoading || loadingMoreHistory) return undefined;
    if (historyRuns.length === 0 || historyRuns.length >= historyTotal) return undefined;

    let fired = false;

    const check = () => {
      if (fired) return;
      const sentinel = historyLoadMoreRef.current;
      if (!sentinel) return;
      const rect = sentinel.getBoundingClientRect();
      // Trigger when sentinel is within 300px of viewport bottom
      if (rect.top < window.innerHeight + 300) {
        fired = true;
        fetchHistory({
          offset: historyRuns.length,
          append: true,
          status: statusFilter,
          triggerType: triggerFilter,
          agentId: agentFilter,
        });
      }
    };

    const onScroll = () => requestAnimationFrame(check);

    window.addEventListener('scroll', onScroll, { passive: true });
    // Check immediately — content may already be short enough
    check();

    return () => window.removeEventListener('scroll', onScroll);
  }, [
    fetchHistory,
    historyLoading,
    loadingMoreHistory,
    historyRuns.length,
    historyTotal,
    statusFilter,
    triggerFilter,
    agentFilter,
  ]);

  useEffect(() => {
    if (!initializedFiltersRef.current) {
      initializedFiltersRef.current = true;
      return;
    }

    setExpandedRunId(null);
    fetchHistory({
      status: statusFilter,
      triggerType: triggerFilter,
      agentId: agentFilter,
    });
  }, [statusFilter, triggerFilter, agentFilter, fetchHistory]);

  useEffect(() => {
    if (!targetRunId) return;
    setExpandedRunId(targetRunId);

    const exists =
      activeRuns.some((run) => run.id === targetRunId) ||
      historyRuns.some((run) => run.id === targetRunId);
    if (exists) return;

    let cancelled = false;
    api<AgentRunDetail>(`/agent-runs/${targetRunId}`)
      .then((run) => {
        if (cancelled) return;
        seedAgentAvatars([run]);
        if (run.status === 'running') {
          setActiveRuns((prev) => (prev.some((entry) => entry.id === run.id) ? prev : [run, ...prev]));
          return;
        }
        setHistoryRuns((prev) => (prev.some((entry) => entry.id === run.id) ? prev : [run, ...prev]));
        setHistoryTotal((prev) => prev + 1);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [targetRunId, activeRuns, historyRuns, seedAgentAvatars]);

  // Poll active runs every 4 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      const [count, activeBatchCount] = await Promise.all([fetchActive(), fetchActiveBatchRuns()]);
      // If a run just completed, refresh history
      if (count < prevActiveCountRef.current) {
        fetchHistory({
          status: statusFilter,
          triggerType: triggerFilter,
          agentId: agentFilter,
        });
      }
      if (activeBatchCount !== prevActiveBatchCountRef.current) {
        fetchRecentBatchRuns();
      }
      prevActiveCountRef.current = count;
      prevActiveBatchCountRef.current = activeBatchCount;
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchActive, fetchHistory, fetchActiveBatchRuns, fetchRecentBatchRuns, statusFilter, triggerFilter, agentFilter]);

  const visibleAgentIds = useMemo(() => Array.from(new Set([
    ...activeRuns.map((run) => run.agentId),
    ...historyRuns.map((run) => run.agentId),
    ...activeBatchRuns.map((run) => run.agentId),
    ...recentBatchRuns.map((run) => run.agentId),
  ])), [activeRuns, historyRuns, activeBatchRuns, recentBatchRuns]);

  useEffect(() => {
    const missingIds = visibleAgentIds.filter((id) => !agentAvatars[id] && !avatarFetchInFlightRef.current.has(id));
    if (missingIds.length === 0) return undefined;

    let cancelled = false;
    missingIds.forEach((id) => avatarFetchInFlightRef.current.add(id));

    Promise.all(
      missingIds.map((id) =>
        api<AgentAvatarInfo>(`/agents/${id}`)
          .then((agent) => ({ id, agent }))
          .catch(() => ({ id, agent: null })),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        setAgentAvatars((prev) => {
          const next = { ...prev };
          for (const result of results) {
            if (!result.agent) continue;
            next[result.id] = {
              id: result.agent.id,
              name: result.agent.name,
              avatarIcon: result.agent.avatarIcon,
              avatarBgColor: result.agent.avatarBgColor,
              avatarLogoColor: result.agent.avatarLogoColor,
            };
          }
          return next;
        });
      })
      .finally(() => {
        for (const id of missingIds) avatarFetchInFlightRef.current.delete(id);
      });

    return () => {
      cancelled = true;
    };
  }, [visibleAgentIds, agentAvatars]);

  // Unique agents from history for the agent filter dropdown
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of historyRuns) {
      if (!seen.has(run.agentId)) {
        seen.set(run.agentId, run.agentName);
      }
    }
    // Also include agents from agentAvatars that might not be in history
    for (const [id, info] of Object.entries(agentAvatars)) {
      if (!seen.has(id) && info.name) {
        seen.set(id, info.name);
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [historyRuns, agentAvatars]);

  const cancelBatchRun = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    setCancellingBatchId(runId);
    try {
      await api(`/agent-batch-runs/${runId}/cancel`, { method: 'POST' });
      await Promise.all([fetchActiveBatchRuns(), fetchRecentBatchRuns()]);
      toast.success('Batch run cancelled');
    } catch {
      toast.error('Failed to cancel batch run');
    } finally {
      setCancellingBatchId(null);
    }
  };

  const cleanupBatchRuns = async () => {
    setCleaningBatch(true);
    try {
      const res = await api<{ deleted: number }>('/agent-batch-runs', { method: 'DELETE' });
      if (res.deleted > 0) {
        toast.success(`Cleared ${res.deleted} finished batch run${res.deleted === 1 ? '' : 's'}`);
        await fetchRecentBatchRuns();
      } else {
        toast.success('No finished batch runs to clear');
      }
    } catch {
      toast.error('Failed to clear batch runs');
    } finally {
      setCleaningBatch(false);
    }
  };

  const hasActiveFilters = statusFilter !== 'all' || triggerFilter !== 'all' || agentFilter !== 'all';

  const clearFilters = () => {
    setStatusFilter('all');
    setTriggerFilter('all');
    setAgentFilter('all');
  };

  const toggleExpand = (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    setExpandedRunId((prev) => (prev === runId ? null : runId));
  };

  const killRun = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    setKillingRunId(runId);
    try {
      await api(`/agent-runs/${runId}`, { method: 'DELETE' });
      await Promise.all([
        fetchActive(),
        fetchHistory({
          status: statusFilter,
          triggerType: triggerFilter,
          agentId: agentFilter,
        }),
      ]);
      toast.success('Run stopped');
    } catch {
      toast.error('Failed to stop run');
    } finally {
      setKillingRunId(null);
    }
  };

  const cleanupRuns = async (olderThanDays: number) => {
    setCleaningUp(true);
    try {
      const res = await api<{ deleted: number; olderThanDays: number }>(`/agent-runs?olderThanDays=${olderThanDays}`, { method: 'DELETE' });
      if (res.deleted > 0) {
        toast.success(`Deleted ${res.deleted} old run${res.deleted === 1 ? '' : 's'} (older than ${olderThanDays}d)`);
        await fetchHistory({
          status: statusFilter,
          triggerType: triggerFilter,
          agentId: agentFilter,
        });
      } else {
        toast.success(`No runs older than ${olderThanDays} days to delete`);
      }
    } catch {
      toast.error('Failed to clean up runs');
    } finally {
      setCleaningUp(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.wrapper}>
        <PageHeader title="Monitor" description="Track agent executions in real-time" />
        <div className={styles.skeletonSection} />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <PageHeader
        title="Monitor"
        description="Track agent executions in real-time"
        actions={
          <button
            className={styles.cleanupButton}
            onClick={() => cleanupRuns(30)}
            disabled={cleaningUp}
            title="Delete completed and error runs older than 30 days (all agents)"
          >
            <Trash2 size={13} />
            {cleaningUp ? 'Cleaning…' : 'Clean up all (30d+)'}
          </button>
        }
      />

      {/* Active Runs */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Active Runs</h2>
          {activeRuns.length > 0 && (
            <span className={styles.countBadge}>{activeRuns.length}</span>
          )}
        </div>

        {activeRuns.length === 0 ? (
          <div className={styles.runList}>
            <div className={styles.emptyState}>
              <Activity size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No active runs</div>
              <div className={styles.emptyText}>Agent executions will appear here in real-time</div>
            </div>
          </div>
        ) : (
          <div className={styles.runList}>
            {activeRuns.map((run) => (
              <div key={run.id} className={styles.runEntry}>
                <div
                  className={`${styles.runRow} ${styles.activeRunRow}`}
                  onClick={(e) => toggleExpand(e, run.id)}
                >
                  <span className={styles.expandToggle}>
                    {expandedRunId === run.id
                      ? <ChevronDown size={14} />
                      : <ChevronRight size={14} />}
                  </span>
                  <div className={styles.runAgent}>
                    <AgentAvatar
                      icon={agentAvatars[run.agentId]?.avatarIcon || 'spark'}
                      bgColor={agentAvatars[run.agentId]?.avatarBgColor || '#1a1a2e'}
                      logoColor={agentAvatars[run.agentId]?.avatarLogoColor || '#e94560'}
                      size={24}
                    />
                    <button
                      className={styles.runAgentNameBtn}
                      onClick={(e) => { e.stopPropagation(); navigate(`/agents?agentId=${run.agentId}`); }}
                      title="Open agent"
                    >
                      {run.agentName}
                    </button>
                  </div>
                  <TriggerBadge type={run.triggerType} />
                  <StatusBadge status={run.status} />
                  <span className={styles.runTime}>{formatTime(run.startedAt)}</span>
                  <span className={styles.runDuration}>
                    <ElapsedTimer startedAt={run.startedAt} />
                  </span>
                  <TriggerLink run={run} navigate={navigate} />
                  <button
                    className={styles.killButton}
                    onClick={(e) => killRun(e, run.id)}
                    disabled={killingRunId === run.id}
                    title="Kill this run"
                  >
                    <X size={13} />
                  </button>
                </div>
                {expandedRunId === run.id && <RunLogPanel runId={run.id} runStatus={run.status} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Batch Runs */}
      {(activeBatchRuns.length > 0 || recentBatchRuns.length > 0) && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Batch Runs</h2>
            {activeBatchRuns.length > 0 && (
              <span className={styles.countBadge}>{activeBatchRuns.length} active</span>
            )}
            {recentBatchRuns.length > 0 && (
              <button
                className={styles.cleanupButton}
                onClick={cleanupBatchRuns}
                disabled={cleaningBatch}
                title="Clear all finished batch runs"
                style={{ marginLeft: 'auto' }}
              >
                <Trash2 size={13} />
                {cleaningBatch ? 'Clearing...' : 'Clear finished'}
              </button>
            )}
          </div>

          <div className={styles.batchList}>
            {activeBatchRuns.map((batch) => {
              const remaining = batch.queued + batch.processing;
              const progressPct = batch.total > 0 ? Math.round(((batch.completed + batch.failed + batch.cancelled) / batch.total) * 100) : 0;
              const agentInfo = agentAvatars[batch.agentId];
              return (
                <div key={batch.id} className={styles.batchCard}>
                  <div className={styles.batchCardHeader}>
                    <div className={styles.batchAgent}>
                      <AgentAvatar
                        icon={agentInfo?.avatarIcon || 'spark'}
                        bgColor={agentInfo?.avatarBgColor || '#1a1a2e'}
                        logoColor={agentInfo?.avatarLogoColor || '#e94560'}
                        size={22}
                      />
                      <span className={styles.batchAgentName}>{agentInfo?.name || batch.agentId.slice(0, 8)}</span>
                    </div>
                    <div className={styles.batchMeta}>
                      <button
                        className={`${styles.batchSourceBadge} ${batch.sourceType === 'board' ? styles.batchSourceBoard : styles.batchSourceCollection}`}
                        onClick={(e) => { e.stopPropagation(); navigate(batch.sourceType === 'board' ? `/boards/${batch.sourceId}` : `/collections/${batch.sourceId}`); }}
                        title={`Open ${batch.sourceType}`}
                      >
                        <Layers size={11} />
                        {batch.sourceName || batch.sourceType}
                        <ExternalLink size={10} />
                      </button>
                      <span className={`${styles.statusBadge} ${batch.status === 'running' ? styles.statusRunning : styles.statusCompleted}`}>
                        {batch.status === 'running' && <span className={styles.pulsingDot} />}
                        {batch.status === 'queued' ? 'Queued' : 'Running'}
                      </span>
                    </div>
                    <button
                      className={styles.killButton}
                      onClick={(e) => cancelBatchRun(e, batch.id)}
                      disabled={cancellingBatchId === batch.id}
                      title="Cancel batch run"
                    >
                      <Square size={12} />
                    </button>
                  </div>

                  <div className={styles.batchPrompt} title={batch.prompt}>
                    {batch.prompt}
                  </div>

                  <div className={styles.batchProgress}>
                    <div className={styles.batchProgressBar}>
                      <div className={styles.batchProgressFill} style={{ width: `${progressPct}%` }} />
                      {batch.failed > 0 && (
                        <div className={styles.batchProgressFailed} style={{ width: `${Math.round((batch.failed / batch.total) * 100)}%` }} />
                      )}
                    </div>
                    <div className={styles.batchStats}>
                      <span className={styles.batchStatRemaining}>{remaining} left</span>
                      <span className={styles.batchStatDetail}>
                        {batch.completed > 0 && <span className={styles.batchStatDone}>{batch.completed} done</span>}
                        {batch.processing > 0 && <span className={styles.batchStatProcessing}>{batch.processing} running</span>}
                        {batch.failed > 0 && <span className={styles.batchStatFailed}>{batch.failed} failed</span>}
                      </span>
                      <span className={styles.batchStatTotal}>{batch.completed + batch.failed + batch.cancelled}/{batch.total}</span>
                    </div>
                  </div>

                  {batch.startedAt && (
                    <div className={styles.batchElapsed}>
                      <Clock size={11} />
                      <ElapsedTimer startedAt={batch.startedAt} />
                      <span className={styles.batchParallel}>{batch.maxParallel}x parallel</span>
                    </div>
                  )}

                  {batch.failed > 0 && (
                    <>
                      <button
                        className={styles.batchErrorToggle}
                        onClick={() => setExpandedBatchId((prev) => prev === batch.id ? null : batch.id)}
                      >
                        <AlertTriangle size={12} />
                        {expandedBatchId === batch.id ? 'Hide errors' : `Show ${batch.failed} error${batch.failed === 1 ? '' : 's'}`}
                        {expandedBatchId === batch.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                      {expandedBatchId === batch.id && <BatchErrorPanel batch={batch} />}
                    </>
                  )}
                </div>
              );
            })}

            {recentBatchRuns.length > 0 && activeBatchRuns.length > 0 && (
              <div className={styles.batchDividerLabel}>Recent</div>
            )}

            {recentBatchRunsLoading && recentBatchRuns.length === 0 && (
              <div className={styles.batchLoading}>Loading recent batch runs...</div>
            )}

            {recentBatchRuns.map((batch) => {
              const agentInfo = agentAvatars[batch.agentId];
              const statusConfig: Record<string, { label: string; cls: string }> = {
                completed: { label: 'Completed', cls: styles.statusCompleted },
                failed: { label: 'Failed', cls: styles.statusError },
                cancelled: { label: 'Cancelled', cls: styles.statusError },
              };
              const sc = statusConfig[batch.status] || statusConfig.completed;
              return (
                <div key={batch.id} className={`${styles.batchCard} ${styles.batchCardDone}`}>
                  <div className={styles.batchCardHeader}>
                    <div className={styles.batchAgent}>
                      <AgentAvatar
                        icon={agentInfo?.avatarIcon || 'spark'}
                        bgColor={agentInfo?.avatarBgColor || '#1a1a2e'}
                        logoColor={agentInfo?.avatarLogoColor || '#e94560'}
                        size={22}
                      />
                      <span className={styles.batchAgentName}>{agentInfo?.name || batch.agentId.slice(0, 8)}</span>
                    </div>
                    <button
                      className={`${styles.batchSourceBadge} ${batch.sourceType === 'board' ? styles.batchSourceBoard : styles.batchSourceCollection}`}
                      onClick={(e) => { e.stopPropagation(); navigate(batch.sourceType === 'board' ? `/boards/${batch.sourceId}` : `/collections/${batch.sourceId}`); }}
                      title={`Open ${batch.sourceType}`}
                    >
                      <Layers size={11} />
                      {batch.sourceName || batch.sourceType}
                      <ExternalLink size={10} />
                    </button>
                    <span className={`${styles.statusBadge} ${sc.cls}`}>{sc.label}</span>
                    <span className={styles.batchStatTotal}>{batch.completed}/{batch.total} done{batch.failed > 0 ? `, ${batch.failed} failed` : ''}</span>
                    {batch.startedAt && <span className={styles.runTime}>{formatTime(batch.startedAt)}</span>}
                  </div>
                  <div className={styles.batchPrompt} title={batch.prompt}>
                    {batch.prompt}
                  </div>

                  {batch.failed > 0 && (
                    <>
                      <button
                        className={styles.batchErrorToggle}
                        onClick={() => setExpandedBatchId((prev) => prev === batch.id ? null : batch.id)}
                      >
                        <AlertTriangle size={12} />
                        {expandedBatchId === batch.id ? 'Hide errors' : `Show ${batch.failed} error${batch.failed === 1 ? '' : 's'}`}
                        {expandedBatchId === batch.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                      {expandedBatchId === batch.id && <BatchErrorPanel batch={batch} />}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>History</h2>
          {historyTotal > 0 && (
            <span className={styles.historyCount}>{historyTotal} runs</span>
          )}
        </div>

        {/* Filters */}
        <div className={styles.filtersRow}>
          <div className={styles.filterGroup}>
            <Filter size={14} className={styles.filterIcon} />

            <div className={styles.filterPills}>
              {(['all', 'completed', 'error', 'running'] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  className={`${styles.filterPill} ${statusFilter === s ? styles.filterPillActive : ''} ${s === 'error' && statusFilter === s ? styles.filterPillError : ''} ${s === 'running' && statusFilter === s ? styles.filterPillRunning : ''}`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === 'all' ? 'All status' : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            <span className={styles.filterDivider} />

            <div className={styles.filterPills}>
              {(['all', 'chat', 'cron_job', 'card_assignment'] as TriggerFilter[]).map((t) => (
                <button
                  key={t}
                  className={`${styles.filterPill} ${triggerFilter === t ? styles.filterPillActive : ''}`}
                  onClick={() => setTriggerFilter(t)}
                >
                  {t === 'all'
                    ? 'All triggers'
                    : t === 'cron_job'
                      ? 'Cron'
                      : t === 'card_assignment'
                        ? 'Card'
                        : 'Chat'}
                </button>
              ))}
            </div>

            {agentOptions.length > 1 && (
              <>
                <span className={styles.filterDivider} />
                <select
                  className={styles.agentSelect}
                  value={agentFilter}
                  onChange={(e) => setAgentFilter(e.target.value)}
                >
                  <option value="all">All agents</option>
                  {agentOptions.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </>
            )}
          </div>

          {hasActiveFilters && (
            <button className={styles.clearFilters} onClick={clearFilters}>
              <X size={12} />
              Clear filters
            </button>
          )}
        </div>

        {historyLoading && historyRuns.length === 0 ? (
          <div className={styles.runList}>
            <div className={styles.loadingState}>Loading runs...</div>
          </div>
        ) : historyRuns.length === 0 ? (
          <div className={styles.runList}>
            <div className={styles.emptyState}>
              {hasActiveFilters ? (
                <>
                  <Filter size={32} className={styles.emptyIcon} />
                  <div className={styles.emptyTitle}>No matching runs</div>
                  <div className={styles.emptyText}>Try adjusting your filters to see more results</div>
                </>
              ) : (
                <>
                  <div className={styles.emptyTitle}>No runs yet</div>
                  <div className={styles.emptyText}>Past agent executions will appear here</div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.runList}>
            <div className={styles.tableHeader}>
              <span></span>
              <span>Agent</span>
              <span>Trigger</span>
              <span>Status</span>
              <span>Started</span>
              <span>Duration</span>
              <span></span>
            </div>
            {historyRuns.map((run) => (
              <div key={run.id} className={styles.runEntry}>
                <div
                  className={styles.runRow}
                  onClick={(e) => toggleExpand(e, run.id)}
                  title={run.errorMessage || undefined}
                >
                  <span className={styles.expandToggle}>
                    {expandedRunId === run.id
                      ? <ChevronDown size={14} />
                      : <ChevronRight size={14} />}
                  </span>
                  <div className={styles.runAgent}>
                    <AgentAvatar
                      icon={agentAvatars[run.agentId]?.avatarIcon || 'spark'}
                      bgColor={agentAvatars[run.agentId]?.avatarBgColor || '#1a1a2e'}
                      logoColor={agentAvatars[run.agentId]?.avatarLogoColor || '#e94560'}
                      size={24}
                    />
                    <button
                      className={styles.runAgentNameBtn}
                      onClick={(e) => { e.stopPropagation(); navigate(`/agents?agentId=${run.agentId}`); }}
                      title="Open agent"
                    >
                      {run.agentName}
                    </button>
                  </div>
                  <TriggerBadge type={run.triggerType} />
                  <StatusBadge status={run.status} />
                  <span className={styles.runTime}>{formatTime(run.startedAt)}</span>
                  <span className={styles.runDuration}>
                    {run.status === 'running' ? (
                      <ElapsedTimer startedAt={run.startedAt} />
                    ) : run.durationMs != null ? (
                      formatDuration(run.durationMs)
                    ) : (
                      '—'
                    )}
                  </span>
                  <TriggerLink run={run} navigate={navigate} />
                </div>
                {expandedRunId === run.id && <RunLogPanel runId={run.id} runStatus={run.status} />}
              </div>
            ))}
            {historyRuns.length < historyTotal && (
              <div
                ref={historyLoadMoreRef}
                className={styles.historyAutoLoad}
                aria-hidden="true"
              >
                {loadingMoreHistory ? 'Loading more runs...' : ' '}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
