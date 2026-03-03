import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Pencil, Trash2, LogIn, ChevronDown, ChevronUp,
  Activity, Loader2, Clock, ExternalLink,
} from 'lucide-react';
import { api } from '../../lib/api';
import { TimeAgo } from '../../components/TimeAgo';
import styles from './ActivityLogTab.module.css';

/* ── Types ── */

interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface PaginatedResponse<T> {
  total: number;
  limit: number;
  offset: number;
  entries: T[];
}

/* ── Constants ── */

const PAGE_SIZE = 30;

const ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  login: 'Logged in',
  logout: 'Logged out',
  register: 'Registered',
};

const ENTITY_LABELS: Record<string, string> = {
  card: 'Card',
  card_comment: 'Comment',
  collection: 'Collection',
  board: 'Board',
  board_column: 'Column',
  board_card: 'Board card',
  conversation: 'Conversation',
  conversation_message: 'Message',
  agent: 'Agent',
  agent_run: 'Agent run',
  connector: 'Connector',
  api_key: 'API key',
  user: 'Account',
  workspace: 'Workspace',
  tag: 'Tag',
  quick_reply_template: 'Template',
  telegram_message_template: 'Telegram template',
  backup: 'Backup',
};

const ENTITY_TYPE_OPTIONS = [
  '', 'card', 'card_comment', 'collection', 'board', 'board_column', 'board_card',
  'conversation', 'conversation_message', 'agent', 'agent_run',
  'connector', 'api_key', 'user', 'workspace', 'tag',
];

const ACTION_OPTIONS = ['', 'create', 'update', 'delete', 'login', 'logout'];

function getActionIcon(action: string) {
  switch (action) {
    case 'create': return <Plus size={14} />;
    case 'update': return <Pencil size={14} />;
    case 'delete': return <Trash2 size={14} />;
    case 'login':
    case 'logout':
    case 'register':
      return <LogIn size={14} />;
    default: return <Activity size={14} />;
  }
}

/** Returns a front-end route for navigable entity types, or null for non-navigable ones. */
function getEntityUrl(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'card': return `/cards/${entityId}`;
    case 'collection': return `/collections/${entityId}`;
    case 'board': return `/boards/${entityId}`;
    case 'agent': return `/agents`;
    default: return null;
  }
}

/** Extracts a human-readable entity name from the changes object, if present. */
function getEntityName(changes: Record<string, unknown> | null): string | null {
  if (!changes) return null;
  if (typeof changes.name === 'string' && changes.name) return changes.name;
  if (typeof changes.subject === 'string' && changes.subject) return changes.subject;
  if (typeof changes.title === 'string' && changes.title) return changes.title;
  return null;
}

function getActionStyle(action: string): string {
  switch (action) {
    case 'create': return styles.actionCreate;
    case 'update': return styles.actionUpdate;
    case 'delete': return styles.actionDelete;
    case 'login':
    case 'logout':
    case 'register':
      return styles.actionLogin;
    default: return styles.actionOther;
  }
}

function formatChanges(changes: Record<string, unknown>): string {
  const entries = Object.entries(changes);
  if (entries.length === 0) return '(no details)';
  return entries
    .map(([key, value]) => {
      const val = typeof value === 'string'
        ? (value.length > 120 ? value.slice(0, 120) + '...' : value)
        : JSON.stringify(value);
      return `${key}: ${val}`;
    })
    .join('\n');
}

function formatEntryDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatEntryTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getDateKey(dateStr: string): string {
  return new Date(dateStr).toDateString();
}

/* ── Component ── */

