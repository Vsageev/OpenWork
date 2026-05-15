CREATE TABLE IF NOT EXISTS "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"email" text,
	"phone" text,
	"source" text,
	"telegram_id" text,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_telegram_id_idx" ON "contacts" USING btree ("telegram_id");
--> statement-breakpoint
INSERT INTO "contacts" (
	"id",
	"first_name",
	"created_at",
	"updated_at",
	"legacy_data"
)
SELECT
	"contact_id",
	"contact_id",
	NOW(),
	NOW(),
	'{}'::jsonb
FROM (
	SELECT DISTINCT "contact_id"
	FROM "conversations"
	WHERE "contact_id" IS NOT NULL
) AS missing_conversation_contacts
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "contacts" (
	"id",
	"first_name",
	"created_at",
	"updated_at",
	"legacy_data"
)
VALUES (
	'system',
	'system',
	NOW(),
	NOW(),
	'{}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "conversations" (
	"id",
	"contact_id",
	"channel_type",
	"status",
	"subject",
	"is_unread",
	"last_message_at",
	"created_at",
	"updated_at",
	"legacy_data"
)
SELECT
	"id",
	'system',
	'agent',
	'open',
	'Recovered conversation',
	false,
	"last_activity_at",
	"created_at",
	NOW(),
	'{"recoveredFromOrphanedReferences":true}'::jsonb
FROM (
	SELECT
		"conversation_id" AS "id",
		MIN("created_at") AS "created_at",
		MAX("created_at") AS "last_activity_at"
	FROM "messages"
	WHERE "conversation_id" IS NOT NULL
	GROUP BY "conversation_id"
	UNION
	SELECT
		"conversation_id" AS "id",
		MIN("started_at") AS "created_at",
		MAX("started_at") AS "last_activity_at"
	FROM "agent_runs"
	WHERE "conversation_id" IS NOT NULL
	GROUP BY "conversation_id"
) AS missing_referenced_conversations
WHERE NOT EXISTS (
	SELECT 1
	FROM "conversations"
	WHERE "conversations"."id" = missing_referenced_conversations."id"
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "conversations"
SET "assignee_id" = NULL
WHERE "assignee_id" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "users"
		WHERE "users"."id" = "conversations"."assignee_id"
	);
--> statement-breakpoint
UPDATE "board_columns"
SET "assign_agent_id" = NULL
WHERE "assign_agent_id" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "agents"
		WHERE "agents"."id" = "board_columns"."assign_agent_id"
	);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_assign_agent_id_agents_id_fk" FOREIGN KEY ("assign_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conv_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "cards_collection_position_idx" ON "cards" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "board_cards_board_position_idx" ON "board_cards" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "conversations_assignee_last_msg_idx" ON "conversations" USING btree ("assignee_id","last_message_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_agent_started_idx" ON "agent_runs" USING btree ("status","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_conv_status_idx" ON "agent_runs" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_live_chat_idx" ON "agent_runs" USING btree ("agent_id","conversation_id") WHERE "status" = 'running' AND "trigger_type" = 'chat';--> statement-breakpoint
CREATE INDEX "agent_chat_queue_agent_conv_created_idx" ON "agent_chat_queue" USING btree ("agent_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_chat_queue_status_next_attempt_idx" ON "agent_chat_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_batch_run_items_run_status_idx" ON "agent_batch_run_items" USING btree ("run_id","status");
