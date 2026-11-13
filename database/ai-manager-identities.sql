CREATE TABLE ai_remote_identities (
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),
 namespace text NOT NULL,
 remote_user_id text NOT NULL CHECK(length(remote_user_id) BETWEEN 1 AND 512),
 contact_id uuid NOT NULL REFERENCES ai_contacts(id) ON DELETE RESTRICT,
 verified_phone text CHECK(verified_phone IS NULL OR verified_phone ~ '^\+[1-9][0-9]{6,14}$'),
 verification_kind text NOT NULL CHECK(verification_kind IN ('source_author','max_contact','whatsapp_contact')),
 verified_account_id uuid NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),
 phone_verified_at timestamptz,
 PRIMARY KEY(platform,namespace,remote_user_id)
);
CREATE INDEX ai_remote_identities_contact_idx ON ai_remote_identities(contact_id);
-- The source reader and chosen sender need not be the same connected account.
ALTER TABLE ai_request_sources ADD COLUMN reader_account_id uuid;
ALTER TABLE ai_request_sources ADD COLUMN recipient_id text;
UPDATE ai_request_sources SET reader_account_id=account_id,recipient_id=author_id;
ALTER TABLE ai_request_sources ALTER COLUMN reader_account_id SET NOT NULL;
ALTER TABLE ai_request_sources ALTER COLUMN recipient_id SET NOT NULL;
ALTER TABLE ai_request_sources DROP CONSTRAINT ai_request_sources_pkey;
ALTER TABLE ai_request_sources ADD PRIMARY KEY(reader_account_id,platform,external_chat_id,external_message_id);
CREATE INDEX ai_request_sources_sender_idx ON ai_request_sources(account_id);
ALTER TABLE ai_request_sources ADD COLUMN occurred_at timestamptz;
UPDATE ai_request_sources SET occurred_at=created_at;
ALTER TABLE ai_request_sources ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE ai_request_sources ADD COLUMN initial_contact boolean NOT NULL DEFAULT false;
-- A definite negative qualification gets the client farewell, not an insufficient-data alert.
-- Keep the durable outcome row as proof of the completion notice.
UPDATE ai_handoff_notifications n SET state='rejected',outcome_code='qualification_not_passed',updated_at=now()
 WHERE n.state='pending' AND n.reason='insufficient_data' AND EXISTS(
 SELECT 1 FROM ai_engine_decisions d WHERE d.conversation_id=n.conversation_id
 AND n.logical_key='ai-handoff:'||d.id::text AND d.business_status='unqualified');
CREATE TABLE ai_verified_routes (
 conversation_id uuid PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),
 external_id text NOT NULL,
 recipient_id text NOT NULL,
 contact_id uuid NOT NULL REFERENCES ai_contacts(id) ON DELETE RESTRICT,
 verified_phone text,
 verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,platform,external_id)
);
