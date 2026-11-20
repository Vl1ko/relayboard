-- Preserve the protocol-generated ID before any CDP commit. Never infer a receipt
-- from matching text or timestamps. Multiple preparations are retained separately.
CREATE TABLE ai_whatsapp_send_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 action_id uuid NOT NULL REFERENCES ai_outbox(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL,
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 reserved_message_id text NOT NULL CHECK(length(reserved_message_id) BETWEEN 1 AND 512),
 target_id text NOT NULL CHECK(target_id ~ '^[1-9][0-9]{0,30}@(c\.us|lid)$'),
 recipient_aliases jsonb NOT NULL CHECK(jsonb_typeof(recipient_aliases)='array'),
 self_aliases jsonb NOT NULL CHECK(jsonb_typeof(self_aliases)='array'),
 prepared_at timestamptz NOT NULL DEFAULT now(),
 server_ack integer CHECK(server_ack>=1),
 observed_body_hash text CHECK(observed_body_hash IS NULL OR observed_body_hash ~ '^[a-f0-9]{64}$'),
 ack_verified_at timestamptz,
 UNIQUE(account_id,reserved_message_id)
);
CREATE INDEX ai_whatsapp_intents_action_idx ON ai_whatsapp_send_intents(action_id);
ALTER TABLE integrations ADD COLUMN whatsapp_self_id text;
CREATE UNIQUE INDEX integrations_enabled_whatsapp_identity_idx ON integrations(whatsapp_self_id)
 WHERE platform='whatsapp' AND enabled AND whatsapp_self_id IS NOT NULL;
CREATE TABLE ai_whatsapp_private_cursors (
 conversation_id uuid PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 phase_id uuid NOT NULL REFERENCES ai_request_phases(id) ON DELETE RESTRICT,
 through_time bigint NOT NULL CHECK(through_time>=0),
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only a verified pre-commit rejection may be prepared again. Unknown outcomes
-- deliberately have none of this retry proof and cannot enter pending.
ALTER TABLE ai_outbox ADD COLUMN dispatch_state text CHECK(dispatch_state IS NULL OR dispatch_state='not_started');
ALTER TABLE ai_outbox ADD COLUMN retry_condition text CHECK(retry_condition IS NULL OR retry_condition IN ('never','refresh_auth','after_delay','reconcile_or_manual_review'));
ALTER TABLE ai_outbox ADD COLUMN retry_after timestamptz;
ALTER TABLE ai_outbox ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0);
CREATE INDEX ai_outbox_safe_retry_idx ON ai_outbox(retry_after) WHERE state='rejected' AND dispatch_state='not_started';
