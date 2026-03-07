import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  Cable, RefreshCw, Trash2, Bot, Plus, X, Settings,
} from 'lucide-react';
import { PageHeader } from '../layout';
import { Button, Input, Badge, Card, Tooltip } from '../ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useConfirm } from '../hooks/useConfirm';
import { TimeAgo } from '../components/TimeAgo';
import styles from './ConnectorsPage.module.css';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface Connector {
  id: string;
  type: string;
  name: string;
  status: 'active' | 'inactive' | 'error';
  statusMessage: string | null;
  capabilities: string[];
  integrationId: string;
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLOR: Record<string, 'success' | 'error' | 'default'> = {
  active: 'success',
  inactive: 'default',
  error: 'error',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Connected',
  inactive: 'Disconnected',
  error: 'Error',
};

const CONNECTOR_TYPES = [
  {
    id: 'telegram',
    name: 'Telegram',
    icon: Bot,
    description: 'Receive and send messages via Telegram bot',
  },
] as const;

type ConnectorTypeId = (typeof CONNECTOR_TYPES)[number]['id'];

function normalizeNgrokUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function ConnectorsPage() {
  useDocumentTitle('Connectors');
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<'type' | 'config'>('type');
  const [selectedType, setSelectedType] = useState<ConnectorTypeId | null>(null);
  const [token, setToken] = useState('');
  const [ngrokUrl, setNgrokUrl] = useState('');
  const [ngrokAuto, setNgrokAuto] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Settings modal
  const [settingsConnector, setSettingsConnector] = useState<Connector | null>(null);
  const [editSettings, setEditSettings] = useState<Record<string, unknown>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  // Refresh
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ entries: Connector[] }>('/connectors');
      setConnectors(data.entries);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load connectors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  // Create flow
  function openCreate() {
    setCreateStep('type');
    setSelectedType(null);
    setToken('');
    setNgrokUrl('');
    setNgrokAuto(false);
    setCreateError('');
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setSelectedType(null);
    setToken('');
    setNgrokUrl('');
    setNgrokAuto(false);
    setCreateError('');
  }

  function handleSelectType(type: ConnectorTypeId) {
    setSelectedType(type);
    setCreateStep('config');
    setToken('');
    setNgrokUrl('');
    setNgrokAuto(false);
    setCreateError('');
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!selectedType || !token.trim()) return;

    setCreating(true);
    setCreateError('');
    try {
      await api('/connectors', {
        method: 'POST',
        body: JSON.stringify({
          type: selectedType,
          token: token.trim(),
          ngrokUrl: ngrokAuto ? 'auto' : (normalizeNgrokUrl(ngrokUrl) || undefined),
        }),
      });
      closeCreate();
      toast.success('Connector created successfully');
      await fetchConnectors();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create connector');
    } finally {
      setCreating(false);
    }
  }

  // Delete
  async function handleDelete(id: string) {
    const ok = await confirm({
      title: 'Remove connector',
      message: 'Are you sure you want to remove this connector? This will stop all message processing.',
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/connectors/${id}`, { method: 'DELETE' });
      toast.success('Connector removed');
      setConnectors((prev) => prev.filter((c) => c.id !== id));
      if (settingsConnector?.id === id) setSettingsConnector(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete connector');
    }
  }

  // Refresh
  async function handleRefresh(id: string) {
    setRefreshingId(id);
    try {
      await api(`/connectors/${id}/refresh`, { method: 'POST' });
      toast.success('Connector refreshed');
      await fetchConnectors();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to refresh');
    } finally {
      setRefreshingId(null);
    }
  }

  // Settings
  function openSettings(connector: Connector) {
    setSettingsConnector(connector);
    setEditSettings({ ...connector.settings });
  }

  async function handleSaveSettings() {
    if (!settingsConnector) return;
    setSavingSettings(true);
    try {
      const settingsToSave = settingsConnector.type === 'telegram'
        ? {
          ...editSettings,
          ngrokUrl: (editSettings.ngrokAuto as boolean)
            ? null
            : normalizeNgrokUrl((editSettings.ngrokUrl as string) ?? '') || null,
        }
        : editSettings;

      await api(`/connectors/${settingsConnector.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settingsToSave),
      });
      toast.success('Settings saved');
      setSettingsConnector(null);
      await fetchConnectors();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  function renderSettingsFields() {
    if (!settingsConnector) return null;

    if (settingsConnector.type === 'telegram') {
      const enabled = (editSettings.autoGreetingEnabled as boolean) ?? false;
      const text = (editSettings.autoGreetingText as string) ?? '';
      const currentNgrokUrl = (editSettings.ngrokUrl as string) ?? '';
      const isNgrokAuto = (editSettings.ngrokAuto as boolean) ?? false;
      return (
        <>
          <label className={styles.toggleRow}>
            <div>
              <div className={styles.toggleLabel}>Auto-start ngrok</div>
              <div className={styles.toggleHint}>Automatically start an ngrok tunnel for the webhook</div>
            </div>
            <span className={styles.toggle}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={isNgrokAuto}
                onChange={(e) =>
                  setEditSettings((s) => ({
                    ...s,
                    ngrokAuto: e.target.checked,
                    ...(e.target.checked ? { ngrokUrl: null } : {}),
                  }))
                }
              />
              <span className={styles.toggleSlider} />
            </span>
          </label>
          {!isNgrokAuto && (
            <Input
              label="Ngrok URL"
              placeholder="https://xxxx-xx-xx.ngrok-free.app"
              value={currentNgrokUrl}
              onChange={(e) =>
                setEditSettings((s) => ({ ...s, ngrokUrl: e.target.value || null }))
              }
            />
          )}
          <label className={styles.toggleRow}>
            <div>
              <div className={styles.toggleLabel}>Auto-greeting</div>
              <div className={styles.toggleHint}>Automatically greet new conversations</div>
            </div>
            <span className={styles.toggle}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={enabled}
                onChange={(e) =>
                  setEditSettings((s) => ({ ...s, autoGreetingEnabled: e.target.checked }))
                }
              />
              <span className={styles.toggleSlider} />
            </span>
          </label>
          {enabled && (
            <Input
              label="Greeting message"
              placeholder="Hello! How can we help you?"
              value={text}
              onChange={(e) =>
                setEditSettings((s) => ({ ...s, autoGreetingText: e.target.value || null }))
              }
            />
          )}
        </>
      );
    }

    return (
      <p className={styles.noSettings}>No configurable settings for this connector type.</p>
    );
  }

  const selectedTypeInfo = CONNECTOR_TYPES.find((t) => t.id === selectedType);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Connectors"
        description="Connect external services and data sources"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} />
            Add Connector
          </Button>
        }
      />

      {loading ? (
        <div className={styles.loadingState}>Loading connectors...</div>
      ) : connectors.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Cable size={32} strokeWidth={1.5} />
          </div>
          <h3>No connectors yet</h3>
          <p>Connect an external service to start receiving and sending messages.</p>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} />
            Add your first connector
          </Button>
        </div>
      ) : (
        <>
          <div className={styles.counter}>
            {connectors.length} connector{connectors.length !== 1 ? 's' : ''}
          </div>
          <Card>
            <div className={styles.connectorList}>
              {connectors.map((connector) => (
                <div key={connector.id} className={styles.connectorCard}>
                  <div className={styles.connectorInfo}>
                    <div className={styles.connectorName}>
                      <span
                        className={styles.statusDot}
                        data-status={connector.status}
                      />
                      {connector.name}
                      <Badge color={STATUS_COLOR[connector.status]}>
                        {STATUS_LABEL[connector.status]}
                      </Badge>
                    </div>
                    <div className={styles.connectorDescription}>
                      {CONNECTOR_TYPES.find((t) => t.id === connector.type)?.name ?? connector.type}
                      {'botUsername' in connector.config && connector.config.botUsername
                        ? ` · @${String(connector.config.botUsername)}`
                        : ''}
                    </div>
                    <div className={styles.connectorMeta}>
                      {connector.capabilities.join(', ')}
                      {' · '}
                      Created <TimeAgo date={connector.createdAt} />
                      {connector.statusMessage && ` · ${connector.statusMessage}`}
                    </div>
                  </div>
                  <div className={styles.connectorActions}>
                    <Tooltip label="Settings">
                      <button
                        className={styles.iconBtn}
                        onClick={() => openSettings(connector)}
                        aria-label="Settings"
                      >
                        <Settings size={15} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Refresh">
                      <button
                        className={styles.iconBtn}
                        onClick={() => handleRefresh(connector.id)}
                        disabled={refreshingId === connector.id}
                        aria-label="Refresh"
                      >
                        <RefreshCw
                          size={15}
                          className={refreshingId === connector.id ? 'spinning' : ''}
                        />
                      </button>
                    </Tooltip>
                    <Tooltip label="Remove connector">
                      <button
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        onClick={() => handleDelete(connector.id)}
                        aria-label="Remove connector"
                      >
                        <Trash2 size={15} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {/* Create modal */}
      {createOpen && (
        <div className={styles.modalOverlay} onClick={closeCreate}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>
                {createStep === 'type'
                  ? 'Add Connector'
                  : `Connect ${selectedTypeInfo?.name ?? ''}`}
              </h3>
              <button className={styles.iconBtn} onClick={closeCreate}>
                <X size={18} />
              </button>
            </div>

            {createStep === 'type' ? (
              <div className={styles.modalBody}>
                <div className={styles.typeGrid}>
                  {CONNECTOR_TYPES.map((type) => {
                    const Icon = type.icon;
                    return (
                      <button
                        key={type.id}
                        className={styles.typeCard}
                        onClick={() => handleSelectType(type.id)}
                      >
                        <div className={styles.typeIconWrap}>
                          <Icon size={24} />
                        </div>
                        <div className={styles.typeInfo}>
                          <div className={styles.typeName}>{type.name}</div>
                          <div className={styles.typeDescription}>{type.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreate}>
                <div className={styles.modalBody}>
                  <Input
                    label="Bot Token"
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    error={createError}
                    autoFocus
                  />
                  <label className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleLabel}>Auto-start ngrok</div>
                      <div className={styles.toggleHint}>Automatically start an ngrok tunnel for the webhook</div>
                    </div>
                    <span className={styles.toggle}>
                      <input
                        type="checkbox"
                        className={styles.toggleInput}
                        checked={ngrokAuto}
                        onChange={(e) => {
                          setNgrokAuto(e.target.checked);
                          if (e.target.checked) setNgrokUrl('');
                        }}
                      />
                      <span className={styles.toggleSlider} />
                    </span>
                  </label>
                  {!ngrokAuto && (
                    <Input
                      label="Ngrok URL (optional)"
                      placeholder="https://xxxx-xx-xx.ngrok-free.app"
                      value={ngrokUrl}
                      onChange={(e) => setNgrokUrl(e.target.value)}
                    />
                  )}
                </div>
                <div className={styles.modalFooter}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      setCreateStep('type');
                      setSelectedType(null);
                      setToken('');
                      setNgrokUrl('');
                      setNgrokAuto(false);
                      setCreateError('');
                    }}
                  >
                    Back
                  </Button>
                  <Button type="submit" size="md" disabled={creating || !token.trim()}>
                    {creating ? 'Connecting...' : 'Connect'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {confirmDialog}

      {/* Settings modal */}
      {settingsConnector && (
        <div className={styles.modalOverlay} onClick={() => setSettingsConnector(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>{settingsConnector.name} Settings</h3>
              <button className={styles.iconBtn} onClick={() => setSettingsConnector(null)}>
                <X size={18} />
              </button>
            </div>
            <div className={styles.modalBody}>{renderSettingsFields()}</div>
            <div className={styles.modalFooter}>
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setSettingsConnector(null)}
              >
                Cancel
              </Button>
              <Button size="md" onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
