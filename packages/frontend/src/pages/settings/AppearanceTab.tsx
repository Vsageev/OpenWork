import { useState } from 'react';
import { PanelLeftClose, LayoutList, CheckSquare } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import styles from './AppearanceTab.module.css';

type ThemeOption = 'light' | 'dark' | 'system';
type GroupByOption = 'dueDate' | 'priority' | 'none';

const THEME_OPTIONS: { value: ThemeOption; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'Clean white interface for bright environments' },
  { value: 'dark', label: 'Dark', description: 'Easy on the eyes in low-light conditions' },
  { value: 'system', label: 'System', description: 'Automatically matches your OS preference' },
];

const GROUP_BY_OPTIONS: { value: GroupByOption; label: string }[] = [
  { value: 'dueDate', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'none', label: 'None' },
];

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (val: boolean) => void; id: string }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      className={`${styles.toggle}${checked ? ` ${styles.toggleOn}` : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleThumb} />
    </button>
  );
}

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true',
  );

  const [myCardsGroupBy, setMyCardsGroupBy] = useState<GroupByOption>(
    () => (localStorage.getItem('my-cards-page-group-by') as GroupByOption) || 'dueDate',
  );

  const [myCardsHideCompleted, setMyCardsHideCompleted] = useState(
    () => localStorage.getItem('my-cards-page-hide-completed') !== 'false',
  );

  function handleSidebarCollapsed(val: boolean) {
    setSidebarCollapsed(val);
    localStorage.setItem('sidebar-collapsed', String(val));
    // Apply to current session immediately
    window.dispatchEvent(new CustomEvent('sidebar-preference-change', { detail: { collapsed: val } }));
  }

  function handleMyCardsGroupBy(val: GroupByOption) {
    setMyCardsGroupBy(val);
    localStorage.setItem('my-cards-page-group-by', val);
  }

  function handleMyCardsHideCompleted(val: boolean) {
    setMyCardsHideCompleted(val);
    localStorage.setItem('my-cards-page-hide-completed', String(val));
  }

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Theme</h3>
          <p className={styles.sectionDesc}>Choose how the interface looks to you.</p>
        </div>
        <div className={styles.themeOptions}>
          {THEME_OPTIONS.map((opt) => {
            const isActive = theme === opt.value;
            return (
              <button
                key={opt.value}
                className={`${styles.themeOption}${isActive ? ` ${styles.themeOptionActive}` : ''}`}
                onClick={() => setTheme(opt.value)}
                aria-pressed={isActive}
              >
                <div className={`${styles.themePreview} ${styles[`themePreview${opt.value.charAt(0).toUpperCase() + opt.value.slice(1)}`]}`}>
                  <div className={styles.themePreviewSidebar} />
                  <div className={styles.themePreviewContent}>
                    <div className={styles.themePreviewLine} />
                    <div className={`${styles.themePreviewLine} ${styles.themePreviewLineShort}`} />
                  </div>
                </div>
                <div className={styles.themeOptionFooter}>
                  <div className={styles.themeOptionContent}>
                    <div className={styles.themeOptionLabel}>{opt.label}</div>
                    <div className={styles.themeOptionDesc}>{opt.description}</div>
                  </div>
                  <div className={styles.themeRadio}>
                    <div className={styles.themeRadioDot} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.sectionDivider} />

      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Layout</h3>
          <p className={styles.sectionDesc}>Control how the app is laid out by default.</p>
        </div>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <PanelLeftClose size={16} className={styles.prefIcon} />
            <label className={styles.prefLabel} htmlFor="sidebar-collapsed-pref">
              <span className={styles.prefLabelText}>Collapsed sidebar by default</span>
              <span className={styles.prefLabelDesc}>Start with the sidebar collapsed to maximize content area</span>
            </label>
            <Toggle id="sidebar-collapsed-pref" checked={sidebarCollapsed} onChange={handleSidebarCollapsed} />
          </div>
        </div>
      </div>

      <div className={styles.sectionDivider} />

      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>My Cards</h3>
          <p className={styles.sectionDesc}>Default behavior for your personal task view.</p>
        </div>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <CheckSquare size={16} className={styles.prefIcon} />
            <label className={styles.prefLabel} htmlFor="my-cards-hide-completed-pref">
              <span className={styles.prefLabelText}>Hide completed cards by default</span>
              <span className={styles.prefLabelDesc}>Focus on what's left to do; completed cards are hidden on load</span>
            </label>
            <Toggle id="my-cards-hide-completed-pref" checked={myCardsHideCompleted} onChange={handleMyCardsHideCompleted} />
          </div>
          <div className={styles.prefRow}>
            <LayoutList size={16} className={styles.prefIcon} />
            <label className={styles.prefLabel} htmlFor="my-cards-group-by-pref">
              <span className={styles.prefLabelText}>Default grouping</span>
              <span className={styles.prefLabelDesc}>How cards are grouped when you open My Cards</span>
            </label>
            <select
              id="my-cards-group-by-pref"
              className={styles.prefSelect}
              value={myCardsGroupBy}
              onChange={(e) => handleMyCardsGroupBy(e.target.value as GroupByOption)}
            >
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
