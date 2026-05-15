ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "executor" text DEFAULT 'local' NOT NULL;
