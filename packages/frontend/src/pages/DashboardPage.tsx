import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FolderOpen,
  Kanban,
  FileText,
  Bot,
  ArrowRight,
  Activity,
  MessageSquare,
  Clock,
  Zap,
  CheckCircle2,
  XCircle,
  Plus,
  Search,
  X,
  Inbox,
  Mail,
  MailOpen,
  StickyNote,
  ChevronDown,
  ArrowRightCircle,
  ExternalLink,
  Copy,
  RefreshCw,
  WifiOff,
  MessagesSquare,
} from 'lucide-react';
import { PageHeader } from '../layout';
import { AgentAvatar } from '../components/AgentAvatar';
import { useAuth } from '../stores/useAuth';
import { useWorkspace } from '../stores/WorkspaceContext';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { TimeAgo } from '../components/TimeAgo';
import { getRecentVisits, removeRecentVisit, type RecentVisit } from '../lib/recent-visits';
import { stripMarkdown } from '../lib/file-utils';
import { CardQuickView } from './boards/CardQuickView';
import styles from './DashboardPage.module.css';

interface CardAssignee {
  id: string;
  firstName: string;
  lastName: string;
  type?: 'user' | 'agent';
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

interface CardItem {
  id: string;
  name: string;
  description: string | null;
  collectionId: string;
  assignee: CardAssignee | null;
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConversationContact {
  id: string;
  firstName: string;
  lastName: string | null;
}

interface ConversationPreview {
  id: string;
  contactId: string;
  channelType: string;
  status: 'open' | 'closed' | 'archived';
  subject: string | null;
  isUnread: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  createdAt: string;
  contact: ConversationContact | null;
}

type AgentRunTriggerType = 'chat' | 'cron_job' | 'card_assignment';

interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  triggerType: AgentRunTriggerType;
  status: 'running' | 'completed' | 'error';
  conversationId: string | null;
  cardId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

interface RecentAgentChat {
  id: string;
  subject: string | null;
  lastMessageAt: string | null;
  isUnread: boolean;
  agentId: string;
  agentName: string;
  agentAvatarIcon: string | null;
  agentAvatarBgColor: string | null;
  agentAvatarLogoColor: string | null;
}

const STAT_CARDS = [
  { key: 'collections', label: 'Collections', to: '/collections', icon: FolderOpen, bg: 'rgba(59,130,246,0.1)', color: 'var(--color-info)' },
  { key: 'boards', label: 'Boards', to: '/boards', icon: Kanban, bg: 'rgba(139,92,246,0.1)', color: '#8B5CF6' },
  { key: 'cards', label: 'Cards', to: '/collections', icon: FileText, bg: 'rgba(245,158,11,0.1)', color: 'var(--color-warning)' },
  { key: 'agents', label: 'Agents', to: '/agents', icon: Bot, bg: 'rgba(16,185,129,0.1)', color: '#10B981' },
] as const;

const TRIGGER_CONFIG: Record<AgentRunTriggerType, { label: string; icon: React.ComponentType<{ size?: number }> }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  cron_job: { label: 'Cron', icon: Clock },
  card_assignment: { label: 'Card', icon: Zap },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}


function formatRefreshTimestamp(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function getContactDisplayName(contact: ConversationContact | null): string {
  if (!contact) return 'Unknown';
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ');
}

function getContactInitials(contact: ConversationContact | null): string {
  if (!contact) return '?';
  const first = contact.firstName?.[0] || '';
  const last = contact.lastName?.[0] || '';
  return (first + last).toUpperCase() || '?';
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  internal: 'Internal',
  email: 'Email',
  web_chat: 'Web Chat',
  other: 'Other',
};

const RECENT_VISIT_ICONS: Record<RecentVisit['type'], React.ComponentType<{ size?: number }>> = {
  card: FileText,
  board: Kanban,
  collection: FolderOpen,
};

const RECENT_VISIT_TYPE_LABEL: Record<RecentVisit['type'], string> = {
  card: 'Card',
  board: 'Board',
  collection: 'Collection',
};

function formatVisitTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeWorkspaceId, activeWorkspace } = useWorkspace();
  const [stats, setStats] = useState({ collections: 0, boards: 0, cards: 0, agents: 0 });
  const [recentCards, setRecentCards] = useState<CardItem[]>([]);
  const [myCards, setMyCards] = useState<CardItem[]>([]);
  const [recentRuns, setRecentRuns] = useState<AgentRun[]>([]);
  const [recentConversations, setRecentConversations] = useState<ConversationPreview[]>([]);
  const [unreadConversationCount, setUnreadConversationCount] = useState(0);
  const [recentAgentChats, setRecentAgentChats] = useState<RecentAgentChat[]>([]);
  const [recentVisits, setRecentVisits] = useState<RecentVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [collections, setCollections] = useState<{ id: string; name: string; isGeneral?: boolean }[]>([]);
  const [inlineAddName, setInlineAddName] = useState('');
  const [inlineAddSubmitting, setInlineAddSubmitting] = useState(false);
  const inlineAddRef = useRef<HTMLInputElement>(null);

