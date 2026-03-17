# Session End Memory

Before ending the session, re-check the local files that matter to the result
and decide whether any durable memory should be written back.

## End-of-session checks

- Revisit the instruction or memory files you relied on if they affect the
  final answer.
- Re-open files you changed when you need to confirm the final on-disk state.
- Check whether there is an existing memory or notes file that should be
  updated for future sessions.

## When to write memory

- Write memory only when the information is likely to matter again.
- Prefer updating an existing local notes or memory file instead of creating
  many new files.
- Keep memory concise and factual: stable paths, conventions, decisions,
  pitfalls, or follow-up context.
- Do not store secrets, credentials, temporary debugging noise, or speculative
  claims.

## File choice

- Prefer an existing file such as `MEMORIES.md`, `memory.md`, `notes.md`, or a
  project-specific notes file.
- Create a new memory file only when the information is durable enough to
  justify another long-lived file.

## Reporting

- Mention memory updates in the final response when you make them.
