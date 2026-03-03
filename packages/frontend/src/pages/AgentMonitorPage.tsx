import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, MessageSquare, Clock, Zap, ChevronDown, ChevronRight, Terminal, AlertTriangle, ExternalLink, X, CheckCircle2, XCircle, Filter, BarChart3, Copy, Check, Trash2 } from 'lucide-react';
import { PageHeader } from '../layout';
import { api } from '../lib/api';
import { AgentAvatar } from '../components/AgentAvatar';
import { toast } from '../stores/toast';
import styles from './AgentMonitorPage.module.css';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  triggerType: 'chat' | 'cron' | 'card';
  status: 'running' | 'completed' | 'error';
  conversationId: string | null;
  cardId: string | null;
  cronJobId: string | null;
  errorMessage: string | null;
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
}

type StatusFilter = 'all' | 'completed' | 'error' | 'running';
type TriggerFilter = 'all' | 'chat' | 'cron' | 'card';

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

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - new Date(startedAt).getTime());
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return <span>{formatDuration(elapsed)}</span>;
}

function TriggerBadge({ type }: { type: AgentRun['triggerType'] }) {
  const config = {
    chat: { label: 'Chat', className: styles.triggerChat, icon: <MessageSquare size={12} /> },
    cron: { label: 'Cron', className: styles.triggerCron, icon: <Clock size={12} /> },
    card: { label: 'Card', className: styles.triggerCard, icon: <Zap size={12} /> },
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

function RunLogPanel({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return <div className={styles.logPanel}><span className={styles.logLoading}>Loading logs...</span></div>;
  }

  if (!detail) {
    return <div className={styles.logPanel}><span className={styles.logEmpty}>Failed to load run details</span></div>;
  }

  const hasStdout = detail.stdout && detail.stdout.trim().length > 0;
  const hasStderr = detail.stderr && detail.stderr.trim().length > 0;
  const hasError = detail.errorMessage && detail.errorMessage.trim().length > 0;
  const hasContent = hasStdout || hasStderr || hasError;

  return (
    <div className={styles.logPanel}>
      {hasError && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <AlertTriangle size={13} />
            <span>Error</span>
            <LogCopyButton text={detail.errorMessage!} />
          </div>
          <pre className={`${styles.logPre} ${styles.logPreError}`}>{detail.errorMessage}</pre>
        </div>
      )}
      {hasStdout && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <Terminal size={13} />
            <span>stdout</span>
            <LogCopyButton text={detail.stdout!} />
          </div>
          <pre className={styles.logPre}>{detail.stdout}</pre>
        </div>
      )}
      {hasStderr && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <AlertTriangle size={13} />
            <span>stderr</span>
            <LogCopyButton text={detail.stderr!} />
          </div>
          <pre className={`${styles.logPre} ${styles.logPreError}`}>{detail.stderr}</pre>
        </div>
      )}
      {!hasContent && (
        <span className={styles.logEmpty}>No logs available for this run</span>
      )}
    </div>
  );
}

