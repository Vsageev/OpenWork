import {
  RUNNER_PROTOCOL_VERSION,
  extractAgentOutputIncompleteText,
  type RunnerJobIntent,
  type RunnerServerMessage,
} from 'shared';

interface BuildTerminalMessageParams {
  jobId: string;
  runId: string;
  provider: RunnerJobIntent['provider'];
  code: number | null;
  stdout: string;
  stderr: string;
}

export function buildRunnerTerminalMessage(
  params: BuildTerminalMessageParams,
): Extract<RunnerServerMessage, { type: 'completed' | 'failed' }> {
  if ((params.code ?? 1) !== 0) {
    return {
      type: 'failed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: params.jobId,
      runId: params.runId,
      code: params.code,
      message: `Remote runner exited with code ${params.code ?? 'unknown'}`,
      stdout: params.stdout,
      stderr: params.stderr,
    };
  }

  const incompleteMessage = extractAgentOutputIncompleteText(params.stdout);
  if (incompleteMessage) {
    return {
      type: 'failed',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      jobId: params.jobId,
      runId: params.runId,
      code: params.code,
      message: incompleteMessage,
      stdout: params.stdout,
      stderr: params.stderr,
    };
  }

  return {
    type: 'completed',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    jobId: params.jobId,
    runId: params.runId,
    code: params.code,
    stdout: params.stdout,
    stderr: params.stderr,
  };
}
