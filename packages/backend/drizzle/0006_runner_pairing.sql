CREATE TABLE "agent_runners" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credential_hash" text NOT NULL,
	"credential_prefix" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runner_pairing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runners" ADD CONSTRAINT "agent_runners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runners" ADD CONSTRAINT "agent_runners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runner_pairing_codes" ADD CONSTRAINT "agent_runner_pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runner_pairing_codes" ADD CONSTRAINT "agent_runner_pairing_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runners_credential_hash_idx" ON "agent_runners" USING btree ("credential_hash");
--> statement-breakpoint
CREATE INDEX "agent_runners_user_workspace_idx" ON "agent_runners" USING btree ("user_id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runner_pairing_codes_hash_idx" ON "agent_runner_pairing_codes" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX "agent_runner_pairing_codes_user_workspace_idx" ON "agent_runner_pairing_codes" USING btree ("user_id","workspace_id");
