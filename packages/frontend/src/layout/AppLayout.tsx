import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Menu, X, ChevronLeft, MessageSquare } from 'lucide-react';
import { CreateCardModal } from '../ui';
import type { CreateCardData } from '../ui/CreateCardModal';
import { WorkspaceProvider } from '../stores/WorkspaceContext';
import { NavigationProgress } from '../components/NavigationProgress';
import { useUnreadBadgeTitle } from '../hooks/useDocumentTitle';
import { useUnreadCount } from '../hooks/useUnreadCount';
import { useActiveRunsCount } from '../hooks/useActiveRunsCount';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import styles from './AppLayout.module.css';

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/my-cards': 'My Cards',
  '/collections': 'Collections',
  '/boards': 'Boards',
  '/inbox': 'Inbox',
  '/agents': 'Agents',
  '/monitor': 'Monitor',
  '/connectors': 'Connectors',
  '/storage': 'Storage',
  '/settings': 'Settings',
};
const MOBILE_BREAKPOINT_QUERY = '(max-width: 1024px)';

function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function getMobileHeaderInfo(pathname: string): { title: string; canGoBack: boolean } {
  // Exact match first
  if (PAGE_TITLES[pathname]) {
    return { title: PAGE_TITLES[pathname], canGoBack: false };
  }
  // Detail pages — show parent label and enable back
  if (pathname.startsWith('/collections/')) return { title: 'Collection', canGoBack: true };
  if (pathname.startsWith('/boards/')) return { title: 'Board', canGoBack: true };
  if (pathname.startsWith('/cards/')) return { title: 'Card', canGoBack: true };
  return { title: 'OpenWork', canGoBack: false };
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true',
  );
  const [isMobile, setIsMobile] = useState(isMobileViewport);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const unreadCount = useUnreadCount();
  const activeRunsCount = useActiveRunsCount();
  useUnreadBadgeTitle(unreadCount ?? 0);

  // Show a toast when new unread messages arrive and the user isn't on the inbox page.
  // prevUnreadRef starts as null (meaning "not yet initialized"). The first resolved value
  // from the hook sets the baseline; only subsequent increases trigger a notification.
  const prevUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    // unreadCount is null until the first fetch resolves — skip until we have a real value
    if (unreadCount === null) return;
    const prev = prevUnreadRef.current;
    prevUnreadRef.current = unreadCount;
    // prev === null means this is the initial baseline fetch — don't notify
    if (prev === null || location.pathname === '/inbox') return;
    if (unreadCount > prev) {
      const newCount = unreadCount - prev;
      toast.info(
        newCount === 1 ? 'New message in Inbox' : `${newCount} new messages in Inbox`,
        { action: { label: 'View', onClick: () => navigate('/inbox') } },
      );
    }
  }, [unreadCount, location.pathname, navigate]);

  // Notify when agent runs complete (count drops from a known positive value to lower)
  const prevActiveRunsRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeRunsCount === null) return;
    const prev = prevActiveRunsRef.current;
    prevActiveRunsRef.current = activeRunsCount;
    if (prev === null || location.pathname === '/monitor') return;
    if (prev > 0 && activeRunsCount < prev) {
      const finished = prev - activeRunsCount;
      if (activeRunsCount === 0) {
        toast.success(
          finished === 1 ? 'Agent run completed' : `${finished} agent runs completed`,
          { action: { label: 'View', onClick: () => navigate('/monitor') }, link: '/monitor' },
        );
      } else {
        toast.info(
          `${finished} agent run${finished > 1 ? 's' : ''} finished, ${activeRunsCount} still running`,
          { action: { label: 'Monitor', onClick: () => navigate('/monitor') }, link: '/monitor' },
        );
      }
    }
  }, [activeRunsCount, location.pathname, navigate]);

  const toggleSidebarCollapse = useCallback(() => {
    if (isMobile) return;
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  }, [isMobile]);

  // Keep layout mode in sync with CSS media query and close any transient mobile drawer state
  // when crossing breakpoints.
  useEffect(() => {
    const media = window.matchMedia(MOBILE_BREAKPOINT_QUERY);

    const syncViewport = (mobile: boolean) => {
      setIsMobile(mobile);
      setSidebarOpen(false);
    };

    syncViewport(media.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      syncViewport(event.matches);
    };

    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const mobileHeader = useMemo(() => getMobileHeaderInfo(location.pathname), [location.pathname]);

  const isSidebarCollapsed = sidebarCollapsed && !isMobile;

  const handleQuickCreate = useCallback(async (data: CreateCardData) => {
    if (!data.collectionId) return;
    const card = await api<{ id: string }>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: data.collectionId,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId,
      }),
    });

    await Promise.all([
      ...data.tagIds.map((tagId) =>
        api(`/cards/${card.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
      ),
      ...data.linkedCardIds.map((targetCardId) =>
        api(`/cards/${card.id}/links`, { method: 'POST', body: JSON.stringify({ targetCardId }) }),
      ),
    ]);

    toast.success('Card created', {
      action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
    });
  }, [navigate]);

  // Allow child pages to open quick-create card modal via custom event
  useEffect(() => {
    const handler = () => setQuickCreateOpen(true);
    window.addEventListener('open-quick-create', handler);
    return () => window.removeEventListener('open-quick-create', handler);
  }, []);

  // Apply sidebar collapsed preference changes from Settings in real time
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail;
      setSidebarCollapsed(detail.collapsed);
    };
    window.addEventListener('sidebar-preference-change', handler);
    return () => window.removeEventListener('sidebar-preference-change', handler);
  }, []);

  return (
    <WorkspaceProvider>
      <NavigationProgress />
      <div className={styles.layout}>
        {/* Mobile header */}
        <header className={styles.mobileHeader}>
          {mobileHeader.canGoBack ? (
            <button
              className={styles.backBtn}
              onClick={() => navigate(-1)}
              aria-label="Go back"
            >
              <ChevronLeft size={20} />
            </button>
          ) : (
            <button
              className={styles.menuBtn}
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
          )}
          <span className={styles.mobileTitle}>{mobileHeader.title}</span>
          <div className={styles.mobileHeaderRight}>
            {(unreadCount ?? 0) > 0 && (
              <button
                className={styles.mobileInboxBtn}
                onClick={() => navigate('/inbox')}
                aria-label={`Inbox (${unreadCount} unread)`}
              >
                <MessageSquare size={18} />
                <span className={styles.mobileInboxBadge}>
                  {(unreadCount ?? 0) > 99 ? '99+' : unreadCount}
                </span>
              </button>
            )}
          </div>
        </header>

        {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
          <div
            className={styles.overlay}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div className={`${styles.sidebarWrap} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
          <button
            className={styles.closeSidebarBtn}
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
          <Sidebar
            onNavigate={() => setSidebarOpen(false)}
            onQuickCreateCard={() => setQuickCreateOpen(true)}
            unreadCount={unreadCount ?? 0}
            activeRunsCount={activeRunsCount ?? 0}
            collapsed={isSidebarCollapsed}
            onToggleCollapse={isMobile ? undefined : toggleSidebarCollapse}
          />
        </div>

        <main className={`${styles.main}${isSidebarCollapsed ? ` ${styles.mainCollapsed}` : ''}`}>
          <Outlet />
        </main>

        {quickCreateOpen && (
          <CreateCardModal
            onClose={() => setQuickCreateOpen(false)}
            onSubmit={handleQuickCreate}
            showCollectionPicker
          />
        )}
      </div>
    </WorkspaceProvider>
  );
}
