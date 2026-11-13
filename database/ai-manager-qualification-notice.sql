-- Completion receipts share the durable outbox; never reopen general automation after handoff.
ALTER TABLE ai_outbox DROP CONSTRAINT ai_outbox_kind_check;
ALTER TABLE ai_outbox ADD CONSTRAINT ai_outbox_kind_check CHECK
 (kind IN ('first_message','reply','follow_up','manual_reply','qualification_notice'));
CREATE UNIQUE INDEX ai_outbox_qualification_notice_idx ON ai_outbox(logical_key)
 WHERE kind='qualification_notice';
