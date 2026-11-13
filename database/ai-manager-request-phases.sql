-- Channel threads outlive business requests; immutable source identities prevent replay.
ALTER TABLE ai_requests ADD COLUMN lifecycle text NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','closed'));
ALTER TABLE ai_requests ADD COLUMN closed_at timestamptz;
CREATE TABLE ai_request_phases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 first_ingest_sequence bigint NOT NULL DEFAULT 0,
 settings_version integer NOT NULL REFERENCES ai_engine_settings(version),
 fields_snapshot jsonb NOT NULL DEFAULT '{}',
 reply_count_snapshot integer NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 UNIQUE(request_id,conversation_id)
);
CREATE UNIQUE INDEX ai_request_phases_active_idx ON ai_request_phases(conversation_id) WHERE closed_at IS NULL;
ALTER TABLE ai_conversations ADD COLUMN active_phase_id uuid REFERENCES ai_request_phases(id) ON DELETE RESTRICT;
CREATE TABLE ai_request_sources (
 account_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),
 external_chat_id text NOT NULL CHECK(length(external_chat_id) BETWEEN 1 AND 512),
 external_message_id text NOT NULL CHECK(length(external_message_id) BETWEEN 1 AND 512),
 author_id text NOT NULL CHECK(length(author_id) BETWEEN 1 AND 512),
 request_id uuid NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,platform,external_chat_id,external_message_id)
);
CREATE INDEX ai_request_sources_request_idx ON ai_request_sources(request_id);
-- Preserve existing conversations as their own historical phases. Do not guess
-- which of the old manually created requests belongs to an existing dialogue.
INSERT INTO ai_requests(id,contact_id,lifecycle,closed_at)
 SELECT v.id,v.contact_id,CASE WHEN v.business_status='closed' THEN 'closed' ELSE 'open' END,
 CASE WHEN v.business_status='closed' THEN now() END FROM ai_conversations v;
INSERT INTO ai_request_phases(request_id,conversation_id,settings_version,fields_snapshot,reply_count_snapshot,closed_at)
 SELECT v.id,v.id,s.settings_version,s.fields,s.reply_count,
 CASE WHEN v.business_status='closed' THEN now() END FROM ai_conversations v JOIN ai_engine_state s ON s.conversation_id=v.id;
UPDATE ai_conversations v SET active_phase_id=p.id FROM ai_request_phases p WHERE p.conversation_id=v.id;
-- Closing a request archives model state. Reopening requires a new source and phase.
CREATE FUNCTION ai_request_archive_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.business_status='closed' AND OLD.business_status IS DISTINCT FROM 'closed' AND NEW.active_phase_id IS NOT NULL THEN
  UPDATE ai_request_phases p SET closed_at=now(),fields_snapshot=s.fields,reply_count_snapshot=s.reply_count
   FROM ai_engine_state s WHERE p.request_id=(SELECT request_id FROM ai_request_phases WHERE id=NEW.active_phase_id) AND p.closed_at IS NULL AND s.conversation_id=p.conversation_id;
  UPDATE ai_requests SET lifecycle='closed',closed_at=now()
   WHERE id=(SELECT request_id FROM ai_request_phases WHERE id=NEW.active_phase_id);
  UPDATE ai_conversations SET business_status='closed',automation_mode='paused',automation_epoch=automation_epoch+1,manager_hold=false
   WHERE id<>NEW.id AND business_status<>'closed' AND active_phase_id IN (SELECT id FROM ai_request_phases WHERE request_id=(SELECT request_id FROM ai_request_phases WHERE id=NEW.active_phase_id));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_request_archive_closed AFTER UPDATE OF business_status ON ai_conversations
 FOR EACH ROW EXECUTE FUNCTION ai_request_archive_closed();
-- Persist phase ownership at insertion; later phase switches cannot relabel history.
CREATE FUNCTION ai_request_pin_phase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT active_phase_id INTO NEW.request_phase_id FROM ai_conversations WHERE id=NEW.conversation_id;
 RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['ai_inbox','ai_outbox','ai_engine_decisions','ai_handoff_notifications','ai_followup_jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN request_phase_id uuid REFERENCES ai_request_phases(id) ON DELETE RESTRICT',table_name);
  EXECUTE format('UPDATE %I t SET request_phase_id=v.active_phase_id FROM ai_conversations v WHERE v.id=t.conversation_id',table_name);
  EXECUTE format('CREATE TRIGGER pin_request_phase BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION ai_request_pin_phase()',table_name);
  EXECUTE format('CREATE INDEX %I ON %I(request_phase_id)',table_name||'_phase_idx',table_name);
 END LOOP;
END $$;
