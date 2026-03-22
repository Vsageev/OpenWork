import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { 
  ArrowRight, 
  ExternalLink, 
  Copy, 
  CopyPlus, 
  MoveRight, 
  Trash2, 
  User, 
  Hash,
  Check,
  X,
  Tag
} from 'lucide-react';
import { AgentAvatar } from '../../components/AgentAvatar';
import { toast } from '../../stores/toast';
import styles from './CardContextMenu.module.css';

interface AgentEntry {
  id: string;
  name: string;
  avatarIcon: string | null;
  avatarBgColor: string | null;
  avatarLogoColor: string | null;
}

export interface UserEntry {
  id: string;
  firstName: string;
  lastName: string;
}

export interface TagEntry {
  id: string;
  name: string;
  color: string;
}

interface CardContextMenuProps {
  x: number;
  y: number;
  cardId: string;
  cardName: string;
  currentAssignee?: { id: string; firstName: string; lastName: string; type?: 'user' | 'agent'; avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null } | null;
  currentTags?: TagEntry[];
  allTags: TagEntry[];
  allColumns: Array<{ id: string; name: string; color: string }>;
  currentColumnId: string;
  agents: AgentEntry[];
  users: UserEntry[];
  currentUserId: string;
  onClose: () => void;
  onOpenCard: (cardId: string) => void;
  onMoveCard: (cardId: string, columnId: string) => void;
  onDuplicateCard: (cardId: string, columnId: string) => void;
  onDeleteCard: (cardId: string, cardName: string) => void;
  onAssignCard: (cardId: string, assigneeId: string | null) => Promise<void>;
  onToggleTag: (cardId: string, tagId: string) => Promise<void>;
}

