DO $$
DECLARE
  target_board_id text;
  target_card_ids text[];
BEGIN
  FOR target_board_id IN
    SELECT id FROM "boards" WHERE "name" = 'auto-dev-cards'
  LOOP
    SELECT COALESCE(array_agg(card_id), ARRAY[]::text[])
    INTO target_card_ids
    FROM (
      SELECT bc."card_id"
      FROM "board_cards" bc
      WHERE bc."card_id" IN (
        SELECT "card_id"
        FROM "board_cards"
        WHERE "board_id" = target_board_id
      )
      GROUP BY bc."card_id"
      HAVING COUNT(*) FILTER (WHERE bc."board_id" <> target_board_id) = 0
        AND COUNT(*) = 1
    ) board_only_cards;

    UPDATE "workspaces"
    SET "board_ids" = COALESCE(
      (
        SELECT jsonb_agg(board_id)
        FROM jsonb_array_elements("workspaces"."board_ids") AS board_id
        WHERE board_id <> to_jsonb(target_board_id)
      ),
      '[]'::jsonb
    )
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements("workspaces"."board_ids") AS board_id
      WHERE board_id = to_jsonb(target_board_id)
    );

    DELETE FROM "agent_batch_run_items"
    WHERE "source_type" = 'board' AND "source_id" = target_board_id;

    DELETE FROM "agent_batch_run_items"
    WHERE "card_id" = ANY(target_card_ids);

    DELETE FROM "agent_batch_runs"
    WHERE "source_type" = 'board' AND "source_id" = target_board_id;

    DELETE FROM "card_comments"
    WHERE "card_id" = ANY(target_card_ids);

    DELETE FROM "card_links"
    WHERE "source_card_id" = ANY(target_card_ids)
       OR "target_card_id" = ANY(target_card_ids);

    DELETE FROM "card_tags"
    WHERE "card_id" = ANY(target_card_ids);

    UPDATE "agent_chat_queue"
    SET "last_run_id" = NULL
    WHERE "last_run_id" IN (
      SELECT "id" FROM "agent_runs" WHERE "card_id" = ANY(target_card_ids)
    );

    DELETE FROM "agent_batch_run_items"
    WHERE "agent_run_id" IN (
      SELECT "id" FROM "agent_runs" WHERE "card_id" = ANY(target_card_ids)
    );

    DELETE FROM "agent_runs"
    WHERE "card_id" = ANY(target_card_ids);

    DELETE FROM "board_cron_templates"
    WHERE "board_id" = target_board_id;

    DELETE FROM "board_cards"
    WHERE "board_id" = target_board_id;

    DELETE FROM "board_columns"
    WHERE "board_id" = target_board_id;

    DELETE FROM "cards"
    WHERE "id" = ANY(target_card_ids);

    DELETE FROM "boards"
    WHERE "id" = target_board_id;
  END LOOP;
END $$;
