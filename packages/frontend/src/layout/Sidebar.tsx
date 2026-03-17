import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderOpen,
  Kanban,
  MessageSquare,
  Cpu,
  Activity,
  Cable,
  HardDrive,
  Settings,
  CheckSquare,
  LogOut,
  ChevronDown,
  Pencil,
  Trash2,
  Plus,
  Star,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  FileText,
  Bell,
} from 'lucide-react';
import { useAuth } from '../stores/useAuth';
import { useWorkspace, type Workspace } from '../stores/WorkspaceContext';
import { Tooltip } from '../ui';
import { WorkspaceModal } from '../ui/WorkspaceModal';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useUnreadNotificationCount } from '../stores/toast';
import { useConfirm } from '../hooks/useConfirm';
import { useFavorites } from '../hooks/useFavorites';
import { NotificationPanel } from '../components/NotificationPanel';
import styles from './Sidebar.module.css';

interface SidebarProps {
  onNavigate?: () => void;
  onQuickCreateCard?: () => void;
  unreadCount?: number;
  activeRunsCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ onNavigate, onQuickCreateCard, unreadCount = 0, activeRunsCount = 0, collapsed = false, onToggleCollapse }: SidebarProps) {
  const { user, logout } = useAuth();
  const { workspaces, activeWorkspace, activeWorkspaceId, setActiveWorkspace, refetchWorkspaces } = useWorkspace();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { favorites, removeFavorite } = useFavorites();
  const location = useLocation();


  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationUnreadCount = useUnreadNotificationCount();

  const collectionsTo = '/collections';
  const boardsTo = '/boards';

  const navItems: Array<{
    to: string;
    icon: typeof LayoutDashboard;
    label: string;
    badge?: number;
    badgePulsing?: boolean;
    badgeDanger?: boolean;
  }> = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/my-cards', icon: CheckSquare, label: 'My Cards' },
    { to: collectionsTo, icon: FolderOpen, label: 'Collections' },
    { to: boardsTo, icon: Kanban, label: 'Boards' },
    { to: '/inbox', icon: MessageSquare, label: 'Inbox', badge: unreadCount },
    { to: '/agents', icon: Cpu, label: 'Agents' },
    { to: '/monitor', icon: Activity, label: 'Monitor', badge: activeRunsCount, badgePulsing: true },
    { to: '/connectors', icon: Cable, label: 'Connectors' },
    { to: '/storage', icon: HardDrive, label: 'Storage' },
  ];

  function handleSelectWorkspace(id: string | null) {
    setActiveWorkspace(id);
    setDropdownOpen(false);
  }

  function handleEdit(ws: Workspace, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingWorkspace(ws);
    setShowModal(true);
    setDropdownOpen(false);
  }

  async function handleDelete(ws: Workspace, e: React.MouseEvent) {
    e.stopPropagation();
    setDropdownOpen(false);
    const confirmed = await confirm({
      title: 'Delete workspace',
      message: `Delete workspace "${ws.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await api(`/workspaces/${ws.id}`, { method: 'DELETE' });
      if (activeWorkspaceId === ws.id) {
        setActiveWorkspace(null);
      }
      await refetchWorkspaces();
    } catch {
      toast.error('Failed to delete workspace');
    }
  }

  function handleCreate() {
    setEditingWorkspace(null);
    setShowModal(true);
    setDropdownOpen(false);
  }

  return (
    <aside className={`${styles.sidebar}${collapsed ? ` ${styles.sidebarCollapsed}` : ''}`}>
      {confirmDialog}
      {collapsed ? (
        <>
          <Tooltip label={activeWorkspace?.name ?? 'OpenWork'} position="right">
            <div className={styles.logoCollapsed}>
              {(activeWorkspace?.name ?? 'W')[0]}
            </div>
          </Tooltip>
          {onToggleCollapse && (
            <Tooltip label="Expand sidebar" position="right">
              <button
                className={styles.collapseToggle}
                onClick={onToggleCollapse}
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            </Tooltip>
          )}
        </>
      ) : (
        <div className={styles.logoRow}>
          <div className={styles.logo}>{activeWorkspace?.name ?? 'OpenWork'}</div>
          {onToggleCollapse && (
            <Tooltip label="Collapse sidebar" position="bottom">
              <button
                className={styles.collapseToggle}
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {/* Workspace switcher */}
      {!collapsed && (
        <div className={styles.workspaceSwitcher}>
          <button
            className={styles.workspaceButton}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className={styles.workspaceLabel}>
              {activeWorkspace?.name ?? 'All'}
            </span>
            <ChevronDown size={14} />
          </button>

          {dropdownOpen && (
            <>
              <div
                className={styles.dropdownBackdrop}
                onClick={() => setDropdownOpen(false)}
              />
              <div className={styles.dropdown}>
                <button
                  className={`${styles.dropdownItem} ${!activeWorkspaceId ? styles.dropdownItemActive : ''}`}
                  onClick={() => handleSelectWorkspace(null)}
                >
                  All
                </button>
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    className={`${styles.dropdownItem} ${activeWorkspaceId === ws.id ? styles.dropdownItemActive : ''}`}
                    onClick={() => handleSelectWorkspace(ws.id)}
                  >
                    <span className={styles.dropdownItemName}>{ws.name}</span>
                    <span className={styles.dropdownItemActions}>
                      <span
                        className={styles.dropdownAction}
                        onClick={(e) => handleEdit(ws, e)}
                      >
                        <Pencil size={12} />
                      </span>
                      <span
                        className={styles.dropdownAction}
                        onClick={(e) => { void handleDelete(ws, e); }}
                      >
                        <Trash2 size={12} />
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  className={styles.dropdownItemCreate}
                  onClick={handleCreate}
                >
                  <Plus size={14} />
                  <span>New workspace</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.scrollArea}>
      {favorites.length > 0 && !collapsed && (
        <div className={styles.favoritesSection}>
          <div className={styles.favoritesHeader}>
            <Star size={12} />
            <span>Favorites</span>
          </div>
          {favorites.map((fav) => (
            <NavLink
              key={fav.id}
              to={fav.type === 'board' ? `/boards/${fav.id}` : fav.type === 'card' ? `/cards/${fav.id}` : `/collections/${fav.id}`}
              className={styles.favoriteItem}
              onClick={onNavigate}
            >
              {fav.type === 'board' ? <Kanban size={14} /> : fav.type === 'card' ? <FileText size={14} /> : <FolderOpen size={14} />}
              <span className={styles.favoriteName}>{fav.name}</span>
              <button
                className={styles.favoriteRemove}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeFavorite(fav.id);
                }}
                title="Remove from favorites"
              >
                <X size={12} />
              </button>
            </NavLink>
          ))}
        </div>
      )}


      {favorites.length > 0 && collapsed && (
        <div className={styles.collapsedFavoritesSection}>
          {favorites.map((fav) => (
            <Tooltip key={fav.id} label={fav.name} position="right">
              <NavLink
                to={fav.type === 'board' ? `/boards/${fav.id}` : fav.type === 'card' ? `/cards/${fav.id}` : `/collections/${fav.id}`}
                className={styles.collapsedFavoriteItem}
                onClick={onNavigate}
              >
                {fav.type === 'board' ? <Kanban size={16} /> : fav.type === 'card' ? <FileText size={16} /> : <FolderOpen size={16} />}
              </NavLink>
            </Tooltip>
          ))}
        </div>
      )}
      {favorites.length > 0 && collapsed && (
        <div className={styles.collapsedFavoritesDivider} />
      )}

      <nav className={styles.nav}>
        {navItems.map((item) => {
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [styles.navItem, isActive && styles.active].filter(Boolean).join(' ')
              }
              end={item.to === '/'}
              onClick={onNavigate}
            >
              <item.icon size={18} />
              {!collapsed && <span>{item.label}</span>}
              {!!item.badge && (
                <span className={
                  collapsed
                    ? (item.badgeDanger ? styles.navBadgeDangerCollapsed : item.badgePulsing ? styles.navBadgePulsingCollapsed : styles.navBadgeCollapsed)
                    : (item.badgeDanger ? styles.navBadgeDanger : item.badgePulsing ? styles.navBadgePulsing : styles.navBadge)
                }>
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </NavLink>
          );
          return collapsed ? (
            <Tooltip key={item.to} label={item.label} position="right">
              {link}
            </Tooltip>
          ) : link;
        })}
      </nav>
      </div>
      <div className={styles.bottom}>
        <div className={styles.notificationWrapper}>
          {collapsed ? (
            <Tooltip label="Notifications" position="right">
              <button
                className={styles.collapsedIconBtn}
                onClick={() => setShowNotifications((v) => !v)}
                aria-label="Notifications"
              >
                <Bell size={18} />
                {notificationUnreadCount > 0 && (
                  <span className={styles.notificationBadgeCollapsed}>
                    {notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}
                  </span>
                )}
              </button>
            </Tooltip>
          ) : (
            <button
              className={styles.notificationButton}
              onClick={() => setShowNotifications((v) => !v)}
            >
              <Bell size={16} />
              <span>Notifications</span>
              {notificationUnreadCount > 0 && (
                <span className={styles.notificationBadge}>
                  {notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}
                </span>
              )}
            </button>
          )}
          {showNotifications && (
            <NotificationPanel onClose={() => setShowNotifications(false)} />
          )}
        </div>

        {collapsed ? (
          <Tooltip label="Settings" position="right">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                [styles.navItem, isActive && styles.active].filter(Boolean).join(' ')
              }
              onClick={onNavigate}
            >
              <Settings size={18} />
            </NavLink>
          </Tooltip>
        ) : (
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              [styles.navItem, isActive && styles.active].filter(Boolean).join(' ')
            }
            onClick={onNavigate}
          >
            <Settings size={18} />
            <span>Settings</span>
          </NavLink>
        )}

        {user && (
          <div className={styles.userSection}>
            {collapsed ? (
              <Tooltip label={`${user.firstName} ${user.lastName}`} position="right">
                <span className={styles.userAvatar}>
                  {user.firstName[0]}
                  {user.lastName[0]}
                </span>
              </Tooltip>
            ) : (
              <>
                <div className={styles.userInfo}>
                  <span className={styles.userAvatar}>
                    {user.firstName[0]}
                    {user.lastName[0]}
                  </span>
                  <div className={styles.userDetails}>
                    <span className={styles.userName}>
                      {user.firstName} {user.lastName}
                    </span>
                  </div>
                </div>
                <Tooltip label="Log out">
                  <button
                    className={styles.logoutBtn}
                    onClick={logout}
                  >
                    <LogOut size={16} />
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <WorkspaceModal
          workspace={editingWorkspace}
          onClose={() => setShowModal(false)}
          onSaved={() => refetchWorkspaces()}
        />
      )}
    </aside>
  );
}