export function CardContextMenu({
  x,
  y,
  cardId,
  cardName,
  currentAssignee,
  currentTags,
  allTags,
  allColumns,
  currentColumnId,
  agents,
  users,
  currentUserId,
  onClose,
  onOpenCard,
  onMoveCard,
  onDuplicateCard,
  onDeleteCard,
  onAssignCard,
  onToggleTag,
}: CardContextMenuProps) {
  const [showTagsMenu, setShowTagsMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [showAssigneeMenu, setShowAssigneeMenu] = useState(false);
  const assigneeButtonRef = useRef<HTMLDivElement>(null);
  const otherColumns = allColumns.filter((col) => col.id !== currentColumnId);
  const [positionedStyle, setPositionedStyle] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  }>({
    left: x,
    top: y,
    maxHeight: Math.max(160, window.innerHeight - 16),
  });

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menuRect = menu.getBoundingClientRect();

    const availableBelow = Math.max(160, viewportHeight - y - padding);
    const availableAbove = Math.max(160, y - padding);
    const preferBelow = availableBelow >= menuRect.height || availableBelow >= availableAbove;
    const maxHeight = Math.max(
      160,
      Math.min(
        preferBelow ? availableBelow : availableAbove,
        viewportHeight - padding * 2,
      ),
    );

    const measuredHeight = Math.min(menuRect.height, maxHeight);
    const measuredWidth = menuRect.width;

    const left = Math.min(
      Math.max(padding, x),
      Math.max(padding, viewportWidth - measuredWidth - padding),
    );
    const top = preferBelow
      ? Math.min(y, viewportHeight - measuredHeight - padding)
      : Math.max(padding, y - measuredHeight);

    setPositionedStyle((prev) => {
      if (prev.left === left && prev.top === top && prev.maxHeight === maxHeight) {
        return prev;
      }
      return { left, top, maxHeight };
    });
  }, [x, y, showAssigneeMenu, showTagsMenu, allTags.length, agents.length, users.length, otherColumns.length]);

  const handleCopyCardId = () => {
    navigator.clipboard.writeText(cardId).then(() => {
      toast.success('Card ID copied to clipboard');
    }).catch(() => {
      toast.error('Failed to copy card ID');
    });
    onClose();
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/cards/${cardId}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Link copied to clipboard');
    }).catch(() => {
      toast.error('Failed to copy link');
    });
    onClose();
  };

  const handleOpenInNewTab = () => {
    window.open(`/cards/${cardId}`, '_blank');
    onClose();
  };

  const handleAssign = async (assigneeId: string | null) => {
    await onAssignCard(cardId, assigneeId);
    setShowAssigneeMenu(false);
    onClose();
  };

  const handleToggleTag = async (tagId: string) => {
    await onToggleTag(cardId, tagId);
  };

  return (
    <div
      ref={menuRef}
      className={styles.cardContextMenu}
      style={positionedStyle}
    >
      {/* Quick Actions Section */}
      <div className={styles.menuSection}>
        <div className={styles.menuLabel}>Quick Actions</div>
        
        {/* Assignee Quick Pick */}
        <div className={styles.menuItemWrap} ref={assigneeButtonRef}>
          <button
            className={styles.menuItemNeutral}
            onClick={() => setShowAssigneeMenu(!showAssigneeMenu)}
          >
            {currentAssignee ? (
              currentAssignee.type === 'agent' ? (
                <AgentAvatar
                  icon={currentAssignee.avatarIcon || 'spark'}
                  bgColor={currentAssignee.avatarBgColor || '#1a1a2e'}
                  logoColor={currentAssignee.avatarLogoColor || '#e94560'}
                  size={16}
                />
              ) : (
                <span className={styles.assigneeAvatar}>
                  {currentAssignee.firstName[0]}{currentAssignee.lastName[0]}
                </span>
              )
            ) : (
              <User size={14} />
            )}
            <span className={styles.menuItemLabel}>
              {currentAssignee 
                ? `${currentAssignee.firstName} ${currentAssignee.lastName}`
                : 'Assign to...'
              }
            </span>
            {showAssigneeMenu ? <X size={12} /> : <Check size={12} className={styles.menuItemChevron} />}
          </button>
          
          {showAssigneeMenu && (
            <div className={styles.assigneeDropdown}>
              <div className={styles.assigneeDropdownContent}>
                {currentAssignee && (
                  <button
                    className={styles.assigneeOption}
                    onClick={() => handleAssign(null)}
                  >
                    <X size={12} />
                    Unassign
                  </button>
                )}
                
                {agents.length > 0 && (
                  <>
                    <div className={styles.assigneeDivider}>Agents</div>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        className={[
                          styles.assigneeOption,
                          currentAssignee?.id === agent.id ? styles.assigneeOptionActive : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => handleAssign(agent.id)}
                      >
                        <AgentAvatar
                          icon={agent.avatarIcon || 'spark'}
                          bgColor={agent.avatarBgColor || '#1a1a2e'}
                          logoColor={agent.avatarLogoColor || '#e94560'}
                          size={18}
                        />
                        <span className={styles.assigneeName}>{agent.name}</span>
                        {currentAssignee?.id === agent.id && (
                          <Check size={12} className={styles.assigneeCheck} />
                        )}
                      </button>
                    ))}
                  </>
                )}
                
                {users.length > 0 && (
                  <>
                    <div className={styles.assigneeDivider}>Users</div>
                    {[
                      ...users.filter((u) => u.id === currentUserId),
                      ...users.filter((u) => u.id !== currentUserId),
                    ].map((user) => (
                      <button
                        key={user.id}
                        className={[
                          styles.assigneeOption,
                          currentAssignee?.id === user.id ? styles.assigneeOptionActive : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => handleAssign(user.id)}
                      >
                        <span className={styles.assigneeAvatar}>
                          {user.firstName[0]}{user.lastName[0]}
                        </span>
                        <span className={styles.assigneeName}>
                          {user.firstName} {user.lastName}
                          {user.id === currentUserId && (
                            <span className={styles.assigneeYou}>(you)</span>
                          )}
                        </span>
                        {currentAssignee?.id === user.id && (
                          <Check size={12} className={styles.assigneeCheck} />
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Section */}
      <div className={styles.menuSection}>
        <button
          className={styles.menuItemNeutral}
          onClick={() => onOpenCard(cardId)}
        >
          <ArrowRight size={14} />
          Open card
        </button>
        <button
          className={styles.menuItemNeutral}
          onClick={handleOpenInNewTab}
        >
          <ExternalLink size={14} />
          Open in new tab
        </button>
      </div>

      {/* Copy Section */}
      <div className={styles.menuSection}>
        <button
          className={styles.menuItemNeutral}
          onClick={handleCopyLink}
        >
          <Copy size={14} />
          Copy link
        </button>
        <button
          className={styles.menuItemNeutral}
          onClick={handleCopyCardId}
        >
          <Hash size={14} />
          Copy card ID
        </button>
      </div>

      {/* Tags Section */}
      <div className={styles.menuSection}>
        <div className={styles.menuLabel}>
          <Tag size={12} />
          Tags
        </div>
        {allTags.length === 0 ? (
          <div className={styles.menuItemDisabled}>No tags available</div>
        ) : (
          <div className={styles.tagsList}>
            {allTags.map((tag) => {
              const isSelected = currentTags?.some((t) => t.id === tag.id) ?? false;
              return (
                <button
                  key={tag.id}
                  className={`${styles.tagChip}${isSelected ? ` ${styles.tagChipActive}` : ''}`}
                  style={isSelected ? { background: tag.color, borderColor: tag.color } : { borderColor: tag.color, color: tag.color }}
                  onClick={() => handleToggleTag(tag.id)}
                >
                  {isSelected && <Check size={10} />}
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Move Section */}
      {otherColumns.length > 0 && (
        <div className={styles.menuSection}>
          <div className={styles.menuLabel}>
            <MoveRight size={12} />
            Move to
          </div>
          {otherColumns.map((col) => (
            <button
              key={col.id}
              className={styles.menuItemNeutral}
              onClick={() => onMoveCard(cardId, col.id)}
            >
              <span className={styles.columnDot} style={{ background: col.color }} />
              {col.name}
            </button>
          ))}
        </div>
      )}

      {/* Actions Section */}
      <div className={styles.menuSection}>
        <button
          className={styles.menuItemNeutral}
          onClick={() => {
            onDuplicateCard(cardId, currentColumnId);
            onClose();
          }}
        >
          <CopyPlus size={14} />
          Duplicate
        </button>
      </div>

      {/* Danger Section */}
      <div className={styles.menuSection}>
        <div className={styles.menuDivider} />
        <button
          className={styles.menuItemDanger}
          onClick={() => {
            onDeleteCard(cardId, cardName);
            onClose();
          }}
        >
          <Trash2 size={14} />
          Delete card
        </button>
      </div>
    </div>
  );
}
