CREATE TABLE ai_monitor_settings(
 id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 0,
 mode text NOT NULL DEFAULT 'stopped' CHECK(mode IN ('active','paused','stopped')),
 epoch bigint NOT NULL DEFAULT 0,started_at timestamptz,
 settings jsonb NOT NULL DEFAULT '{"instructions":"","includeTerms":[],"excludeTerms":[],"confidenceThreshold":0.9,"autoContact":true}',
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_monitor_settings(id)VALUES(1);
CREATE TABLE ai_source_messages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),account_id uuid NOT NULL,
 chat_id text NOT NULL,author_id text NOT NULL,message_id text NOT NULL,occurred_at timestamptz NOT NULL,
 fingerprint text NOT NULL,original_text text,
 monitor_epoch bigint NOT NULL,monitor_revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','classified','ignored')),
 reason text,scoring_token uuid,retry_after timestamptz,lease_until timestamptz,
 captured_at timestamptz NOT NULL DEFAULT now(),classified_at timestamptz,
 UNIQUE(platform,chat_id,message_id)
);
CREATE INDEX ai_source_pending_idx ON ai_source_messages(captured_at,id) WHERE state='pending';
ALTER TABLE ai_leads DROP CONSTRAINT ai_leads_source_kind_check;
ALTER TABLE ai_leads ADD CONSTRAINT ai_leads_source_kind_check CHECK(source_kind IN ('manual','fixture','monitor'));
ALTER TABLE ai_leads ADD COLUMN source_message_id uuid UNIQUE REFERENCES ai_source_messages(id) ON DELETE RESTRICT;
ALTER TABLE ai_leads ADD COLUMN classification jsonb;
ALTER TABLE ai_request_sources ADD COLUMN lead_id uuid REFERENCES ai_leads(id) ON DELETE RESTRICT;
CREATE TABLE ai_source_cursors(
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),account_id uuid NOT NULL,chat_id text NOT NULL,
 monitor_epoch bigint NOT NULL,through_time bigint NOT NULL CHECK(through_time>=0),last_error text,last_completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(platform,chat_id)
);
ALTER TABLE ai_leads ADD COLUMN activation_after timestamptz;
ALTER TABLE ai_leads ADD COLUMN activation_error text;
ALTER TABLE integrations ADD COLUMN whatsapp_self_aliases jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(whatsapp_self_aliases)='array');
CREATE TABLE ai_source_runtime_status(role text PRIMARY KEY CHECK(role IN ('coordinator','max-reader','whatsapp-reader')),enabled boolean NOT NULL,heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp());
