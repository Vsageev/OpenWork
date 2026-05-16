CREATE TABLE "agent_chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"parent_turn_id" text,
	"user_message_id" text,
	"assistant_message_id" text,
	"status" text NOT NULL,
	"run_id" text,
	"source" text DEFAULT 'user' NOT NULL,
	"created_by_id" text,
	"turn_type" text DEFAULT 'follow_up' NOT NULL,
	"supersedes_turn_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "turn_id" text;
--> statement-breakpoint
ALTER TABLE "agent_chat_queue" ADD COLUMN IF NOT EXISTS "turn_id" text;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_parent_turn_id_agent_chat_turns_id_fk" FOREIGN KEY ("parent_turn_id") REFERENCES "public"."agent_chat_turns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_turns" ADD CONSTRAINT "agent_chat_turns_supersedes_turn_id_agent_chat_turns_id_fk" FOREIGN KEY ("supersedes_turn_id") REFERENCES "public"."agent_chat_turns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_turn_id_agent_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_chat_turns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_chat_queue" ADD CONSTRAINT "agent_chat_queue_turn_id_agent_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_chat_turns"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_conversation_created_idx" ON "agent_chat_turns" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_agent_conversation_idx" ON "agent_chat_turns" USING btree ("agent_id","conversation_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_parent_turn_idx" ON "agent_chat_turns" USING btree ("parent_turn_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_user_message_idx" ON "agent_chat_turns" USING btree ("user_message_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_assistant_message_idx" ON "agent_chat_turns" USING btree ("assistant_message_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_run_idx" ON "agent_chat_turns" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_supersedes_idx" ON "agent_chat_turns" USING btree ("supersedes_turn_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_turns_status_idx" ON "agent_chat_turns" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "agent_runs_turn_id_idx" ON "agent_runs" USING btree ("turn_id");
--> statement-breakpoint
CREATE INDEX "agent_chat_queue_turn_id_idx" ON "agent_chat_queue" USING btree ("turn_id");
