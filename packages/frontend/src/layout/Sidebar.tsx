import { useState } from 'react';
import { NavLink } from 'react-router-dom';
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
  LogOut,
  ChevronDown,
  Pencil,
  Trash2,
  Plus,
} from 'lucide-react';
import { useAuth } from '../stores/useAuth';
import { useWorkspace, type Workspace } from '../stores/WorkspaceContext';
import { Tooltip } from '../ui';
import { WorkspaceModal } from '../ui/WorkspaceModal';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useConfirm } from '../hooks/useConfirm';
import styles from './Sidebar.module.css';

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const { user, logout } = useAuth();
  const { workspaces, activeWorkspace, activeWorkspaceId, setActiveWorkspace, refetchWorkspaces } = useWorkspace();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);

  const collectionsTo = '/collections';
  const boardsTo = '/boards';

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: collectionsTo, icon: FolderOpen, label: 'Collections' },
    { to: boardsTo, icon: Kanban, label: 'Boards' },
    { to: '/inbox', icon: MessageSquare, label: 'Inbox' },
    { to: '/agents', icon: Cpu, label: 'Agents' },
    { to: '/monitor', icon: Activity, label: 'Monitor' },
    { to: '/connectors', icon: Cable, label: 'Connectors' },
    { to: '/storage', icon: HardDrive, label: 'Storage' },
  ] as const;

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
    <aside className={styles.sidebar}>
      {confirmDialog}
      <div className={styles.logo}>Cards</div>

      {/* Workspace switcher */}
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

      <nav className={styles.nav}>
        {navItems.map((item) => (
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
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className={styles.bottom}>
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
        {user && (
          <div className={styles.userSection}>
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
