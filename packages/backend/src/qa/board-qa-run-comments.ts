import { formatAgentRunErrorMessage } from '../lib/agent-output.js';

type HttpMethod = 'GET';

export interface BoardQaGateApi {
  request<T>(path: string, options?: { method?: HttpMethod }): Promise<T>;
}

interface ListResponse<T> {
  entries: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface BoardColumn {
  id: string;
  name: string;
}

interface BoardCardEntry {
  cardId: string;
  columnId: string;
  card: {
    id: string;
    name: string;
    description?: string | null;
    customFields?: Record<string, unknown> | null;
  } | null;
}

interface BoardResponse {
  id: string;
  name: string;
  columns: BoardColumn[];
  cards: BoardCardEntry[];
}

interface AgentRunSummary {
  id: string;
  agentId?: string;
  triggerType?: string;
  status?: string;
  cardId?: string | null;
}

interface AgentRunDetail extends AgentRunSummary {
  responseText?: string | null;
  errorMessage?: string | null;
}

interface CardComment {
  id: string;
  cardId: string;
  authorId?: string | null;
  agentRunId?: string | null;
  content: string;
}

export interface BoardQaGateOptions {
  boardIds?: string[];
  completedColumnNames?: string[];
  testColumnNames?: string[];
  testCardPattern?: RegExp;
  allowedExceptionPattern?: RegExp;
  pageSize?: number;
}

export interface BoardQaGateIssue {
  level: 'error' | 'warning';
  code:
    | 'completed_test_card_without_terminal_runs'
    | 'terminal_run_without_automatic_comment'
    | 'non_completed_test_card_missing_comment';
  boardId: string;
  boardName: string;
  cardId: string;
  cardName: string;
  columnName: string | null;
  runId?: string;
  message: string;
}

export interface BoardQaGateResult {
  ok: boolean;
  checkedCards: number;
  checkedRuns: number;
  errors: BoardQaGateIssue[];
  warnings: BoardQaGateIssue[];
}

const DEFAULT_COMPLETED_COLUMNS = ['done', 'completed', 'complete', 'closed', 'shipped'];
const DEFAULT_TEST_COLUMNS = ['testing', 'test', 'qa', 'verify', 'verification', 'review'];
const DEFAULT_TEST_CARD_PATTERN = /\b(qa|test|testing|smoke|verification|runner-split)\b/i;
const DEFAULT_EXCEPTION_PATTERN = /\bqa-run-comment-exception\b/i;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'failed', 'cancelled']);
/** Keep in sync with `MAX_CARD_AUTO_COMMENT_LENGTH` in `services/agent-runs.ts`. */
const MAX_CARD_AUTORUN_COMMENT_LENGTH = 5000;

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function fieldLooksTrue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return ['true', 'yes', 'qa', 'test'].includes(normalizeName(value));
  return false;
}

function isTestCard(
  card: NonNullable<BoardCardEntry['card']>,
  columnName: string | null,
  options: Required<Pick<BoardQaGateOptions, 'testColumnNames' | 'testCardPattern'>>,
): boolean {
  const testColumns = new Set(options.testColumnNames.map(normalizeName));
  if (columnName && testColumns.has(normalizeName(columnName))) return true;

  const haystack = `${card.name}\n${card.description ?? ''}`;
  if (options.testCardPattern.test(haystack)) return true;

  const fields = card.customFields ?? {};
  return ['qa', 'qaSmoke', 'testCard', 'testing', 'verification'].some((key) =>
    fieldLooksTrue(fields[key]),
  );
}

function isCompletedColumn(columnName: string | null, completedColumnNames: string[]): boolean {
  if (!columnName) return false;
  return new Set(completedColumnNames.map(normalizeName)).has(normalizeName(columnName));
}

function hasAllowedException(
  comments: CardComment[],
  cardId: string,
  runId: string,
  allowedExceptionPattern: RegExp,
): boolean {
  return comments.some((comment) => {
    if (comment.cardId !== cardId) return false;
    if (comment.agentRunId !== runId) return false;
    const content = comment.content.toLowerCase();
    return (
      allowedExceptionPattern.test(comment.content) &&
      content.includes(runId.toLowerCase()) &&
      content.includes(cardId.toLowerCase())
    );
  });
}

function commentReflectsTerminalRun(commentContent: string, run: AgentRunDetail): boolean {
  const text = commentContent.trim();
  if (!text) return false;

  const responseText = typeof run.responseText === 'string' ? run.responseText.trim() : '';
  const rawError = typeof run.errorMessage === 'string' ? run.errorMessage.trim() : '';
  const errorDisplay = formatAgentRunErrorMessage(rawError)?.trim() ?? '';

  if (responseText) {
    if (text.includes(responseText)) return true;
    if (
      responseText.length > MAX_CARD_AUTORUN_COMMENT_LENGTH &&
      text.endsWith('...') &&
      responseText.startsWith(text.slice(0, -3))
    ) {
      return true;
    }
  }
  if (errorDisplay && text.includes(errorDisplay)) return true;

  if (!responseText && !errorDisplay) return text.length > 0;
  return false;
}

function hasRunLinkedAutomaticComment(
  comments: CardComment[],
  cardId: string,
  run: AgentRunDetail,
): boolean {
  return comments.some((comment) => {
    if (comment.cardId !== cardId || comment.agentRunId !== run.id) return false;
    if (run.agentId && comment.authorId !== run.agentId) return false;
    return commentReflectsTerminalRun(comment.content, run);
  });
}

