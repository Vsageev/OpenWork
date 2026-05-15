CREATE TABLE "agent_runner_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runner_tokens" ADD CONSTRAINT "agent_runner_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runner_tokens_hash_idx" ON "agent_runner_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_runner_tokens_user_id_idx" ON "agent_runner_tokens" USING btree ("user_id");