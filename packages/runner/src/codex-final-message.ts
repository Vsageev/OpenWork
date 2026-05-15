export interface FinalizedRunnerLogs {
  code: number | null;
  stdout: string;
  stderr: string;
  appendedFinalMessage: boolean;
}

function buildCodexFinalMessageEvent(runId: string, message: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      id: `openwork-final-message-${runId}`,
      type: 'openwork_final_message',
      text: message,
    },
  });
}

export function appendCodexFinalMessage(stdout: string, runId: string, message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return stdout;
  const event = buildCodexFinalMessageEvent(runId, trimmed);
  const separator = stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : '';
  return `${stdout}${separator}${event}\n`;
}

export function finalizeCodexRunnerLogs(params: {
  runId: string;
  code: number | null;
  stdout: string;
  stderr: string;
  outputLastMessagePath?: string;
  lastMessage: string;
}): FinalizedRunnerLogs {
  if (!params.outputLastMessagePath) {
    return {
      code: params.code,
      stdout: params.stdout,
      stderr: params.stderr,
      appendedFinalMessage: false,
    };
  }

  const lastMessage = params.lastMessage.trim();
  if (lastMessage) {
    return {
      code: params.code,
      stdout: appendCodexFinalMessage(params.stdout, params.runId, lastMessage),
      stderr: params.stderr,
      appendedFinalMessage: true,
    };
  }

  return {
    code: params.code,
    stdout: params.stdout,
    stderr: params.stderr,
    appendedFinalMessage: false,
  };
}
