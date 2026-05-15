import { describe, expect, it } from 'vitest';
import {
  checkBoardQaRunComments,
  type BoardQaGateApi,
} from './board-qa-run-comments.js';

type ApiRecord = Record<string, unknown>;

class FakeBoardQaGateApi implements BoardQaGateApi {
  readonly requests: string[] = [];

  constructor(
    private readonly records: {
      boards: ApiRecord[];
      runs: ApiRecord[];
      commentsByCardId: Record<string, ApiRecord[]>;
    },
  ) {}

  async request<T>(path: string): Promise<T> {
    this.requests.push(path);
    const url = new URL(path, 'http://qa.local');

    if (url.pathname === '/api/boards') {
      return this.page(this.records.boards.map((board) => ({ id: board.id })), url) as T;
    }

    const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
    if (boardMatch) {
      const board = this.records.boards.find((entry) => entry.id === boardMatch[1]);
      if (!board) throw new Error(`missing board ${boardMatch[1]}`);
      return board as T;
    }

    if (url.pathname === '/api/agent-runs') {
      const triggerType = url.searchParams.get('triggerType');
      const runs = triggerType
        ? this.records.runs.filter((run) => run.triggerType === triggerType)
        : this.records.runs;
      return this.page(runs, url) as T;
    }

    const runMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)$/);
    if (runMatch) {
      const run = this.records.runs.find((entry) => entry.id === runMatch[1]);
      if (!run) throw new Error(`missing run ${runMatch[1]}`);
      return run as T;
    }

    const commentsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/comments$/);
    if (commentsMatch) {
      return this.page(this.records.commentsByCardId[commentsMatch[1]] ?? [], url) as T;
    }

    throw new Error(`unhandled path ${path}`);
  }

  private page(entries: ApiRecord[], url: URL) {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      limit,
      offset,
    };
  }
}

const completedBoard = {
  id: 'board-qa',
  name: 'QA Board',
  columns: [
    { id: 'col-testing', name: 'Testing' },
    { id: 'col-done', name: 'Done' },
  ],
  cards: [
    {
      cardId: 'card-qa',
      columnId: 'col-done',
      card: {
        id: 'card-qa',
        name: 'QA runner-split test card',
        description: 'smoke verification',
        customFields: {},
      },
    },
  ],
};

const nonCompletedBoard = {
  ...completedBoard,
  cards: [
    {
      cardId: 'card-qa',
      columnId: 'col-testing',
      card: {
        id: 'card-qa',
        name: 'QA runner-split test card',
        description: 'smoke verification',
        customFields: {},
      },
    },
  ],
};

const terminalRun = {
  id: 'run-qa',
  agentId: 'agent-qa',
  triggerType: 'card_assignment',
  status: 'completed',
  cardId: 'card-qa',
  responseText: 'QA final answer',
};

function buildAutomaticComment(overrides: ApiRecord = {}) {
  return {
    id: 'comment-qa',
    cardId: 'card-qa',
    authorId: 'agent-qa',
    agentRunId: 'run-qa',
    content: [
      'Agent run terminal status: completed',
      'Run ID: run-qa',
      'Card ID: card-qa',
      'Agent ID: agent-qa',
      'Trigger type: card_assignment',
      '',
      'Final summary:',
      'QA final answer',
      '',
      'Verification commands/API checks used:',
      '- GET /api/agent-runs/run-qa',
      '- GET /api/cards/card-qa/comments',
    ].join('\n'),
    ...overrides,
  };
}

async function runGate(options: {
  board?: ApiRecord;
  runs?: ApiRecord[];
  comments?: ApiRecord[];
}) {
  return checkBoardQaRunComments(
    new FakeBoardQaGateApi({
      boards: [options.board ?? completedBoard],
      runs: options.runs ?? [terminalRun],
      commentsByCardId: { 'card-qa': options.comments ?? [] },
    }),
    { pageSize: 2 },
  );
}

describe('board QA run comment gate', () => {
  it('passes a completed test card with a run-linked automatic comment', async () => {
    const result = await runGate({ comments: [buildAutomaticComment()] });

    expect(result).toMatchObject({
      ok: true,
      checkedCards: 1,
      checkedRuns: 1,
      errors: [],
      warnings: [],
    });
  });

  it('fails a completed test card with zero comments', async () => {
    const result = await runGate({ comments: [] });

    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([
      {
        code: 'terminal_run_without_automatic_comment',
        cardId: 'card-qa',
        runId: 'run-qa',
      },
    ]);
  });

  it('fails a completed test card with only a manual or admin comment', async () => {
    const result = await runGate({
      comments: [
        buildAutomaticComment({
          id: 'manual-comment',
          authorId: 'admin-user',
          content: 'Manual admin note for run-qa card-qa QA final answer',
        }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: 'terminal_run_without_automatic_comment',
      runId: 'run-qa',
    });
  });

  it('fails comments with a missing run id or wrong card id', async () => {
    const missingRunId = await runGate({
      comments: [buildAutomaticComment({ agentRunId: null })],
    });
    const wrongCardId = await runGate({
      comments: [buildAutomaticComment({ cardId: 'card-other' })],
    });

    expect(missingRunId.ok).toBe(false);
    expect(wrongCardId.ok).toBe(false);
    expect(missingRunId.errors[0]?.code).toBe('terminal_run_without_automatic_comment');
    expect(wrongCardId.errors[0]?.code).toBe('terminal_run_without_automatic_comment');
  });

  it('fails an otherwise linked comment without replayable API evidence', async () => {
    const result = await runGate({
      comments: [
        buildAutomaticComment({
          content: [
            'Agent run terminal status: completed',
            'Run ID: run-qa',
            'Card ID: card-qa',
            'Agent ID: agent-qa',
            'Trigger type: card_assignment',
            '',
            'Final summary:',
            'QA final answer',
          ].join('\n'),
        }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: 'terminal_run_without_automatic_comment',
      runId: 'run-qa',
    });
  });

  it('fails a completed test card with no terminal card-assignment runs', async () => {
    const result = await runGate({ runs: [], comments: [] });

    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject([
      {
        code: 'completed_test_card_without_terminal_runs',
        cardId: 'card-qa',
      },
    ]);
  });

  it('checks every terminal run linked to the card, not just card-assignment runs', async () => {
    const cronRun = {
      ...terminalRun,
      id: 'run-cron-linked-card',
      triggerType: 'cron_job',
      responseText: 'Cron QA final answer',
    };
    const result = await runGate({
      runs: [terminalRun, cronRun],
      comments: [buildAutomaticComment()],
    });

    expect(result.ok).toBe(false);
    expect(result.checkedRuns).toBe(2);
    expect(result.errors).toMatchObject([
      {
        code: 'terminal_run_without_automatic_comment',
        runId: 'run-cron-linked-card',
      },
    ]);
  });

  it('warns instead of failing when a non-completed test card is missing a run-linked comment', async () => {
    const result = await runGate({
      board: nonCompletedBoard,
      comments: [],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toMatchObject([
      {
        code: 'non_completed_test_card_missing_comment',
        cardId: 'card-qa',
        runId: 'run-qa',
      },
    ]);
  });
});