  // Scratchpad
  const SCRATCHPAD_KEY = 'dashboard-scratchpad';
  const SCRATCHPAD_COLLAPSED_KEY = 'dashboard-scratchpad-collapsed';
  const [scratchpad, setScratchpad] = useState(() => localStorage.getItem(SCRATCHPAD_KEY) ?? '');
  const [scratchpadCollapsed, setScratchpadCollapsed] = useState(
    () => localStorage.getItem(SCRATCHPAD_COLLAPSED_KEY) === 'true',
  );
  const [convertingScratchpad, setConvertingScratchpad] = useState(false);
  const scratchpadRef = useRef<HTMLTextAreaElement>(null);

  // Card context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(false);
    const wsParam = activeWorkspaceId ? `&workspaceId=${activeWorkspaceId}` : '';
    try {
      const [collectionsRes, boardsRes, cardsRes, agentsRes, runsRes, myCardsRes, conversationsRes, unreadRes, collectionsListRes, agentChatsRes] =
        await Promise.all([
          api<{ total: number }>(`/collections?limit=0${wsParam}`),
          api<{ total: number }>(`/boards?limit=0${wsParam}`),
          api<{ entries: CardItem[]; total: number }>(`/cards?limit=6${wsParam}`),
          api<{ total: number }>('/agents?limit=1'),
          api<{ entries: AgentRun[] }>('/agent-runs?limit=6').catch(() => ({ entries: [] })),
          user
            ? api<{ entries: CardItem[] }>(`/cards?assigneeId=${user.id}&limit=8${wsParam}`).catch(() => ({ entries: [] }))
            : Promise.resolve({ entries: [] as CardItem[] }),
          api<{ entries: ConversationPreview[] }>('/conversations?limit=5&sort=lastMessageAt:desc').catch(() => ({ entries: [] })),
          api<{ total: number }>('/conversations?isUnread=true&countOnly=true').catch(() => ({ total: 0 })),
          api<{ entries: { id: string; name: string; isGeneral?: boolean }[] }>(`/collections?limit=50${wsParam}`).catch(() => ({ entries: [] })),
          api<{ entries: RecentAgentChat[] }>('/agent-chat/recent?limit=8').catch(() => ({ entries: [] })),
        ]);

      setStats({
        collections: collectionsRes.total,
        boards: boardsRes.total,
        cards: cardsRes.total,
        agents: agentsRes.total,
      });
      setRecentCards(cardsRes.entries);
      setMyCards(myCardsRes.entries);
      setRecentRuns(runsRes.entries);
      setRecentConversations(conversationsRes.entries);
      setUnreadConversationCount(unreadRes.total);
      setCollections(collectionsListRes.entries);
      setRecentAgentChats(agentChatsRes.entries);
      setLastRefreshed(Date.now());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, activeWorkspaceId]);

  const refreshRuns = useCallback(async () => {
    try {
      const runsRes = await api<{ entries: AgentRun[] }>('/agent-runs?limit=6').catch(() => ({ entries: [] }));
      setRecentRuns(runsRes.entries);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    setRecentVisits(getRecentVisits());
  }, [fetchDashboard]);

  // Auto-refresh agent activity every 30s so running agents appear live
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void refreshRuns();
    }, 30_000);
    return () => clearInterval(id);
  }, [refreshRuns]);

  const handleCardUpdated = useCallback((cardId: string, updates: { name?: string; description?: string | null; assigneeId?: string | null; customFields?: Record<string, unknown> }) => {
    const patch = (cards: CardItem[]) =>
      cards.map((c) => (c.id === cardId ? { ...c, ...updates } : c));
    setRecentCards(patch);
    setMyCards(patch);
  }, []);

  const openQuickView = useCallback((e: React.MouseEvent, cardId: string) => {
    // Allow ctrl/cmd+click to open in new tab normally
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setQuickViewCardId(cardId);
  }, []);

  const handleInlineAdd = useCallback(async () => {
    const trimmed = inlineAddName.trim();
    if (!trimmed || inlineAddSubmitting || !user) return;
    const col = collections.find((c) => c.isGeneral) ?? collections[0];
    if (!col) {
      toast.error('No collection available. Create a collection first.');
      return;
    }
    setInlineAddSubmitting(true);
    try {
      const card = await api<CardItem>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: col.id,
          name: trimmed,
          description: null,
          assigneeId: user.id,
        }),
      });
      setInlineAddName('');
      setMyCards((prev) => [card, ...prev]);
      inlineAddRef.current?.focus();
      toast.success('Card created', {
        action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
      });
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    } finally {
      setInlineAddSubmitting(false);
    }
  }, [inlineAddName, inlineAddSubmitting, user, collections, navigate]);

  const handleScratchpadChange = useCallback((value: string) => {
    setScratchpad(value);
    localStorage.setItem(SCRATCHPAD_KEY, value);
  }, []);

  const toggleScratchpadCollapsed = useCallback(() => {
    setScratchpadCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SCRATCHPAD_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const handleConvertScratchpadToCard = useCallback(async () => {
    const text = scratchpad.trim();
    if (!text || convertingScratchpad || !user) return;
    const col = collections.find((c) => c.isGeneral) ?? collections[0];
    if (!col) {
      toast.error('No collection available. Create a collection first.');
      return;
    }
    // Use first line as card name, rest as description
    const lines = text.split('\n');
    const name = lines[0].slice(0, 200);
    const description = lines.slice(1).join('\n').trim() || null;
    setConvertingScratchpad(true);
    try {
      const card = await api<CardItem>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: col.id,
          name,
          description,
          assigneeId: user.id,
        }),
      });
      handleScratchpadChange('');
      setMyCards((prev) => [card, ...prev]);
      toast.success('Note converted to card', {
        action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
      });
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    } finally {
      setConvertingScratchpad(false);
    }
  }, [scratchpad, convertingScratchpad, user, collections, navigate, handleScratchpadChange]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleCardContextMenu = useCallback((e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, cardId });
  }, []);

  const visibleMyCards = useMemo(() => [...myCards].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [myCards]);

  // Combined card IDs for quick-view navigation (my cards first, then recent, deduplicated)
  const dashboardCardIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const c of visibleMyCards) {
      if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }
    }
    for (const c of recentCards) {
      if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }
    }
    return ids;
  }, [visibleMyCards, recentCards]);

  const handleRefresh = useCallback(() => {
    void fetchDashboard(true);
    setRecentVisits(getRecentVisits());
  }, [fetchDashboard]);

  // Re-render the "Updated X ago" timestamp periodically
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastRefreshed) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastRefreshed]);

  const greeting = user ? `Welcome back, ${user.firstName}` : 'Dashboard';

  return (
    <div className={styles.wrapper}>
      <PageHeader
        title={greeting}
        description={activeWorkspace ? `Overview of ${activeWorkspace.name}` : 'Overview of your workspace'}
        actions={
          <div className={styles.headerActions}>
            {lastRefreshed && !loading && (
              <span className={styles.lastRefreshed}>
                Updated {formatRefreshTimestamp(lastRefreshed)}
              </span>
            )}
            <button
              className={`${styles.refreshBtn}${refreshing ? ` ${styles.refreshBtnSpinning}` : ''}`}
              onClick={handleRefresh}
              disabled={refreshing || loading}
              title="Refresh dashboard"
              aria-label="Refresh dashboard"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        }
      />

      {loading ? (
        <div className={styles.loadingState}>
          <div className={styles.skeletonGrid}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonCard} />
            ))}
          </div>
          <div className={styles.skeletonPanels}>
            <div className={styles.skeletonPanel} />
            <div className={styles.skeletonPanel} />
          </div>
        </div>
      ) : loadError ? (
        <div className={styles.errorState}>
          <div className={styles.errorIcon}>
            <WifiOff size={40} strokeWidth={1.3} />
          </div>
          <h3 className={styles.errorTitle}>Unable to load dashboard</h3>
          <p className={styles.errorDescription}>
            Could not connect to the server. Check your connection and try again.
          </p>
          <button className={styles.errorRetryBtn} onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? styles.refreshBtnSpinning : ''} />
            {refreshing ? 'Retrying...' : 'Try again'}
          </button>
        </div>
      ) : (
        <>
          <div className={styles.statsGrid}>
            {STAT_CARDS.map((sc) => (
              <Link
                key={sc.key}
                to={sc.to}
                className={styles.statCard}
              >
                <div
                  className={styles.statIcon}
                  style={{ background: sc.bg, color: sc.color }}
                >
                  <sc.icon size={20} />
                </div>
                <div className={styles.statContent}>
                  <div className={styles.statValue}>{stats[sc.key]}</div>
                  <div className={styles.statLabel}>{sc.label}</div>
                </div>
              </Link>
            ))}
          </div>

          {(recentVisits.length > 0 || recentAgentChats.length > 0) && (
            <div className={styles.jumpBackIn}>
              <div className={styles.jumpBackInHeader}>
                <span className={styles.jumpBackInTitle}>Jump back in</span>
              </div>
              <div className={styles.jumpBackInList}>
                {recentAgentChats.length > 0 && (() => {
                  const chat = recentAgentChats[0];
                  return (
                    <div key={`agent-chat-${chat.id}`} className={styles.jumpBackInItemWrapper}>
                      <Link
                        to={`/agents?agentId=${chat.agentId}&conversationId=${chat.id}`}
                        className={styles.jumpBackInItem}
                      >
                        <div className={styles.jumpBackInIcon}>
                          <AgentAvatar
                            icon={chat.agentAvatarIcon || 'spark'}
                            bgColor={chat.agentAvatarBgColor || '#1a1a2e'}
                            logoColor={chat.agentAvatarLogoColor || '#e94560'}
                            size={18}
                          />
                        </div>
                        <div className={styles.jumpBackInContent}>
                          <span className={styles.jumpBackInName}>{chat.subject || chat.agentName}</span>
                          <span className={styles.jumpBackInType}>
                            Agent Chat{chat.lastMessageAt ? <> &middot; <TimeAgo date={chat.lastMessageAt} /></> : ''}
                          </span>
                        </div>
                      </Link>
                    </div>
                  );
                })()}
                {recentVisits.slice(0, 6).map((visit) => {
                  const Icon = RECENT_VISIT_ICONS[visit.type];
                  const typeLabel = RECENT_VISIT_TYPE_LABEL[visit.type];
                  return (
                    <div key={`${visit.type}-${visit.id}`} className={styles.jumpBackInItemWrapper}>
                      <Link to={visit.path} className={styles.jumpBackInItem}>
                        <div className={styles.jumpBackInIcon}>
                          <Icon size={14} />
                        </div>
                        <div className={styles.jumpBackInContent}>
                          <span className={styles.jumpBackInName}>{visit.name}</span>
                          <span className={styles.jumpBackInType}>{typeLabel} &middot; {formatVisitTime(visit.visitedAt)}</span>
                        </div>
                      </Link>
                      <button
                        className={styles.jumpBackInRemove}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRecentVisit(visit.type, visit.id);
                          setRecentVisits((prev) => prev.filter((v) => !(v.type === visit.type && v.id === visit.id)));
                        }}
                        title="Remove"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className={styles.myCardsSection}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>My Cards</h2>
              <div className={styles.myCardsHeaderRight}>
                <Link to="/my-cards" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
                <button
                  className={styles.myCardsAddBtn}
                  onClick={() => window.dispatchEvent(new CustomEvent('open-quick-create'))}
                  title="Create a new card"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            <div className={styles.inlineAddRow}>
              <Plus size={14} className={styles.inlineAddIcon} />
              <input
                ref={inlineAddRef}
                className={styles.inlineAddInput}
                placeholder="Add a card... (press Enter)"
                value={inlineAddName}
                onChange={(e) => setInlineAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleInlineAdd();
                  }
                  if (e.key === 'Escape') {
                    setInlineAddName('');
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                disabled={inlineAddSubmitting}
              />
              {inlineAddName.trim() && (
                <button className={styles.inlineAddSubmit} onClick={() => void handleInlineAdd()} disabled={inlineAddSubmitting}>
                  {inlineAddSubmitting ? 'Adding...' : 'Add'}
                </button>
              )}
            </div>
            {visibleMyCards.length === 0 ? (
              <div className={styles.myCardsEmpty}>
                <FileText size={18} className={styles.myCardsEmptyIcon} />
                <span>No cards assigned to you yet</span>
              </div>
            ) : (
              <div className={styles.myCardsList}>
                {visibleMyCards.map((card) => (
                  <div key={card.id} className={styles.myCardRow} onContextMenu={(e) => handleCardContextMenu(e, card.id)}>
                    <Link
                      to={`/cards/${card.id}`}
                      className={`${styles.myCardItem}${quickViewCardId === card.id ? ` ${styles.myCardItemActive}` : ''}`}
                      onClick={(e) => openQuickView(e, card.id)}
                    >
                      <div className={styles.myCardInfo}>
                        <div className={styles.myCardName}>{card.name}</div>
                        {card.description && (
                          <div className={styles.myCardDesc}>{stripMarkdown(card.description)}</div>
                        )}
                      </div>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Inbox Preview */}
          <div className={styles.inboxPreview}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>
                <Inbox size={16} className={styles.inboxIcon} />
                Inbox
                {unreadConversationCount > 0 && (
                  <span className={styles.unreadBadge}>{unreadConversationCount}</span>
                )}
              </h2>
              <Link to="/inbox" className={styles.viewAllLink}>
                View all <ArrowRight size={14} />
              </Link>
            </div>
            {recentConversations.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <MessageSquare size={32} />
                </div>
                <div className={styles.emptyTitle}>No conversations yet</div>
                <div className={styles.emptyDescription}>
                  Conversations from your connected channels will appear here.
                </div>
                <Link to="/connectors" className={styles.emptyAction}>
                  <Plus size={14} /> Set up a channel
                </Link>
              </div>
            ) : (
              <div className={styles.inboxList}>
                {recentConversations.map((conv) => (
                  <Link
                    key={conv.id}
                    to={`/inbox?id=${conv.id}`}
                    className={`${styles.inboxItem}${conv.isUnread ? ` ${styles.inboxItemUnread}` : ''}`}
                  >
                    <div className={styles.inboxAvatar}>
                      {getContactInitials(conv.contact)}
                    </div>
                    <div className={styles.inboxContent}>
                      <div className={styles.inboxTopRow}>
                        <span className={styles.inboxContactName}>
                          {getContactDisplayName(conv.contact)}
                        </span>
                        <span className={styles.inboxChannel}>
                          {CHANNEL_LABELS[conv.channelType] || conv.channelType}
                        </span>
                      </div>
                      {conv.subject && (
                        <div className={styles.inboxSubject}>{conv.subject}</div>
                      )}
                      {conv.lastMessagePreview && (
                        <div className={styles.inboxPreviewText}>
                          {conv.lastMessageDirection === 'outbound' && (
                            <span className={styles.inboxYouPrefix}>You: </span>
                          )}
                          {conv.lastMessagePreview}
                        </div>
                      )}
                    </div>
                    <div className={styles.inboxMeta}>
                      {conv.isUnread ? (
                        <Mail size={14} className={styles.inboxUnreadIcon} />
                      ) : (
                        <MailOpen size={14} className={styles.inboxReadIcon} />
                      )}
                      <TimeAgo date={conv.lastMessageAt ?? conv.createdAt} className={styles.inboxTime} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Recent Agent Chats */}
          {recentAgentChats.length > 0 && (
            <div className={styles.agentChatsSection}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>
                  <MessagesSquare size={16} className={styles.inboxIcon} />
                  Agent Chats
                </h2>
                <Link to="/agents" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
              </div>
              <div className={styles.agentChatsList}>
                {recentAgentChats.map((chat) => (
                  <Link
                    key={chat.id}
                    to={`/agents?agentId=${chat.agentId}&conversationId=${chat.id}`}
                    className={`${styles.agentChatItem}${chat.isUnread ? ` ${styles.agentChatItemUnread}` : ''}`}
                  >
                    <AgentAvatar
                      icon={chat.agentAvatarIcon || 'spark'}
                      bgColor={chat.agentAvatarBgColor || '#1a1a2e'}
                      logoColor={chat.agentAvatarLogoColor || '#e94560'}
                      size={32}
                    />
                    <div className={styles.agentChatContent}>
                      <div className={styles.agentChatTopRow}>
                        <span className={`${styles.agentChatName}${chat.isUnread ? ` ${styles.agentChatNameUnread}` : ''}`}>
                          {chat.agentName}
                        </span>
                      </div>
                      {chat.subject && (
                        <div className={styles.agentChatSubject}>{chat.subject}</div>
                      )}
                    </div>
                    <div className={styles.agentChatMeta}>
                      {chat.isUnread && <div className={styles.agentChatUnreadDot} />}
                      {chat.lastMessageAt && (
                        <TimeAgo date={chat.lastMessageAt} className={styles.agentChatTime} />
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Quick Scratchpad */}
          <div className={styles.scratchpadSection}>
            <button className={styles.scratchpadHeader} onClick={toggleScratchpadCollapsed} aria-expanded={!scratchpadCollapsed}>
              <StickyNote size={14} className={styles.scratchpadIcon} />
              <span className={styles.scratchpadTitle}>Quick Notes</span>
              {scratchpad.trim() && <span className={styles.scratchpadDot} />}
              <ChevronDown
                size={13}
                className={`${styles.scratchpadChevron}${scratchpadCollapsed ? ` ${styles.scratchpadChevronCollapsed}` : ''}`}
              />
            </button>
            {!scratchpadCollapsed && (
              <div className={styles.scratchpadBody}>
                <textarea
                  ref={scratchpadRef}
                  className={styles.scratchpadTextarea}
                  value={scratchpad}
                  onChange={(e) => handleScratchpadChange(e.target.value)}
                  placeholder="Jot down quick thoughts, ideas, or reminders..."
                  rows={4}
                />
                <div className={styles.scratchpadFooter}>
                  <span className={styles.scratchpadHint}>
                    {scratchpad.trim() ? `${scratchpad.trim().split('\n').length} line${scratchpad.trim().split('\n').length !== 1 ? 's' : ''}` : 'Auto-saved locally'}
                  </span>
                  <div className={styles.scratchpadActions}>
                    {scratchpad.trim() && (
                      <>
                        <button
                          className={styles.scratchpadClearBtn}
                          onClick={() => handleScratchpadChange('')}
                          title="Clear notes"
                        >
                          <X size={12} /> Clear
                        </button>
                        <button
                          className={styles.scratchpadConvertBtn}
                          onClick={() => void handleConvertScratchpadToCard()}
                          disabled={convertingScratchpad}
                          title="Convert to card (first line = name, rest = description)"
                        >
                          <ArrowRightCircle size={12} />
                          {convertingScratchpad ? 'Converting...' : 'Convert to Card'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className={styles.grid}>
            {/* Recent Cards panel */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Recent Cards</h2>
                <Link to="/collections" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
              </div>
              {recentCards.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyIcon}>
                    <FileText size={32} />
                  </div>
                  <div className={styles.emptyTitle}>No cards yet</div>
                  <div className={styles.emptyDescription}>
                    Cards help you organize tasks and track work across your boards.
                  </div>
                  <Link to="/collections" className={styles.emptyAction}>
                    <Plus size={14} /> Go to collections
                  </Link>
                </div>
              ) : (
                <div className={styles.taskList}>
                  {recentCards.map((card) => (
                    <div key={card.id} className={styles.taskRow} onContextMenu={(e) => handleCardContextMenu(e, card.id)}>
                      <Link
                        to={`/cards/${card.id}`}
                        className={`${styles.taskItem}${quickViewCardId === card.id ? ` ${styles.taskItemActive}` : ''}`}
                        onClick={(e) => openQuickView(e, card.id)}
                      >
                        <div className={styles.taskInfo}>
                          <div className={styles.taskTitle}>{card.name}</div>
                          {card.description && (
                            <div className={styles.taskDue}>{stripMarkdown(card.description)}</div>
                          )}
                        </div>
                        <div className={styles.taskRight}>
                          {card.assignee && (
                            card.assignee.type === 'agent' ? (
                              <div className={styles.taskAssignee} title={card.assignee.firstName}>
                                <AgentAvatar
                                  icon={card.assignee.avatarIcon || 'spark'}
                                  bgColor={card.assignee.avatarBgColor || '#1a1a2e'}
                                  logoColor={card.assignee.avatarLogoColor || '#e94560'}
                                  size={20}
                                />
                              </div>
                            ) : (
                              <div className={styles.taskAssignee} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                                <span className={styles.taskAvatar}>
                                  {card.assignee.firstName[0]}{card.assignee.lastName[0]}
                                </span>
                              </div>
                            )
                          )}
                          <TimeAgo date={card.updatedAt ?? card.createdAt} className={styles.taskStatus} />
                        </div>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Agent Activity panel */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Agent Activity</h2>
                <div className={styles.agentActivityLinks}>
                  <Link to="/monitor" className={styles.viewAllLink}>
                    View all <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
              {recentRuns.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyIcon}>
                    <Activity size={32} />
                  </div>
                  <div className={styles.emptyTitle}>No agent runs yet</div>
                  <div className={styles.emptyDescription}>
                    Agent activity will show up here once your agents start running tasks.
                  </div>
                  <Link to="/agents" className={styles.emptyAction}>
                    <Plus size={14} /> Set up agents
                  </Link>
                </div>
              ) : (
                <div className={styles.taskList}>
                  {recentRuns.map((run) => {
                    const TriggerIcon = TRIGGER_CONFIG[run.triggerType].icon;
                    return (
                      <Link
                        key={run.id}
                        to={`/monitor?${new URLSearchParams({ runId: run.id }).toString()}`}
                        className={styles.taskItem}
                      >
                        <div className={styles.runStatusIcon}>
                          {run.status === 'running' && (
                            <span className={styles.runningDot} />
                          )}
                          {run.status === 'completed' && (
                            <CheckCircle2 size={16} className={styles.statusCompleted} />
                          )}
                          {run.status === 'error' && (
                            <XCircle size={16} className={styles.statusError} />
                          )}
                        </div>
                        <div className={styles.taskInfo}>
                          <div className={styles.taskTitle}>{run.agentName}</div>
                          <div className={styles.runMeta}>
                            <TriggerIcon size={11} />
                            <span>{TRIGGER_CONFIG[run.triggerType].label}</span>
                            {run.durationMs != null && (
                              <>
                                <span className={styles.runMetaSep} />
                                <span>{formatDuration(run.durationMs)}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <TimeAgo date={run.startedAt} className={styles.taskStatus} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {quickViewCardId && (
        <CardQuickView
          cardId={quickViewCardId}
          onClose={() => setQuickViewCardId(null)}
          onCardUpdated={handleCardUpdated}
          cardIds={dashboardCardIds}
          onNavigate={setQuickViewCardId}
        />
      )}

      {contextMenu && (() => {
        return (
          <div
            ref={contextMenuRef}
            className={styles.cardContextMenu}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              className={styles.ctxMenuItem}
              onClick={() => { navigate(`/cards/${contextMenu.cardId}`); setContextMenu(null); }}
            >
              <ArrowRight size={13} />
              Open card
            </button>
            <button
              className={styles.ctxMenuItem}
              onClick={() => { window.open(`/cards/${contextMenu.cardId}`, '_blank'); setContextMenu(null); }}
            >
              <ExternalLink size={13} />
              Open in new tab
            </button>
            <button
              className={styles.ctxMenuItem}
              onClick={() => {
                const url = `${window.location.origin}/cards/${contextMenu.cardId}`;
                navigator.clipboard.writeText(url).then(() => toast.success('Link copied')).catch(() => toast.error('Failed to copy'));
                setContextMenu(null);
              }}
            >
              <Copy size={13} />
              Copy link
            </button>
          </div>
        );
      })()}
    </div>
  );
}
