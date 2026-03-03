import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  LayoutDashboard,
  FolderOpen,
  Kanban,
  MessageSquare,
  Cpu,
  Activity,
  Cable,
  HardDrive,
  Settings,
  FileText,
  SearchX,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  Loader2,
  Plus,
  Mail,
  CheckSquare,
} from 'lucide-react';
import { api } from '../lib/api';
import { getRecentVisits, type RecentVisit } from '../lib/recent-visits';
import { highlightMatch } from './SearchHighlight';
import styles from './CommandPalette.module.css';

interface PaletteItem {
  id: string;
  name: string;
  hint?: string;
  shortcut?: string;
  icon: React.ComponentType<{ size?: number }>;
  iconBg?: string;
  iconColor?: string;
  group: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onQuickCreateCard?: () => void;
}

const NAV_ITEMS: Omit<PaletteItem, 'action'>[] = [
  { id: 'nav-dashboard', name: 'Dashboard', hint: 'Home overview', icon: LayoutDashboard, shortcut: 'G D', group: 'Navigate' },
  { id: 'nav-my-cards', name: 'My Cards', hint: 'Cards assigned to you', icon: CheckSquare, shortcut: 'G Y', group: 'Navigate' },
  { id: 'nav-collections', name: 'Collections', hint: 'Browse collections', icon: FolderOpen, shortcut: 'G C', group: 'Navigate' },
  { id: 'nav-boards', name: 'Boards', hint: 'Kanban boards', icon: Kanban, shortcut: 'G B', group: 'Navigate' },
  { id: 'nav-inbox', name: 'Inbox', hint: 'Messages & conversations', icon: MessageSquare, shortcut: 'G I', group: 'Navigate' },
  { id: 'nav-agents', name: 'Agents', hint: 'Manage AI agents', icon: Cpu, shortcut: 'G A', group: 'Navigate' },
  { id: 'nav-monitor', name: 'Monitor', hint: 'Agent run activity', icon: Activity, shortcut: 'G M', group: 'Navigate' },
  { id: 'nav-connectors', name: 'Connectors', hint: 'External integrations', icon: Cable, group: 'Navigate' },
  { id: 'nav-storage', name: 'Storage', hint: 'File browser', icon: HardDrive, shortcut: 'G S', group: 'Navigate' },
  { id: 'nav-settings', name: 'Settings', hint: 'API keys & backups', icon: Settings, shortcut: 'G ,', group: 'Navigate' },
];

const NAV_ROUTES: Record<string, string> = {
  'nav-dashboard': '/',
  'nav-my-cards': '/my-cards',
  'nav-collections': '/collections',
  'nav-boards': '/boards',
  'nav-inbox': '/inbox',
  'nav-agents': '/agents',
  'nav-monitor': '/monitor',
  'nav-connectors': '/connectors',
  'nav-storage': '/storage',
  'nav-settings': '/settings',
};

const QUICK_ACTIONS: Omit<PaletteItem, 'action'>[] = [
  { id: 'action-new-card', name: 'New Card', hint: 'Create a card', shortcut: 'C', icon: Plus, iconBg: 'rgba(16,185,129,0.1)', iconColor: '#10B981', group: 'Actions' },
  { id: 'action-new-collection', name: 'New Collection', hint: 'Create a collection', icon: Plus, iconBg: 'rgba(59,130,246,0.1)', iconColor: 'var(--color-info)', group: 'Actions' },
  { id: 'action-new-board', name: 'New Board', hint: 'Create a kanban board', icon: Plus, iconBg: 'rgba(139,92,246,0.1)', iconColor: '#8B5CF6', group: 'Actions' },
];

const ACTION_ROUTES: Record<string, string> = {
  'action-new-collection': '/collections?action=create',
  'action-new-board': '/boards?action=create',
};

// Actions that use callbacks instead of navigation
const CALLBACK_ACTIONS = new Set(['action-new-card']);

