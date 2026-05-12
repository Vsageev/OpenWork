CREATE INDEX "agent_chat_queue_run_processing_idx" ON "agent_chat_queue" USING btree ("run_id") WHERE "agent_chat_queue"."status" = 'processing' and "agent_chat_queue"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "board_cards_card_id_idx" ON "board_cards" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_tags_tag_id_idx" ON "card_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_external_uidx" ON "conversations" USING btree ("channel_type","external_id") WHERE "conversations"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_external_id_idx" ON "messages" USING btree ("external_id") WHERE "messages"."external_id" is not null;
