CREATE TABLE "agent_avatar_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar_icon" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_batch_run_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"card_id" text NOT NULL,
	"card_name" text NOT NULL,
	"card_description" text,
	"card_collection_id" text NOT NULL,
	"order_index" integer NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"agent_run_id" text,
	"stage_id" text,
	"depends_on_item_ids" jsonb,
	"blocking_mode" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_batch_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_name" text,
	"agent_id" text NOT NULL,
	"prompt" text NOT NULL,
	"max_parallel" integer NOT NULL,
	"status" text NOT NULL,
	"total" integer NOT NULL,
	"queued" integer NOT NULL,
	"processing" integer NOT NULL,
	"completed" integer NOT NULL,
	"failed" integer NOT NULL,
	"cancelled" integer NOT NULL,
	"skipped" integer,
	"stage_count" integer,
	"dependency_item_count" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_chat_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"mode" text NOT NULL,
	"prompt" text,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"run_id" text,
	"last_run_id" text,
	"target_message_id" text,
	"continuation_parent_id" text,
	"depends_on_queue_item_id" text,
	"previous_user_message_id" text,
	"queued_message_id" text,
	"response_message_id" text,
	"error_message" text,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"used_fallback" boolean,
	"fallback_model" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_color_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"color" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_env_vars" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"encrypted_value" text NOT NULL,
	"value_preview" text,
	"is_active" boolean NOT NULL,
	"created_by_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_external_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"provider" text,
	"key_hash" text,
	"key_prefix" text,
	"encrypted_value" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"order_index" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"model" text,
	"model_id" text,
	"trigger_type" text NOT NULL,
	"trigger_prompt" text,
	"status" text NOT NULL,
	"conversation_id" text,
	"card_id" text,
	"cron_job_id" text,
	"pid" integer,
	"stdout_path" text,
	"stderr_path" text,
	"stdout" text,
	"stderr" text,
	"error_message" text,
	"response_text" text,
	"response_parent_id" text,
	"killed_by_user" boolean,
	"avatar_icon" text,
	"avatar_bg_color" text,
	"avatar_logo_color" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"model" text,
	"model_id" text,
	"thinking_level" text,
	"preset" text,
	"preset_parameters" jsonb,
	"status" text NOT NULL,
	"api_key_id" text,
	"api_key_name" text,
	"api_key_prefix" text,
	"workspace_api_key" text,
	"workspace_api_key_id" text,
	"capabilities" jsonb,
	"skip_permissions" boolean,
	"group_id" text,
	"service_user_id" text,
	"repository_root" text,
	"workspace_path" text,
	"separate_folder_per_chat" boolean,
	"skill_ids" jsonb,
	"cron_jobs" jsonb,
	"avatar_icon" text,
	"avatar_bg_color" text,
	"avatar_logo_color" text,
	"last_activity" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_by_id" text,
	"is_active" boolean NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"changes" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"card_id" text NOT NULL,
	"column_id" text NOT NULL,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"position" double precision NOT NULL,
	"wip_limit" integer,
	"assign_agent_id" text,
	"assign_agent_prompt" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_cron_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text,
	"agent_id" text,
	"schedule" text,
	"prompt" text,
	"config" jsonb,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"collection_id" text,
	"default_collection_id" text,
	"is_general" boolean,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"author_id" text NOT NULL,
	"agent_run_id" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
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
CREATE TABLE "card_links" (
	"id" text PRIMARY KEY NOT NULL,
	"source_card_id" text NOT NULL,
	"target_card_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_tags" (
	"card_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"legacy_data" jsonb NOT NULL,
	CONSTRAINT "card_tags_card_id_tag_id_pk" PRIMARY KEY("card_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"custom_fields" jsonb NOT NULL,
	"created_by_id" text,
	"assignee_id" text,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_general" boolean,
	"agent_batch_config" jsonb,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"status_message" text,
	"capabilities" jsonb NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"assignee_id" text,
	"channel_type" text NOT NULL,
	"status" text NOT NULL,
	"subject" text,
	"external_id" text,
	"is_unread" boolean NOT NULL,
	"last_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"metadata" jsonb,
	"provider" text,
	"model_id" text,
	"active_chatbot_flow_id" text,
	"chatbot_flow_step_id" text,
	"chatbot_flow_data" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_path" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text,
	"checksum" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"status" text NOT NULL,
	"external_id" text,
	"parent_id" text,
	"previous_user_message_id" text,
	"attachments" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "json_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"default_agent_key_id" text,
	"fallback_model" text,
	"fallback_model_id" text,
	"agent_prompt_max" integer,
	"agent_prompt_window_s" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_bots" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"bot_id" text NOT NULL,
	"bot_username" text NOT NULL,
	"bot_first_name" text NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"status" text NOT NULL,
	"status_message" text,
	"auto_greeting_enabled" boolean NOT NULL,
	"auto_greeting_text" text,
	"created_by_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"type" text,
	"agent_id" text,
	"is_active" boolean NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean NOT NULL,
	"recovery_codes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" text,
	"attempt" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_retry_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" jsonb NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"board_ids" jsonb NOT NULL,
	"collection_ids" jsonb NOT NULL,
	"agent_group_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"legacy_data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_batch_run_items" ADD CONSTRAINT "agent_batch_run_items_run_id_agent_batch_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_batch_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_batch_run_items" ADD CONSTRAINT "agent_batch_run_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_batch_run_items" ADD CONSTRAINT "agent_batch_run_items_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_batch_run_items" ADD CONSTRAINT "agent_batch_run_items_card_collection_id_collections_id_fk" FOREIGN KEY ("card_collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_batch_run_items" ADD CONSTRAINT "agent_batch_run_items_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_batch_runs" ADD CONSTRAINT "agent_batch_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_queue" ADD CONSTRAINT "agent_chat_queue_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_queue" ADD CONSTRAINT "agent_chat_queue_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_queue" ADD CONSTRAINT "agent_chat_queue_last_run_id_agent_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_env_vars" ADD CONSTRAINT "agent_env_vars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_env_vars" ADD CONSTRAINT "agent_env_vars_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_external_api_keys" ADD CONSTRAINT "agent_external_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_api_key_id_api_keys_id_fk" FOREIGN KEY ("workspace_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_group_id_agent_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_column_id_board_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."board_columns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cron_templates" ADD CONSTRAINT "board_cron_templates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cron_templates" ADD CONSTRAINT "board_cron_templates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_default_collection_id_collections_id_fk" FOREIGN KEY ("default_collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_comments" ADD CONSTRAINT "card_comments_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_source_card_id_cards_id_fk" FOREIGN KEY ("source_card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_target_card_id_cards_id_fk" FOREIGN KEY ("target_card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_default_agent_key_id_api_keys_id_fk" FOREIGN KEY ("default_agent_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_batch_run_items_run_id_idx" ON "agent_batch_run_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_batch_run_items_card_id_idx" ON "agent_batch_run_items" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "agent_batch_run_items_agent_run_id_idx" ON "agent_batch_run_items" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_batch_runs_agent_id_idx" ON "agent_batch_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_batch_runs_source_idx" ON "agent_batch_runs" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "agent_chat_queue_agent_id_idx" ON "agent_chat_queue" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_chat_queue_conversation_id_idx" ON "agent_chat_queue" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_chat_queue_status_idx" ON "agent_chat_queue" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_env_vars_agent_key_idx" ON "agent_env_vars" USING btree ("agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_env_vars_created_by_id_idx" ON "agent_env_vars" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_id_idx" ON "agent_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_runs_card_id_idx" ON "agent_runs" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "agents_api_key_id_idx" ON "agents" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "agents_group_id_idx" ON "agents" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "agents_service_user_id_idx" ON "agents" USING btree ("service_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_id_idx" ON "api_keys" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_cards_board_card_idx" ON "board_cards" USING btree ("board_id","card_id");--> statement-breakpoint
CREATE INDEX "board_cards_column_id_idx" ON "board_cards" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "board_columns_board_id_idx" ON "board_columns" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_columns_assign_agent_id_idx" ON "board_columns" USING btree ("assign_agent_id");--> statement-breakpoint
CREATE INDEX "boards_collection_id_idx" ON "boards" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "boards_default_collection_id_idx" ON "boards" USING btree ("default_collection_id");--> statement-breakpoint
CREATE INDEX "boards_created_by_id_idx" ON "boards" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "card_comments_card_id_idx" ON "card_comments" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_comments_author_id_idx" ON "card_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "card_comments_agent_run_id_idx" ON "card_comments" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "contacts_telegram_id_idx" ON "contacts" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX "card_links_source_card_id_idx" ON "card_links" USING btree ("source_card_id");--> statement-breakpoint
CREATE INDEX "card_links_target_card_id_idx" ON "card_links" USING btree ("target_card_id");--> statement-breakpoint
CREATE INDEX "cards_collection_id_idx" ON "cards" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "cards_created_by_id_idx" ON "cards" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "cards_assignee_id_idx" ON "cards" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "collections_created_by_id_idx" ON "collections" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "message_drafts_conversation_id_idx" ON "message_drafts" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_parent_id_idx" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "messages_previous_user_message_id_idx" ON "messages" USING btree ("previous_user_message_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telegram_bots_created_by_id_idx" ON "telegram_bots" USING btree ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_agent_id_idx" ON "users" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhooks_created_by_id_idx" ON "webhooks" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "workspaces_user_id_idx" ON "workspaces" USING btree ("user_id");