interface SearchResult {
  id: string;
  name: string;
  type: 'card' | 'agent' | 'board' | 'collection' | 'conversation';
  description?: string | null;
}

export function CommandPalette({ open, onClose, onQuickCreateCard }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentVisits, setRecentVisits] = useState<RecentVisit[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Build items list
  const items = useMemo((): PaletteItem[] => {
    const result: PaletteItem[] = [];
    const q = query.toLowerCase().trim();

    // Add search results from API
    for (const sr of searchResults) {
      const routeMap: Record<string, string> = {
        card: `/cards/${sr.id}`,
        agent: `/agents?agentId=${sr.id}`,
        board: `/boards/${sr.id}`,
        collection: `/collections/${sr.id}`,
        conversation: `/inbox?id=${sr.id}`,
      };
      const iconMap: Record<string, React.ComponentType<{ size?: number }>> = {
        card: FileText,
        agent: Cpu,
        board: Kanban,
        collection: FolderOpen,
        conversation: Mail,
      };
      const typeLabel = sr.type.charAt(0).toUpperCase() + sr.type.slice(1);
      result.push({
        id: `search-${sr.type}-${sr.id}`,
        name: sr.name,
        hint: sr.description ? sr.description : typeLabel,
        icon: iconMap[sr.type] || FileText,
        group: typeLabel + 's',
        action: () => {
          navigate(routeMap[sr.type] || '/');
          onClose();
        },
      });
    }

    // Add quick actions (filtered)
    const filteredActions = q
      ? QUICK_ACTIONS.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            (item.hint && item.hint.toLowerCase().includes(q)),
        )
      : QUICK_ACTIONS;

    for (const action of filteredActions) {
      result.push({
        ...action,
        action: () => {
          if (CALLBACK_ACTIONS.has(action.id) && action.id === 'action-new-card' && onQuickCreateCard) {
            onQuickCreateCard();
          } else {
            navigate(ACTION_ROUTES[action.id] || '/');
          }
          onClose();
        },
      });
    }

    // Add recent visits (only when no search query)
    if (!q && recentVisits.length > 0) {
      const iconMap: Record<string, React.ComponentType<{ size?: number }>> = {
        card: FileText,
        board: Kanban,
        collection: FolderOpen,
      };
      for (const visit of recentVisits) {
        const typeLabel = visit.type.charAt(0).toUpperCase() + visit.type.slice(1);
        result.push({
          id: `recent-${visit.type}-${visit.id}`,
          name: visit.name,
          hint: typeLabel,
          icon: iconMap[visit.type] || FileText,
          group: 'Recent',
          action: () => {
            navigate(visit.path);
            onClose();
          },
        });
      }
    }

    // Add navigation items (filtered)
    const filteredNav = q
      ? NAV_ITEMS.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            (item.hint && item.hint.toLowerCase().includes(q)),
        )
      : NAV_ITEMS;

    for (const nav of filteredNav) {
      result.push({
        ...nav,
        action: () => {
          navigate(NAV_ROUTES[nav.id] || '/');
          onClose();
        },
      });
    }

    return result;
  }, [query, searchResults, recentVisits, navigate, onClose]);

  // Search API when query changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const [cardsRes, agentsRes, boardsRes, collectionsRes, conversationsRes] = await Promise.all([
          api<{ entries: { id: string; name: string; description?: string | null }[] }>(`/cards?limit=4&search=${encodeURIComponent(q)}`).catch(() => ({ entries: [] })),
          api<{ entries: { id: string; name: string }[] }>(`/agents?limit=3&search=${encodeURIComponent(q)}`).catch(() => ({ entries: [] })),
          api<{ entries: { id: string; name: string; description?: string | null }[] }>(`/boards?limit=3&search=${encodeURIComponent(q)}`).catch(() => ({ entries: [] })),
          api<{ entries: { id: string; name: string; description?: string | null }[] }>(`/collections?limit=3&search=${encodeURIComponent(q)}`).catch(() => ({ entries: [] })),
          api<{ entries: { id: string; subject?: string | null; contact?: { id: string; firstName: string; lastName?: string | null } | null; channelType?: string; lastMessagePreview?: string | null }[] }>(`/conversations?limit=3&search=${encodeURIComponent(q)}`).catch(() => ({ entries: [] })),
        ]);

        const results: SearchResult[] = [];
        for (const c of cardsRes.entries) results.push({ id: c.id, name: c.name, type: 'card', description: c.description });
        for (const b of boardsRes.entries) results.push({ id: b.id, name: b.name, type: 'board', description: b.description });
        for (const col of collectionsRes.entries) results.push({ id: col.id, name: col.name, type: 'collection', description: col.description });
        for (const a of agentsRes.entries) results.push({ id: a.id, name: a.name, type: 'agent' });
        for (const conv of conversationsRes.entries) {
          const contactName = conv.contact
            ? [conv.contact.firstName, conv.contact.lastName].filter(Boolean).join(' ')
            : 'Unknown';
          const hint = conv.subject || conv.lastMessagePreview || conv.channelType || undefined;
          results.push({ id: conv.id, name: contactName, type: 'conversation', description: hint });
        }
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Reset state on open/close
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setSearchResults([]);
      setRecentVisits(getRecentVisits());
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % Math.max(items.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[activeIndex]) {
          items[activeIndex].action();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [items, activeIndex, onClose],
  );

  // Keep active item scrolled into view
  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;
    const active = container.querySelector(`[data-index="${activeIndex}"]`);
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // Clamp activeIndex when items change
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(items.length - 1, 0)));
  }, [items.length]);

  if (!open) return null;

  // Group items
  const groups: { label: string; items: (PaletteItem & { globalIndex: number })[] }[] = [];
  let idx = 0;
  for (const item of items) {
    let group = groups.find((g) => g.label === item.group);
    if (!group) {
      group = { label: item.group, items: [] };
      groups.push(group);
    }
    group.items.push({ ...item, globalIndex: idx });
    idx++;
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.palette} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.inputRow}>
          <Search size={16} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search or jump to..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {searching ? (
            <Loader2 size={14} className={styles.searchingIcon} />
          ) : (
            <span className={styles.escHint}>esc</span>
          )}
        </div>

        <div className={styles.results} ref={resultsRef}>
          {items.length === 0 && !searching ? (
            <div className={styles.empty}>
              <SearchX size={24} className={styles.emptyIcon} />
              <div>No results for &ldquo;{query}&rdquo;</div>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className={styles.groupLabel}>{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    data-index={item.globalIndex}
                    className={`${styles.item} ${item.globalIndex === activeIndex ? styles.itemActive : ''}`}
                    onClick={item.action}
                    onMouseEnter={() => setActiveIndex(item.globalIndex)}
                  >
                    <div
                      className={item.iconBg ? styles.itemIconColored : styles.itemIcon}
                      style={item.iconBg ? { background: item.iconBg, color: item.iconColor } : undefined}
                    >
                      <item.icon size={16} />
                    </div>
                    <div className={styles.itemContent}>
                      <div className={styles.itemName}>{highlightMatch(item.name, query.trim())}</div>
                      {item.hint && <div className={styles.itemHint}>{highlightMatch(item.hint, query.trim())}</div>}
                    </div>
                    {item.shortcut && (
                      <span className={styles.itemShortcut}>
                        {item.shortcut.split(' ').map((k, i) => (
                          <kbd key={i}>{k}</kbd>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <kbd><ArrowUp size={10} /></kbd>
            <kbd><ArrowDown size={10} /></kbd>
            navigate
          </span>
          <span className={styles.footerHint}>
            <kbd><CornerDownLeft size={10} /></kbd>
            select
          </span>
          <span className={styles.footerHint}>
            <kbd>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
