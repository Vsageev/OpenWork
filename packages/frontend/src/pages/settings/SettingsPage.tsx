import { useSearchParams } from 'react-router-dom';
import { Key, HardDrive, Palette, Activity, Tag, UserCircle, Bell } from 'lucide-react';
import { PageHeader } from '../../layout';
import { ProfileTab } from './ProfileTab';
import { ApiKeysTab } from './ApiKeysTab';
import { BackupsTab } from './BackupsTab';
import { AppearanceTab } from './AppearanceTab';
import { ActivityLogTab } from './ActivityLogTab';
import { TagsTab } from './TagsTab';
import { NotificationsTab } from './NotificationsTab';
import styles from './SettingsPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

type SettingsTab = 'profile' | 'appearance' | 'notifications' | 'tags' | 'api-keys' | 'backups' | 'activity';

const VALID_TABS = new Set<SettingsTab>(['profile', 'appearance', 'notifications', 'tags', 'api-keys', 'backups', 'activity']);

const TABS: { key: SettingsTab; label: string; icon: typeof Key }[] = [
  { key: 'profile', label: 'Profile', icon: UserCircle },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'tags', label: 'Tags', icon: Tag },
  { key: 'api-keys', label: 'API Keys', icon: Key },
  { key: 'backups', label: 'Backups', icon: HardDrive },
  { key: 'activity', label: 'Activity Log', icon: Activity },
];

export function SettingsPage() {
  useDocumentTitle('Settings');
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get('tab') as SettingsTab | null;
  const activeTab: SettingsTab = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'profile';

  function setActiveTab(tab: SettingsTab) {
    setSearchParams({ tab }, { replace: true });
  }

  return (
    <div className={styles.page}>
      <PageHeader title="Settings" description="Configure your integrations and preferences" />

      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={[styles.tab, activeTab === tab.key && styles.tabActive]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setActiveTab(tab.key)}
          >
            <tab.icon size={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'appearance' && <AppearanceTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'tags' && <TagsTab />}
      {activeTab === 'api-keys' && <ApiKeysTab />}
      {activeTab === 'backups' && <BackupsTab />}
      {activeTab === 'activity' && <ActivityLogTab />}
    </div>
  );
}
