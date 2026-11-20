-- Explicit manual intents share the durable outbox; they are never automatic replies.
ALTER TABLE ai_outbox DROP CONSTRAINT ai_outbox_kind_check;
ALTER TABLE ai_outbox ADD CONSTRAINT ai_outbox_kind_check
 CHECK (kind IN ('first_message','reply','follow_up','manual_reply'));
CREATE UNIQUE INDEX ai_outbox_manual_operation_idx ON ai_outbox(logical_key)
 WHERE kind='manual_reply';
