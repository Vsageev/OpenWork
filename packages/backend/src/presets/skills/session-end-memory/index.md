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

- User provided feedback/correction on you work.
- The insight/flow is likely to matter again.
- Prefer updating an existing local notes or memory file instead of creating
  many new files.
- Keep memory concise and factual: stable paths, conventions, decisions,
  pitfalls, or follow-up context.
- Do not store secrets, credentials, temporary debugging noise, or speculative
  claims.

## File choice

- Prefer editring an existing file when it makes sense.
- Make sure the information is easily searchable in future sessions by choosing file naming/placement and wodr choice/search tags.

## Reporting

- Mention memory updates in the final response when you make them.
