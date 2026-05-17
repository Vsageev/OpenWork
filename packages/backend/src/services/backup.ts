import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, stat, unlink, rmdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { store } from '../db/index.js';
import { STORE_MAPPED_COLLECTION_NAMES } from '../db/sql-store-adapter.js';
import { collectionSchemas } from '../schemas/collections.js';

const execFileAsync = promisify(execFile);

/** Written into each backup directory; excluded from JSON bundle download/validation. */
const BACKUP_MANIFEST = 'openwork-backup-manifest.json';

function isCollectionBackupJson(filename: string): boolean {
  return filename.endsWith('.json') && filename !== BACKUP_MANIFEST;
}

async function runPgDump(databaseUrl: string, outputPath: string): Promise<void> {
  await execFileAsync('pg_dump', [databaseUrl, '-Fc', '--no-owner', '-f', outputPath], {
    env: process.env,
  });
}

async function runPgRestore(databaseUrl: string, dumpPath: string): Promise<void> {
  await execFileAsync(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '-d', databaseUrl, dumpPath],
    { env: process.env },
  );
}

/**
 * Writes `postgres.dump` (best-effort), per-collection JSON mirrors, and a small manifest.
 */
async function writePostgresFullBackup(
  targetDir: string,
  options: { requirePostgresDump: boolean },
): Promise<{ sizeBytes: number; dumpWritten: boolean }> {
  const dumpPath = join(targetDir, 'postgres.dump');
  let dumpWritten = false;
  try {
    await runPgDump(env.DATABASE_URL, dumpPath);
    dumpWritten = true;
  } catch (err) {
    if (options.requirePostgresDump) {
      throw new Error(
        `Backup aborted: pg_dump did not produce postgres.dump (${err instanceof Error ? err.message : String(err)}). Install PostgreSQL client tools so pg_dump is on PATH, and ensure DATABASE_URL reaches a live Postgres server. See docs/DEVELOPMENT.md.`,
        { cause: err },
      );
    }
    console.warn(
      '[backup] pg_dump failed (ensure Postgres client tools are installed and DATABASE_URL is reachable):',
      err,
    );
  }

  let totalSize = 0;
  for (const col of STORE_MAPPED_COLLECTION_NAMES) {
    const data = store.getAll(col);
    if (data.length === 0) continue;
    const fp = join(targetDir, `${col}.json`);
    const content = JSON.stringify(data, null, 2);
    await writeFile(fp, content, 'utf-8');
    totalSize += (await stat(fp)).size;
  }

  if (dumpWritten) {
    totalSize += (await stat(dumpPath)).size;
  }

  const formats: string[] = ['json_collections_mirror'];
  if (dumpWritten) formats.push('pg_dump_custom');

  const manifest = {
    version: 1,
    storeDriver: 'postgres' as const,
    formats,
    postgresDumpFile: dumpWritten ? 'postgres.dump' : null,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = join(targetDir, BACKUP_MANIFEST);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  totalSize += (await stat(manifestPath)).size;

  return { sizeBytes: totalSize, dumpWritten };
}

export interface BackupResult {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface BackupInfo {
  filename: string;
  sizeBytes: number;
  createdAt: Date;
}

function getBackupDir(): string {
  return resolve(env.BACKUP_DIR);
}

function buildSubdirName(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `ws-backup-${ts}`;
}

function parseTimestampFromDirname(dirname: string): Date | null {
  const match = dirname.match(/^ws-backup-(.+)$/);
  if (!match) return null;
  const isoStr = match[1].replace(
    /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
    '$1:$2:$3.$4Z',
  );
  const date = new Date(isoStr);
  return isNaN(date.getTime()) ? null : date;
}

export interface CollectionValidationError {
  collection: string;
  index: number;
  message: string;
}

export class BackupValidationError extends Error {
  public readonly errors: CollectionValidationError[];

  constructor(errors: CollectionValidationError[]) {
    super(`Backup validation failed with ${errors.length} error(s)`);
    this.name = 'BackupValidationError';
    this.errors = errors;
  }
}

export function validateCollections(collections: Record<string, unknown[]>): {
  valid: boolean;
  errors: CollectionValidationError[];
} {
  const errors: CollectionValidationError[] = [];

  for (const [col, records] of Object.entries(collections)) {
    const schema = collectionSchemas[col];
    if (!schema) continue; // unknown collections are allowed

    for (let i = 0; i < records.length; i++) {
      const result = schema.safeParse(records[i]);
      if (!result.success) {
        errors.push({
          collection: col,
          index: i,
          message: result.error.message,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function ensureBackupDir(): Promise<void> {
  await mkdir(getBackupDir(), { recursive: true });
}

/**
 * Validates a backup name and returns its full path, or null if not found.
 */
export async function getBackupPath(name: string): Promise<string | null> {
  // Prevent directory traversal
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  const dir = getBackupDir();
  const backupPath = join(dir, name);
  try {
    const info = await stat(backupPath);
    if (!info.isDirectory()) return null;
    return backupPath;
  } catch {
    return null;
  }
}

export async function createBackup(): Promise<BackupResult> {
  const dir = getBackupDir();
  await ensureBackupDir();

  const subdirName = buildSubdirName();
  const subdirPath = join(dir, subdirName);
  await mkdir(subdirPath, { recursive: true });

  await store.flush();

  const { sizeBytes: totalSize } = await writePostgresFullBackup(subdirPath, {
    requirePostgresDump: true,
  });

  return {
    filename: subdirName,
    path: subdirPath,
    sizeBytes: totalSize,
    createdAt: new Date(),
  };
}

export async function listBackups(): Promise<BackupInfo[]> {
  const dir = getBackupDir();
  await ensureBackupDir();

  const entries = await readdir(dir, { withFileTypes: true });
  const backupDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('ws-backup-'));

  const results: BackupInfo[] = [];
  for (const entry of backupDirs) {
    const entryPath = join(dir, entry.name);
    const entryInfo = await stat(entryPath);

    // Calculate total size of all files in the backup subdirectory
    let totalSize = 0;
    try {
      const files = await readdir(entryPath);
      for (const file of files) {
        const fileInfo = await stat(join(entryPath, file));
        totalSize += fileInfo.size;
      }
    } catch {
      // ignore errors reading individual backup contents
    }

    const createdAt = parseTimestampFromDirname(entry.name) ?? entryInfo.birthtime;
    results.push({
      filename: entry.name,
      sizeBytes: totalSize,
      createdAt,
    });
  }

  return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Reads all JSON files from a backup directory and returns them as a bundle.
 */
export async function getBackupBundle(name: string): Promise<Record<string, unknown[]>> {
  const backupPath = await getBackupPath(name);
  if (!backupPath) throw new Error(`Backup not found: ${name}`);

  const files = await readdir(backupPath);
  const jsonFiles = files.filter(isCollectionBackupJson);

  const collections: Record<string, unknown[]> = {};
  for (const file of jsonFiles) {
    const col = file.replace('.json', '');
    const raw = await readFile(join(backupPath, file), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) continue;
    collections[col] = parsed;
  }

  return collections;
}

/**
 * Restores data from a backup created by this server (includes `postgres.dump`).
 *
 * Snapshots the live database, runs `pg_restore --clean`, then reloads the store. JSON-only backup
 * directories are retained as archive data and are not applied by restore.
 */
export async function restoreBackup(name: string): Promise<{ preRestoreBackup: string }> {
  const backupPath = await getBackupPath(name);
  if (!backupPath) throw new Error(`Backup not found: ${name}`);

  const dumpPath = join(backupPath, 'postgres.dump');
  let hasDump: boolean;
  try {
    hasDump = (await stat(dumpPath)).isFile();
  } catch {
    hasDump = false;
  }

  if (!hasDump) {
    throw new Error(
      'This backup does not include postgres.dump. POST /api/backups/:name/restore replays a pg_dump custom-format file created when the server could run pg_dump. JSON-only trees from POST /api/backups/import are archived data and are not restore inputs. See docs/DEVELOPMENT.md.',
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestoreName = `ws-backup-pre-restore-${ts}`;
  const preRestorePath = join(getBackupDir(), preRestoreName);
  await mkdir(preRestorePath, { recursive: true });
  await writePostgresFullBackup(preRestorePath, { requirePostgresDump: true });

  await runPgRestore(env.DATABASE_URL, dumpPath);
  await store.reload();

  return { preRestoreBackup: preRestoreName };
}

/**
 * Imports a backup from a JSON bundle (the format produced by download).
 * Creates a new backup subdirectory, writes each collection as a JSON file,
 * and returns the backup info.
 */
export async function importBackup(
  collections: Record<string, unknown[]>,
  filename?: string,
): Promise<BackupResult> {
  // Validate before writing anything to disk
  const { valid, errors } = validateCollections(collections);
  if (!valid) {
    throw new BackupValidationError(errors);
  }

  const dir = getBackupDir();
  await ensureBackupDir();

  // Use the original backup name if provided (strip .json extension), otherwise generate a new one
  let subdirName: string;
  if (filename) {
    subdirName = filename.replace(/\.json$/, '');
    // If it already exists, append a suffix
    const existing = await getBackupPath(subdirName);
    if (existing) {
      subdirName = `${subdirName}-${Date.now()}`;
    }
  } else {
    subdirName = buildSubdirName();
  }
  const subdirPath = join(dir, subdirName);
  await mkdir(subdirPath, { recursive: true });

  let totalSize = 0;
  for (const [col, data] of Object.entries(collections)) {
    // Sanitize collection name — alphanumeric, hyphens, underscores only
    if (!/^[\w-]+$/.test(col)) continue;
    if (!Array.isArray(data)) continue;

    const filePath = join(subdirPath, `${col}.json`);
    const content = JSON.stringify(data, null, 2);
    await writeFile(filePath, content, 'utf-8');
    const fileInfo = await stat(filePath);
    totalSize += fileInfo.size;
  }

  if (totalSize === 0) {
    // Clean up empty import
    await rmdir(subdirPath);
    throw new Error('Import failed — no valid collections found in the uploaded file');
  }

  return {
    filename: subdirName,
    path: subdirPath,
    sizeBytes: totalSize,
    createdAt: new Date(),
  };
}

/**
 * Deletes a single backup directory.
 */
export async function deleteBackup(name: string): Promise<void> {
  const backupPath = await getBackupPath(name);
  if (!backupPath) throw new Error(`Backup not found: ${name}`);

  const files = await readdir(backupPath);
  for (const file of files) {
    await unlink(join(backupPath, file));
  }
  await rmdir(backupPath);
}

export async function pruneOldBackups(): Promise<string[]> {
  const backups = await listBackups();
  const cutoff = Date.now() - env.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const backup of backups) {
    if (backup.createdAt.getTime() < cutoff) {
      try {
        await deleteBackup(backup.filename);
      } catch {
        // best-effort removal
      }
      removed.push(backup.filename);
    }
  }

  return removed;
}
