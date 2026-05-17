import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const sourcePath = fileURLToPath(new URL('./AgentMonitorPage.tsx', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const cssPath = fileURLToPath(new URL('./AgentMonitorPage.module.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

function failContract(options: {
  contractName: string;
  expected: string;
  actual: string;
}): never {
  throw new Error(
    `AgentMonitorPage component contract violated: contractName=${options.contractName} expected=${options.expected} actual=${options.actual}`,
  );
}

function sourceSlice(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) {
    failContract({
      contractName: startNeedle,
      expected: 'source marker exists',
      actual: 'missing',
    });
  }

  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) {
    failContract({
      contractName: endNeedle,
      expected: 'source marker exists after start marker',
      actual: 'missing',
    });
  }

  return source.slice(start, end);
}

function assertContains(contractName: string, sourceText: string, expected: string) {
  if (!sourceText.includes(expected)) {
    failContract({
      contractName,
      expected,
      actual: sourceText.trim().replace(/\s+/g, ' ').slice(0, 500),
    });
  }
}

describe('AgentMonitorPage component contract', () => {
  it('applies a runId URL target only once per URL value', () => {
    const targetRunEffect = sourceSlice(
      'useEffect(() => {\n    if (currentTargetRunIdRef.current !== targetRunId) {',
      '  // Poll active runs every 4 seconds',
    );

    for (const expected of [
      'handledTargetRunIdRef.current = null;',
      'fetchingTargetRunIdRef.current = null;',
      'pendingScrollRunIdRef.current = targetRunId;',
      'if (loading || !targetRunId || handledTargetRunIdRef.current === targetRunId) {',
      'handledTargetRunIdRef.current = targetRunId;',
      'if (fetchingTargetRunIdRef.current === targetRunId) {',
    ]) {
      assertContains('one-shot-url-target-expansion', targetRunEffect, expected);
    }
  });

  it('scrolls the targeted run row into view after expansion', () => {
    const scrollEffect = sourceSlice(
      'useEffect(() => {\n    const runId = pendingScrollRunIdRef.current;',
      '  // Poll active runs every 4 seconds',
    );

    for (const expected of [
      'if (expandedActiveRunId !== runId && expandedHistoryRunId !== runId) return;',
      'const node = runEntryRefs.current[runId];',
      "node.scrollIntoView({ behavior: 'smooth', block: 'center' });",
    ]) {
      assertContains('target-run-scroll', scrollEffect, expected);
    }

    assertContains(
      'run-row-ref',
      source,
      'ref={(node) => { runEntryRefs.current[run.id] = node; }}',
    );
  });

  it('colors the active batch running count independently from neutral detail text', () => {
    const batchStatsMarkup = sourceSlice(
      '<div className={styles.batchStats}>',
      '<span className={styles.batchStatTotal}>{batch.completed + batch.failed + batch.cancelled + skipped}/{batch.total}</span>',
    );

    assertContains(
      'batch-running-count-class',
      batchStatsMarkup,
      '<span className={styles.batchStatProcessing}>{batch.processing} running</span>',
    );

    assertContains(
      'batch-running-count-color',
      css,
      '.batchStatDetail .batchStatProcessing {\n  color: #7c3aed;\n}',
    );
  });

  it('surfaces run, batch, chat turn, and batch item ids in monitor UI', () => {
    assertContains(
      'run-row-identity-column',
      source,
      '<RunIdentityColumn run={run} />',
    );
    assertContains(
      'run-row-turn-chip',
      source,
      '<IdentityChip label="Turn" value={run.turnId} />',
    );
    assertContains(
      'batch-card-id-chip',
      source,
      '<IdentityChip label="Batch" value={batch.id} />',
    );
    assertContains(
      'chat-turn-id-detail',
      source,
      "{ label: 'Chat turn ID', value: detail.turnId ?? null },",
    );
    assertContains(
      'batch-item-agent-run-id-chip',
      source,
      '<IdentityChip label="Agent run" value={item.agentRunId} />',
    );
    assertContains(
      'identity-column-header',
      source,
      '<span>IDs</span>',
    );
  });
});