export function AgentMonitorPage() {
  useDocumentTitle('Monitor');
  const navigate = useNavigate();
  const [activeRuns, setActiveRuns] = useState<AgentRun[]>([]);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [agentAvatars, setAgentAvatars] = useState<Record<string, AgentAvatarInfo>>({});
  const [loading, setLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [killingRunId, setKillingRunId] = useState<string | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const prevActiveCountRef = useRef(0);

  // Filter state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const fetchActive = useCallback(async () => {
    try {
      const res = await api<{ entries: AgentRun[] }>('/agent-runs/active');
      setActiveRuns(res.entries);
      return res.entries.length;
    } catch {
      return 0;
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (triggerFilter !== 'all') params.set('triggerType', triggerFilter);
      if (agentFilter !== 'all') params.set('agentId', agentFilter);
      const res = await api<{ entries: AgentRun[]; total: number }>(`/agent-runs?${params.toString()}`);
      setHistoryRuns(res.entries);
      setHistoryTotal(res.total);
    } catch {
      // best effort
    }
  }, [statusFilter, triggerFilter, agentFilter]);

  // Fetch agents for avatar info
  useEffect(() => {
    api<{ entries: AgentAvatarInfo[] }>('/agents')
      .then((res) => {
        const map: Record<string, AgentAvatarInfo> = {};
        for (const a of res.entries) map[a.id] = a;
        setAgentAvatars(map);
      })
      .catch(() => {});
  }, []);

  // Initial load
  useEffect(() => {
    Promise.all([fetchActive(), fetchHistory()]).then(() => setLoading(false));
  }, [fetchActive, fetchHistory]);

  // Poll active runs every 4 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      const count = await fetchActive();
      // If a run just completed, refresh history
      if (count < prevActiveCountRef.current) {
        fetchHistory();
      }
      prevActiveCountRef.current = count;
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchActive, fetchHistory]);

  // Compute stats from history (all runs, not filtered)
  const stats = useMemo(() => {
    const completed = historyRuns.filter(r => r.status === 'completed').length;
    const errors = historyRuns.filter(r => r.status === 'error').length;
    const total = historyRuns.length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const durations = historyRuns
      .filter(r => r.durationMs != null)
      .map(r => r.durationMs as number);
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    return { total: historyTotal, completed, errors, successRate, avgDuration };
  }, [historyRuns, historyTotal]);

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
      await Promise.all([fetchActive(), fetchHistory()]);
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
        await fetchHistory();
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
        <div className={styles.skeletonStats}>
          <div className={styles.skeletonStatCard} />
          <div className={styles.skeletonStatCard} />
          <div className={styles.skeletonStatCard} />
          <div className={styles.skeletonStatCard} />
        </div>
        <div className={styles.skeletonSection} />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <PageHeader title="Monitor" description="Track agent executions in real-time" />

      {/* Stats Row */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <div className={styles.statIcon} style={{ background: 'rgba(59, 130, 246, 0.1)', color: 'var(--color-info)' }}>
            <BarChart3 size={18} />
          </div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{stats.total}</div>
            <div className={styles.statLabel}>Total runs</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon} style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--color-success)' }}>
            <CheckCircle2 size={18} />
          </div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{stats.successRate}%</div>
            <div className={styles.statLabel}>Success rate</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon} style={{ background: 'rgba(239, 68, 68, 0.08)', color: 'var(--color-error)' }}>
            <XCircle size={18} />
          </div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{stats.errors}</div>
            <div className={styles.statLabel}>Errors</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon} style={{ background: 'rgba(139, 92, 246, 0.1)', color: '#8B5CF6' }}>
            <Clock size={18} />
          </div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{stats.avgDuration > 0 ? formatDuration(stats.avgDuration) : '—'}</div>
            <div className={styles.statLabel}>Avg duration</div>
          </div>
        </div>
      </div>

      {historyTotal > historyRuns.length && (
        <p className={styles.statsNote}>
          Stats computed from the {historyRuns.length} most recent runs — {historyTotal} total match the current filters.
        </p>
      )}

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
              <div
                key={run.id}
                className={`${styles.runRow} ${styles.activeRunRow}`}
              >
                <div className={styles.runAgent}>
                  <AgentAvatar
                    icon={agentAvatars[run.agentId]?.avatarIcon || 'spark'}
                    bgColor={agentAvatars[run.agentId]?.avatarBgColor || '#1a1a2e'}
                    logoColor={agentAvatars[run.agentId]?.avatarLogoColor || '#e94560'}
                    size={24}
                  />
                  <button
                    className={styles.runAgentNameBtn}
                    onClick={(e) => { e.stopPropagation(); navigate(`/agents?id=${run.agentId}`); }}
                    title="Open agent settings"
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
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>History</h2>
          {historyTotal > 0 && (
            <span className={styles.historyCount}>{historyTotal} runs</span>
          )}
          <div className={styles.sectionHeaderActions}>
            <button
              className={styles.cleanupButton}
              onClick={() => cleanupRuns(30)}
              disabled={cleaningUp}
              title="Delete completed and error runs older than 30 days"
            >
              <Trash2 size={13} />
              {cleaningUp ? 'Cleaning…' : 'Clean up (30d+)'}
            </button>
          </div>
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
              {(['all', 'chat', 'cron', 'card'] as TriggerFilter[]).map((t) => (
                <button
                  key={t}
                  className={`${styles.filterPill} ${triggerFilter === t ? styles.filterPillActive : ''}`}
                  onClick={() => setTriggerFilter(t)}
                >
                  {t === 'all' ? 'All triggers' : t.charAt(0).toUpperCase() + t.slice(1)}
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

        {historyRuns.length === 0 ? (
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
                      onClick={(e) => { e.stopPropagation(); navigate(`/agents?id=${run.agentId}`); }}
                      title="Open agent settings"
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
                {expandedRunId === run.id && <RunLogPanel runId={run.id} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
