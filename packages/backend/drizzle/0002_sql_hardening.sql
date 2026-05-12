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
