import { useEffect, useState } from 'react';
import { MessageSquare, Save, FileText } from 'lucide-react';
import { api } from '../../lib/api';
import styles from './ChatTab.module.css';

interface ChatSettings {
  autoAttachOversizedPasteAsTextFile: boolean;
}

export function ChatTab() {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<ChatSettings>('/settings/chat')
      .then((data) => {
        setSettings(data);
        setDraftEnabled(data.autoAttachOversizedPasteAsTextFile);
      })
      .catch(() => setError('Failed to load chat settings'));
  }, []);

  const hasChanges =
    settings !== null &&
    draftEnabled !== settings.autoAttachOversizedPasteAsTextFile;

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const updated = await api<ChatSettings>('/settings/chat', {
        method: 'PATCH',
        body: JSON.stringify({
          autoAttachOversizedPasteAsTextFile: draftEnabled,
        }),
      });
      setSettings(updated);
      setDraftEnabled(updated.autoAttachOversizedPasteAsTextFile);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Failed to save chat settings');
    } finally {
      setSaving(false);
    }
  }

  if (!settings && !error) {
    return <div className={styles.loading}>Loading...</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>
            <MessageSquare size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Chat Paste Handling
          </h3>
          <p className={styles.sectionDesc}>
            When enabled, oversized plain-text pastes in agent chat are attached as uniquely named
            {' '}
            <strong>pasted-text-YYYYMMDD-HHMMSS-XXXXXXXX.txt</strong>
            {' '}
            files instead of being inserted directly into the composer.
          </p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <label className={styles.toggleCard}>
          <div className={styles.toggleCopy}>
            <div className={styles.toggleTitle}>
              <FileText size={15} />
              Attach oversized pasted text as files
            </div>
            <div className={styles.toggleDesc}>
              Each oversized paste is added as its own `.txt` attachment so the model can read it
              reliably.
            </div>
          </div>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={draftEnabled}
            onChange={(e) => setDraftEnabled(e.target.checked)}
            disabled={saving}
          />
          <span className={styles.toggleSwitch} aria-hidden="true" />
        </label>

        <div className={styles.note}>
          Current default: enabled. Pastes under 12,000 characters still go directly into the text
          box.
        </div>

        <div className={styles.actions}>
          <button
            className={styles.saveBtn}
            disabled={!hasChanges || saving}
            onClick={handleSave}
          >
            <Save size={14} />
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
