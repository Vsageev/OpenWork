# Session Start

At the beginning of each session, gather the local context that is most likely
to matter for the current task before you act.

## Read first

- The agent entrypoint file in the current folder (`AGENTS.md`, `CLAUDE.MD`,
  or equivalent).
- Any attached skill entrypoints referenced from that file.
- Files explicitly named by the user.
- Nearby project docs, configs, or source files that are likely to constrain
  the task.
- Existing local memory files such as `MEMORIES.md`, `memory.md`, `notes.md`,
  or similarly named docs if they exist.

## Scope the research

- Start from the current folder unless instructions say otherwise.
- Prefer targeted reads and `rg` searches over broad file dumps.
- Read only what is needed to understand the request, constraints, and
  established conventions.
- If multiple interpretations remain plausible after checking the likely
  context, ask a clarification question before making changes.

## While responding

- Do not dump everything you read.
- Briefly surface the constraints or assumptions you found when they affect the
  work.
