import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, MessageSquare, Clock, Zap, ChevronDown, ChevronRight, Terminal, AlertTriangle, ExternalLink } from 'lucide-react';
import { PageHeader } from '../layout';
import { api } from '../lib/api';
import { AgentAvatar } from '../components/AgentAvatar';
import styles from './AgentMonitorPage.module.css';

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
  avatarIcon: string;
  avatarBgColor: string;
  avatarLogoColor: string;
}

interface AgentRunDetail extends AgentRun {
  stdout: string | null;
  stderr: string | null;
}

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
          </div>
          <pre className={`${styles.logPre} ${styles.logPreError}`}>{detail.errorMessage}</pre>
        </div>
      )}
      {hasStdout && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <Terminal size={13} />
            <span>stdout</span>
          </div>
          <pre className={styles.logPre}>{detail.stdout}</pre>
        </div>
      )}
      {hasStderr && (
        <div className={styles.logSection}>
          <div className={styles.logSectionHeader}>
            <AlertTriangle size={13} />
            <span>stderr</span>
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
  const navigate = useNavigate();
  const [activeRuns, setActiveRuns] = useState<AgentRun[]>([]);
  const [historyRuns, setHistoryRuns] = useState<AgentRun[]>([]);
  const [agentAvatars, setAgentAvatars] = useState<Record<string, AgentAvatarInfo>>({});
  const [loading, setLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const prevActiveCountRef = useRef(0);

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
      const res = await api<{ entries: AgentRun[] }>('/agent-runs?limit=50');
      setHistoryRuns(res.entries);
    } catch {
      // best effort
    }
  }, []);

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

  const toggleExpand = (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    setExpandedRunId((prev) => (prev === runId ? null : runId));
  };

  if (loading) {
    return (
      <div className={styles.wrapper}>
        <PageHeader title="Monitor" description="Track agent executions in real-time" />
        <div className={styles.loadingState}>Loading...</div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <PageHeader title="Monitor" description="Track agent executions in real-time" />

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
                className={styles.runRow}
              >
                <div className={styles.runAgent}>
                  <AgentAvatar
                    icon={agentAvatars[run.agentId]?.avatarIcon || 'spark'}
                    bgColor={agentAvatars[run.agentId]?.avatarBgColor || '#1a1a2e'}
                    logoColor={agentAvatars[run.agentId]?.avatarLogoColor || '#e94560'}
                    size={24}
                  />
                  <span className={styles.runAgentName}>{run.agentName}</span>
                </div>
                <TriggerBadge type={run.triggerType} />
                <StatusBadge status={run.status} />
                <span className={styles.runTime}>{formatTime(run.startedAt)}</span>
                <span className={styles.runDuration}>
                  <ElapsedTimer startedAt={run.startedAt} />
                </span>
                <TriggerLink run={run} navigate={navigate} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>History</h2>
        </div>

        {historyRuns.length === 0 ? (
          <div className={styles.runList}>
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>No runs yet</div>
              <div className={styles.emptyText}>Past agent executions will appear here</div>
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
                    <span className={styles.runAgentName}>{run.agentName}</span>
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
