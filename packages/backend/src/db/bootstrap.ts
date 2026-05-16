import { databaseConfig } from '../config/database.js';
import { env } from '../config/env.js';
import { store } from './connection.js';
import { runPostgresMigrations } from './run-postgres-migrations.js';
import type { Store } from './store.js';
import { hashPassword, verifyPassword } from '../services/auth.js';

function findByField(
  store: Store,
  collection: string,
  field: string,
  value: unknown,
): Record<string, unknown> | null {
  for (const r of store.getAll(collection)) {
    if (r[field] === value) return r;
  }
  return null;
}

async function ensureUsers(store: Store) {
  const specs = [
    {
      email: 'admin@workspace.local',
      password: 'admin123',
      firstName: 'Admin',
      lastName: 'User',
      type: 'human',
    },
    {
      email: 'manager@workspace.local',
      password: 'manager123',
      firstName: 'Maria',
      lastName: 'Johnson',
      type: 'human',
    },
    {
      email: 'agent1@workspace.local',
      password: 'agent123',
      firstName: 'Alex',
      lastName: 'Smith',
      type: 'human',
    },
  ] as const;

  const users: Record<string, unknown>[] = [];

  for (const spec of specs) {
    const existing = findByField(store, 'users', 'email', spec.email);
    const passwordHash = await hashPassword(spec.password);

    if (existing) {
      const needsPasswordReset = !(await verifyPassword(
        spec.password,
        String(existing.passwordHash ?? ''),
      ));

      const updated = store.update('users', existing.id as string, {
        email: spec.email,
        passwordHash: needsPasswordReset ? passwordHash : (existing.passwordHash as string),
        firstName: spec.firstName,
        lastName: spec.lastName,
        type: spec.type,
        role: undefined,
        isActive: true,
        totpSecret: null,
        totpEnabled: false,
        recoveryCodes: null,
      }) as Record<string, unknown>;

      users.push(updated);
      continue;
    }

    const created = store.insert('users', {
      email: spec.email,
      passwordHash,
      firstName: spec.firstName,
      lastName: spec.lastName,
      type: spec.type,
      isActive: true,
      totpSecret: null,
      totpEnabled: false,
      recoveryCodes: null,
    });
    users.push(created);
  }

  return users;
}

function ensureProjectSettings(store: Store): void {
  const existing = store.getById('settings', 'project');
  if (existing) return;

  store.insert('settings', {
    id: 'project',
    defaultAgentKeyId: null,
    fallbackModel: null,
    fallbackModelId: null,
    autoConvertLargePastedTextToAttachment: true,
  });
}

function ensureRateLimitSettings(store: Store): void {
  const existing = store.getById('settings', 'rate-limits');
  if (existing) return;

  store.insert('settings', {
    id: 'rate-limits',
    agentPromptMax: env.RATE_LIMIT_AGENT_PROMPT_MAX,
    agentPromptWindowS: env.RATE_LIMIT_AGENT_PROMPT_WINDOW_S,
  });
}

function ensureGeneralCollection(
  store: Store,
  createdById: string,
): Record<string, unknown> {
  const existing = store.getAll('collections').find((r) => r.isGeneral === true);
  if (existing) return existing;

  return store.insert('collections', {
    name: 'General',
    description: 'Default collection for uncategorized cards',
    isGeneral: true,
    createdById,
  });
}

function ensureWorkspace(
  store: Store,
  userId: string,
  collectionId: string,
): void {
  const existing = store.getAll('workspaces').find((r) => r.userId === userId);
  if (existing) return;

  store.insert('workspaces', {
    name: 'Default Workspace',
    userId,
    boardIds: [],
    collectionIds: [collectionId],
    agentGroupIds: [],
  });
}

async function bootstrap() {
  console.log('Applying Postgres migrations (Drizzle)...');
  await runPostgresMigrations(databaseConfig);

  await store.init();

  console.log('Bootstrapping workspace data...');

  const [admin] = await ensureUsers(store);
  const adminId = admin.id as string;

  ensureProjectSettings(store);
  ensureRateLimitSettings(store);

  const generalCollection = ensureGeneralCollection(store, adminId);

  ensureWorkspace(
    store,
    adminId,
    generalCollection.id as string,
  );

  await store.flush();

  console.log('Workspace bootstrap completed.');
  console.log('Admin login: admin@workspace.local / admin123');
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
