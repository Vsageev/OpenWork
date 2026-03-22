---
name: Research Breadth
description: Use this skill when the user wants broad, high-coverage research with diverse evidence, competing viewpoints, and a stronger final synthesis.
---

# Research Breadth

Use this skill when the user wants the agent to build the widest reliable
understanding of a topic instead of stopping at the first plausible answer.

This applies when:
- the request needs a landscape, survey, comparison, market map, or playbook
- the topic has multiple schools, tradeoffs, or fragmented evidence
- the obvious answer would likely be too narrow, stale, or one-sided
- the user wants maximum useful coverage, not just a quick summary

## Default stance

- Treat research as a coverage problem first and a writing problem second.
- Assume the first framing is incomplete until different source families and
  viewpoints have been checked.
- Prefer discovering missing categories over collecting more examples from the
  same category.
- Keep pushing until new search rounds mostly repeat known themes instead of
  adding materially new information.

## Operating loop

1. **Lock the real research target.** Identify the deliverable the user is
   actually asking for: best practices, tooling landscape, implementation
   options, operational guidance, current state, failure modes, or something
   else. If the request has more than one plausible interpretation, cover the
   main branches instead of silently collapsing to one.
2. **Build a search matrix before going deep.** Expand across independent
   dimensions such as official versus independent material, conceptual versus
   implementation detail, current versus historical, strategic versus
   operational, positive versus critical, and expert versus beginner-oriented
   guidance.
3. **Research in waves.** Start with the direct path, then deliberately widen.
   After each wave, name what is still thin: missing categories, missing
   dissent, missing concrete examples, weak evidence, stale information, or
   unclear terminology.
4. **Change approach class when stuck.** Do not just paraphrase the same query.
   Pivot source family, framing, stakeholder, time horizon, abstraction level,
   or adjacent artifact.
5. **Collect disagreement on purpose.** When multiple approaches exist, surface
   what each one optimizes for, where it breaks down, and which contexts change
   the recommendation.
6. **Promote facts into structure.** Organize findings into categories,
   patterns, schools, or decision branches. The output should explain the shape
   of the space, not only list facts.
7. **Stop only on saturation.** Stop when the answer, major categories,
   competing views, representative examples, and key uncertainties are all
   covered and additional searching mostly yields repetition.

## Evidence rules

- Prefer category coverage over example hoarding.
- Use multiple evidence classes when the topic allows it instead of relying on
  one article, vendor, or source family.
- When one source class dominates, deliberately seek a materially different
  class that can confirm, challenge, or sharpen the conclusion.
- Separate direct evidence, expert opinion, implementation examples, incident
  reports, critiques, and secondary summaries.
- Ground important claims in traceable specifics: source links, identifiers,
  code, concrete examples, dates, or repeated corroboration.
- For time-sensitive topics, favor recency and say when the answer may age.
- When the request centers on one concrete source or object, verify how the
  recovered evidence maps back to that original target.

## Output shape

Include:
- a direct answer first
- a category map, landscape map, or decision structure
- the strongest evidence trail across different source classes
- tradeoffs, disagreements, and edge cases
- confidence, gaps, and remaining uncertainty

Adapt the depth to the request. A simple question still needs breadth in the
research process, but the final answer should not be padded with unnecessary
taxonomy.

## Recovery rules

- If the research keeps circling the same material, explicitly name the missing
  dimension and branch into a new one.
- If evidence is weak or contradictory, say that directly instead of flattening
  it into a false conclusion.
- If the topic is broad, state which parts are well covered and which remain
  thin.
- If a narrower answer would mislead, include the adjacent context needed to
  make the answer decision-useful.
