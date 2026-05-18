import { store } from '../db/index.js';
import {
  backfillLegacyAgentChatTurns,
  validateAgentChatTurnChains,
} from '../services/agent-chat-turns.js';

const HELP = `Usage: pnpm --filter backend chat-turns:migrate [--validate-only]

Backfills legacy agent chat messages, queue rows, and runs into durable turns.

Options:
  --validate-only  Validate existing turn chains without mutating data.
  --help           Show this help.
`;

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    process.stdout.write(HELP);
    return;
  }

  await store.init();
  const report = args.has('--validate-only')
    ? {
        migrated: 0,
        skipped: 0,
        repaired: 0,
        invalid: 0,
        created: 0,
        updatedQueueItems: 0,
        updatedRuns: 0,
        repairedParentLinks: 0,
        updatedActiveBranches: 0,
        invalidRows: validateAgentChatTurnChains(),
      }
    : backfillLegacyAgentChatTurns({ linkReferences: true });
  if (!args.has('--validate-only')) {
    await store.flush();
  }
  report.invalid = new Set(report.invalidRows.map((issue) => issue.conversationId).filter(Boolean))
    .size;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.invalid > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
