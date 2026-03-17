# Request Clarification

Use this guide whenever a user request could plausibly refer to multiple
concepts, systems, scopes, or outputs.

## Required behavior

- Identify the likely interpretations before taking action.
- Check the most relevant local context first: existing repo conventions,
  available skills, nearby docs, and product-specific terminology.
- If two or more interpretations remain plausible, ask a clarification
  question before creating files, calling APIs, or making irreversible changes.
- Prefer concrete clarification over generic confirmation. Name the competing
  interpretations explicitly.
- If one interpretation is clearly dominant after checking context, proceed and
  state that assumption briefly.

## Minimum clarification standard

- Mention the ambiguous term or scope.
- Give the top plausible interpretations.
- Ask the user to choose or confirm the intended one.

## Example

If a user asks to "create a skill" in OpenWork, first check whether they mean a
local agent skill folder or an OpenWork platform skill attached through the API.
If both are plausible, ask which target they want before implementing either.