export function ActivityLogTab() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [entityTypeFilter, setEntityTypeFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const fetchLogs = useCallback(async (offset: number, append: boolean) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);

    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      if (entityTypeFilter) params.set('entityType', entityTypeFilter);
      if (actionFilter) params.set('action', actionFilter);

      const res = await api<PaginatedResponse<AuditLogEntry>>(`/audit-logs?${params}`);
      if (append) {
        setEntries((prev) => [...prev, ...res.entries]);
      } else {
        setEntries(res.entries);
      }
      setTotal(res.total);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [entityTypeFilter, actionFilter]);

  useEffect(() => {
    fetchLogs(0, false);
  }, [fetchLogs]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasMore = entries.length < total;

  // Group entries by date
  const dateGroups: { date: string; label: string; entries: AuditLogEntry[] }[] = [];
  let currentDateKey = '';
  for (const entry of entries) {
    const dk = getDateKey(entry.createdAt);
    if (dk !== currentDateKey) {
      currentDateKey = dk;
      dateGroups.push({ date: dk, label: formatEntryDate(entry.createdAt), entries: [] });
    }
    dateGroups[dateGroups.length - 1].entries.push(entry);
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Activity Log</h3>
        <p className={styles.description}>
          Track all actions in your workspace — card changes, logins, agent runs, and more.
        </p>
      </div>

      <div className={styles.filters}>
        <select
          className={styles.filterSelect}
          value={entityTypeFilter}
          onChange={(e) => setEntityTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {ENTITY_TYPE_OPTIONS.filter(Boolean).map((t) => (
            <option key={t} value={t}>{ENTITY_LABELS[t] || t}</option>
          ))}
        </select>
        <select
          className={styles.filterSelect}
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.filter(Boolean).map((a) => (
            <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
          ))}
        </select>
        {!loading && (
          <span className={styles.totalCount}>{total.toLocaleString()} total events</span>
        )}
      </div>

      {loading ? (
        <div className={styles.loadingState}>
          <Loader2 size={18} className={styles.spinner} style={{ marginRight: 8 }} />
          Loading activity...
        </div>
      ) : entries.length === 0 ? (
        <div className={styles.emptyState}>
          <Clock size={32} className={styles.emptyIcon} />
          <span className={styles.emptyTitle}>No activity found</span>
          <span className={styles.emptyText}>
            {entityTypeFilter || actionFilter
              ? 'Try adjusting your filters to see more results.'
              : 'Activity will appear here as you use the workspace.'}
          </span>
        </div>
      ) : (
        <div className={styles.timeline}>
          {dateGroups.map((group) => (
            <div key={group.date}>
              <div className={styles.dateSeparator}>
                <span className={styles.dateSeparatorLine} />
                <span className={styles.dateSeparatorLabel}>{group.label}</span>
                <span className={styles.dateSeparatorLine} />
              </div>
              {group.entries.map((entry) => {
                const isExpanded = expandedIds.has(entry.id);
                const hasChanges = entry.changes && Object.keys(entry.changes).length > 0;
                return (
                  <div key={entry.id} className={styles.logEntry}>
                    <div className={`${styles.actionIcon} ${getActionStyle(entry.action)}`}>
                      {getActionIcon(entry.action)}
                    </div>
                    <div className={styles.entryContent}>
                      <div className={styles.entryMain}>
                        <span className={styles.entryAction}>
                          {ACTION_LABELS[entry.action] || entry.action}
                        </span>
                        <span className={styles.entityTypeBadge}>
                          {ENTITY_LABELS[entry.entityType] || entry.entityType}
                        </span>
                        {entry.entityId && (() => {
                          const url = getEntityUrl(entry.entityType, entry.entityId);
                          const name = getEntityName(entry.changes);
                          if (url) {
                            return (
                              <Link to={url} className={styles.entityLink} title={`Go to ${ENTITY_LABELS[entry.entityType] || entry.entityType}`}>
                                {name ?? <span className={styles.entityIdShort}>{entry.entityId.slice(0, 8)}</span>}
                                <ExternalLink size={10} className={styles.entityLinkIcon} />
                              </Link>
                            );
                          }
                          if (name) {
                            return <span className={styles.entityName}>{name}</span>;
                          }
                          return null;
                        })()}
                      </div>
                      <div className={styles.entryMeta}>
                        <TimeAgo date={entry.createdAt} />
                        {entry.ipAddress && (
                          <span className={styles.entryIp}>{entry.ipAddress}</span>
                        )}
                      </div>
                      {hasChanges && (
                        <>
                          <button
                            className={styles.changesToggle}
                            onClick={() => toggleExpand(entry.id)}
                          >
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {isExpanded ? 'Hide details' : 'Show details'}
                          </button>
                          {isExpanded && (
                            <div className={styles.changesBox}>
                              {formatChanges(entry.changes!)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <span className={styles.entryTime} title={new Date(entry.createdAt).toLocaleString()}>
                      {formatEntryTime(entry.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {hasMore && (
            <div className={styles.loadMore}>
              <button
                className={styles.loadMoreBtn}
                onClick={() => fetchLogs(entries.length, true)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <><Loader2 size={14} className={styles.spinner} /> Loading...</>
                ) : (
                  <>Load more ({total - entries.length} remaining)</>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