async function listAll<T>(
  api: BoardQaGateApi,
  path: string,
  pageSize: number,
): Promise<T[]> {
  const entries: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await api.request<ListResponse<T>>(
      `${path}${sep}limit=${pageSize}&offset=${offset}`,
      { method: 'GET' },
    );
    entries.push(...page.entries);
    const total = page.total ?? entries.length;
    if (entries.length >= total || page.entries.length === 0) return entries;
  }
}

async function listTargetBoards(
  api: BoardQaGateApi,
  boardIds: string[] | undefined,
  pageSize: number,
): Promise<BoardResponse[]> {
  if (boardIds?.length) {
    return Promise.all(
      boardIds.map((boardId) => api.request<BoardResponse>(`/api/boards/${boardId}`)),
    );
  }

  const summaries = await listAll<{ id: string }>(api, '/api/boards', pageSize);
  return Promise.all(
    summaries.map((board) => api.request<BoardResponse>(`/api/boards/${board.id}`)),
  );
}

async function listTerminalCardRuns(
  api: BoardQaGateApi,
  cardId: string,
  pageSize: number,
): Promise<AgentRunDetail[]> {
  const summaries = await listAll<AgentRunSummary>(
    api,
    `/api/agent-runs?cardId=${encodeURIComponent(cardId)}`,
    pageSize,
  );
  const linked = summaries.filter((run) => run.cardId === cardId);

  const details = await Promise.all(
    linked.map((run) => api.request<AgentRunDetail>(`/api/agent-runs/${run.id}`)),
  );
  return details.filter(
    (run) => run.cardId === cardId && TERMINAL_RUN_STATUSES.has(String(run.status)),
  );
}

export async function checkBoardQaRunComments(
  api: BoardQaGateApi,
  options: BoardQaGateOptions = {},
): Promise<BoardQaGateResult> {
  const completedColumnNames = options.completedColumnNames ?? DEFAULT_COMPLETED_COLUMNS;
  const testColumnNames = options.testColumnNames ?? DEFAULT_TEST_COLUMNS;
  const testCardPattern = options.testCardPattern ?? DEFAULT_TEST_CARD_PATTERN;
  const allowedExceptionPattern =
    options.allowedExceptionPattern ?? DEFAULT_EXCEPTION_PATTERN;
  const pageSize = options.pageSize ?? 100;

  const boards = await listTargetBoards(api, options.boardIds, pageSize);
  const errors: BoardQaGateIssue[] = [];
  const warnings: BoardQaGateIssue[] = [];
  let checkedCards = 0;
  let checkedRuns = 0;

  for (const board of boards) {
    const columnById = new Map(board.columns.map((column) => [column.id, column]));

    for (const entry of board.cards) {
      if (!entry.card) continue;
      const columnName = columnById.get(entry.columnId)?.name ?? null;
      if (!isTestCard(entry.card, columnName, { testColumnNames, testCardPattern })) continue;

      checkedCards += 1;
      const completed = isCompletedColumn(columnName, completedColumnNames);
      const runs = await listTerminalCardRuns(api, entry.card.id, pageSize);
      checkedRuns += runs.length;
      const comments = await listAll<CardComment>(
        api,
        `/api/cards/${entry.card.id}/comments`,
        pageSize,
      );

      if (completed && runs.length === 0) {
        errors.push({
          level: 'error',
          code: 'completed_test_card_without_terminal_runs',
          boardId: board.id,
          boardName: board.name,
          cardId: entry.card.id,
          cardName: entry.card.name,
          columnName,
          message: 'Completed test card has no terminal agent runs linked to this card.',
        });
        continue;
      }

      for (const run of runs) {
        const hasComment =
          hasRunLinkedAutomaticComment(comments, entry.card.id, run) ||
          hasAllowedException(comments, entry.card.id, run.id, allowedExceptionPattern);
        if (hasComment) continue;

        const issue: BoardQaGateIssue = {
          level: completed ? 'error' : 'warning',
          code: completed
            ? 'terminal_run_without_automatic_comment'
            : 'non_completed_test_card_missing_comment',
          boardId: board.id,
          boardName: board.name,
          cardId: entry.card.id,
          cardName: entry.card.name,
          columnName,
          runId: run.id,
          message: completed
            ? 'Completed test card has a terminal run without a matching automatic comment.'
            : 'Non-completed test card has a terminal run without a matching automatic comment.',
        };

        if (completed) errors.push(issue);
        else warnings.push(issue);
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedCards,
    checkedRuns,
    errors,
    warnings,
  };
}

export class HttpBoardQaGateApi implements BoardQaGateApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET ${url.pathname}${url.search} failed: ${response.status} ${body}`);
    }
    return (await response.json()) as T;
  }
}

function readCliArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    const value = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
    values.set(key, value);
  }
  return values;
}

export async function runBoardQaGateCli(argv = process.argv.slice(2)): Promise<number> {
  const args = readCliArgs(argv);
  const baseUrl = args.get('base-url') ?? process.env.OPENWORK_BASE_URL ?? 'http://localhost:3847';
  const token = args.get('token') ?? process.env.OPENWORK_API_TOKEN ?? process.env.WORKSPACE_API_KEY;
  if (!token) {
    console.error('Missing token. Pass --token or set OPENWORK_API_TOKEN/WORKSPACE_API_KEY.');
    return 2;
  }

  const boardIds = args.get('board-id')?.split(',').map((value) => value.trim()).filter(Boolean);
  const result = await checkBoardQaRunComments(new HttpBoardQaGateApi(baseUrl, token), {
    boardIds,
  });

  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBoardQaGateCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error((error as Error).message);
      process.exitCode = 2;
    });
}
