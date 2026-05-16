UPDATE "agent_runs"
SET "legacy_data" = '{}'::jsonb
WHERE "legacy_data" IS NOT NULL
  AND "legacy_data" <> '{}'::jsonb;
