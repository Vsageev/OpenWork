import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Monitor, Pencil, Plug, RefreshCw, ShieldOff, X } from 'lucide-react';
import { Badge, Button, Input } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from '../../stores/WorkspaceContext';
import styles from './SettingsPage.module.css';

interface RunnerDevice {
  id: string;
  workspaceId: string;
  displayName: string;
  status: 'online' | 'offline' | 'busy' | 'stale' | 'revoked';
  lastSeenAt: string | null;
  version: string | null;
  capabilities: Record<string, unknown>;
  revoked: boolean;
}

interface PairingCode {
  id: string;
  code: string;
  expiresAt: string;
}

const STATUS_COLOR: Record<RunnerDevice['status'], 'success' | 'warning' | 'error' | 'default' | 'info'> = {
  online: 'success',
  busy: 'info',
  stale: 'warning',
  offline: 'default',
  revoked: 'error',
};

function getRunnerServerUrl(): string {
  const configured = import.meta.env.VITE_API_URL;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.replace(/\/$/, '');
  }

  const url = new URL(window.location.origin);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.port = '3847';
  }
  return url.toString().replace(/\/$/, '');
}

export function RunnerDevicesTab() {
  const { activeWorkspaceId } = useWorkspace();
  const [devices, setDevices] = useState<RunnerDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pairingName, setPairingName] = useState('My runner');
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const connectCommand = useMemo(() => {
    if (!pairingCode) return '';
    return `OPENWORK_SERVER_URL=${getRunnerServerUrl()} OPENWORK_RUNNER_PAIRING_CODE=${pairingCode.code} pnpm --filter openwork-runner dev`;
  }, [pairingCode]);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = activeWorkspaceId ? `?workspaceId=${activeWorkspaceId}` : '';
      const data = await api<{ entries: RunnerDevice[] }>(`/agent-runners${query}`);
      setDevices(data.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load runners');
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  async function createPairingCode() {
    if (!activeWorkspaceId) {
      setError('Runners connect to one workspace. Open the workspace you want this machine to run agents for, then connect the runner.');
      return;
    }
    setError('');
    setSuccess('');
    try {
      const result = await api<PairingCode>('/agent-runners/pairing-codes', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          displayName: pairingName.trim() || 'Runner',
        }),
      });
      setPairingCode(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create pairing code');
    }
  }

  async function copyCommand() {
    if (!connectCommand) return;
    await navigator.clipboard.writeText(connectCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  async function saveRename(device: RunnerDevice) {
    const displayName = editingName.trim();
    if (!displayName) return;
    try {
      const updated = await api<RunnerDevice>(`/agent-runners/${device.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      });
      setDevices((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
      setEditingId(null);
      setSuccess('Runner renamed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename runner');
    }
  }

  async function revoke(device: RunnerDevice) {
    try {
      const updated = await api<RunnerDevice>(`/agent-runners/${device.id}/revoke`, {
        method: 'POST',
      });
      setDevices((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
      setSuccess('Runner revoked');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke runner');
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Runner Devices</h2>
          <p className={styles.sectionDescription}>
            Pair user-owned runners for this workspace and revoke access from old machines.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void fetchDevices()}>
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {error && <div className={styles.alert}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}

      <div className={styles.connectForm}>
        <Input
          value={pairingName}
          onChange={(event) => setPairingName(event.target.value)}
          placeholder="Runner display name"
        />
        <Button onClick={() => void createPairingCode()}>
          <Plug size={14} />
          Connect runner
        </Button>
      </div>

      {pairingCode && (
        <div className={styles.botCard} style={{ marginTop: 16, alignItems: 'flex-start' }}>
          <div className={styles.botInfo}>
            <div className={styles.botName}>Pairing code {pairingCode.code}</div>
            <div className={styles.botUsername}>
              Expires {new Date(pairingCode.expiresAt).toLocaleTimeString()}
            </div>
            <code className={styles.templateContent} style={{ maxWidth: '100%' }}>
              {connectCommand}
            </code>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void copyCommand()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}

      <div className={styles.botList} style={{ marginTop: 20 }}>
        {loading && <div className={styles.loadingState}>Loading runners...</div>}
        {!loading && devices.length === 0 && (
          <div className={styles.emptyState}>
            <Monitor size={28} />
            No paired runners
          </div>
        )}
        {!loading &&
          devices.map((device) => (
            <div key={device.id} className={styles.botCard}>
              <div className={styles.botInfo}>
                <div className={styles.botName}>
                  {editingId === device.id ? (
                    <Input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveRename(device);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    device.displayName
                  )}
                  <Badge color={STATUS_COLOR[device.status]}>{device.status}</Badge>
                </div>
                <div className={styles.botUsername}>
                  {device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Never seen'}
                </div>
                <div className={styles.botMeta}>
                  {[device.capabilities.os, device.capabilities.arch, device.version]
                    .filter(Boolean)
                    .join(' / ')}
                </div>
              </div>
              <div className={styles.botActions}>
                {editingId === device.id ? (
                  <>
                    <button className={styles.iconBtn} onClick={() => void saveRename(device)}>
                      <Check size={16} />
                    </button>
                    <button className={styles.iconBtn} onClick={() => setEditingId(null)}>
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    className={styles.iconBtn}
                    onClick={() => {
                      setEditingId(device.id);
                      setEditingName(device.displayName);
                    }}
                    disabled={device.revoked}
                  >
                    <Pencil size={16} />
                  </button>
                )}
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() => void revoke(device)}
                  disabled={device.revoked}
                >
                  <ShieldOff size={16} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
