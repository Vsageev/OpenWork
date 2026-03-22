import { Input } from './Input';
import styles from './ApiKeyFormFields.module.css';

const API_RESOURCES = [
  'contacts', 'cards', 'tasks', 'boards', 'folders',
  'messages', 'activities', 'templates', 'webhooks',
  'settings', 'collections', 'users', 'backups', 'audit-logs',
  'storage', 'tags', 'conversations',
] as const;

type AccessLevel = 'none' | 'read' | 'write';

export interface ApiKeyFormData {
  name: string;
  description: string;
  permissions: string[];
  hasExpiration: boolean;
  expiresAt: string;
}

interface ApiKeyFormFieldsProps {
  form: ApiKeyFormData;
  onChange: (updater: (prev: ApiKeyFormData) => ApiKeyFormData) => void;
  errors?: Record<string, string>;
  /** When true, only render the permissions grid (hide name, description, expiration). */
  permissionsOnly?: boolean;
}

function getResourceLevel(permissions: string[], resource: string): AccessLevel {
  if (permissions.includes(`${resource}:write`)) return 'write';
  if (permissions.includes(`${resource}:read`)) return 'read';
  return 'none';
}

function setResourceLevel(permissions: string[], resource: string, level: AccessLevel): string[] {
  const filtered = permissions.filter((p) => !p.startsWith(`${resource}:`));
  if (level === 'write') filtered.push(`${resource}:write`);
  else if (level === 'read') filtered.push(`${resource}:read`);
  return filtered;
}

function setAllResources(level: AccessLevel): string[] {
  const permissions: string[] = [];
  for (const resource of API_RESOURCES) {
    if (level === 'write') permissions.push(`${resource}:write`);
    else if (level === 'read') permissions.push(`${resource}:read`);
  }
  return permissions;
}

const LEVEL_STYLE: Record<AccessLevel, string> = {
  none: styles.permBtnNone,
  read: styles.permBtnRead,
  write: styles.permBtnWrite,
};

export function ApiKeyFormFields({ form, onChange, errors = {}, permissionsOnly }: ApiKeyFormFieldsProps) {
  return (
    <>
      {!permissionsOnly && (
        <>
          <Input
            label="Key name"
            placeholder="e.g. Production integration"
            value={form.name}
            onChange={(e) => onChange((f) => ({ ...f, name: e.target.value }))}
            error={errors.name}
          />
          <Input
            label="Description"
            placeholder="Optional description"
            value={form.description}
            onChange={(e) => onChange((f) => ({ ...f, description: e.target.value }))}
            error={errors.description}
          />

          <div>
            <div className={styles.fieldLabel}>Expiration</div>
            <div className={styles.expirationRow}>
              <div className={styles.permSegment}>
                <button
                  type="button"
                  className={`${styles.permBtn} ${!form.hasExpiration ? styles.permBtnActiveNeutral : ''}`}
                  onClick={() => onChange((f) => ({ ...f, hasExpiration: false }))}
                >
                  Never
                </button>
                <button
                  type="button"
                  className={`${styles.permBtn} ${form.hasExpiration ? styles.permBtnActiveNeutral : ''}`}
                  onClick={() => onChange((f) => ({ ...f, hasExpiration: true }))}
                >
                  Custom date
                </button>
              </div>
              {form.hasExpiration && (
                <div className={styles.expirationInput}>
                  <Input
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={(e) => onChange((f) => ({ ...f, expiresAt: e.target.value }))}
                    error={errors.expiresAt}
                  />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div>
        <div className={styles.fieldLabel}>Permissions</div>
        {errors.permissions && (
          <div className={styles.fieldError} data-form-error>{errors.permissions}</div>
        )}
        <div className={styles.permList}>
          {/* Set all row */}
          <div className={styles.permRow}>
            <div className={styles.permSetAll}>Set all</div>
            <div className={styles.permSegment}>
              {(['none', 'read', 'write'] as const).map((level) => {
                const isActive = API_RESOURCES.every((r) => getResourceLevel(form.permissions, r) === level);
                return (
                  <button
                    key={level}
                    type="button"
                    className={`${styles.permBtn} ${isActive ? `${styles.permBtnActive} ${LEVEL_STYLE[level]}` : ''}`}
                    onClick={() => onChange((f) => ({ ...f, permissions: setAllResources(level) }))}
                  >
                    {level === 'none' ? 'None' : level === 'read' ? 'Read' : 'Write'}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.permSeparator} />

          {/* Per-resource rows */}
          {API_RESOURCES.map((resource) => {
            const current = getResourceLevel(form.permissions, resource);
            return (
              <div key={resource} className={styles.permRow}>
                <div className={styles.permResource}>{resource}</div>
                <div className={styles.permSegment}>
                  {(['none', 'read', 'write'] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`${styles.permBtn} ${current === level ? `${styles.permBtnActive} ${LEVEL_STYLE[level]}` : ''}`}
                      onClick={() =>
                        onChange((f) => ({
                          ...f,
                          permissions: setResourceLevel(f.permissions, resource, level),
                        }))
                      }
                    >
                      {level === 'none' ? 'None' : level === 'read' ? 'Read' : 'Write'}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
