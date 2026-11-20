CREATE TABLE ai_engine_settings (
 version integer PRIMARY KEY,
 settings jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_engine_settings(version,settings) VALUES(1,'{"provider":"unselected","model":null,"knowledge":[],"fields":[],"rules":[],"qualificationEnabled":false,"tone":"Вежливо и кратко","replyLimit":5}');
CREATE TABLE ai_engine_state (
 conversation_id uuid PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 settings_version integer NOT NULL REFERENCES ai_engine_settings(version),
 fields jsonb NOT NULL DEFAULT '{}',
 reply_count integer NOT NULL DEFAULT 0 CHECK(reply_count>=0)
);
CREATE TABLE ai_engine_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 event_key text NOT NULL REFERENCES ai_inbox(event_key) ON DELETE RESTRICT,
 settings_version integer NOT NULL REFERENCES ai_engine_settings(version),
 automation_epoch bigint NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('reply','handoff','suppress')),
 business_status text NOT NULL CHECK(business_status IN ('ai_dialog','qualified','unqualified','insufficient_data','manager_required')),
 reply text,
 reason text NOT NULL,
 fields jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,event_key)
);
CREATE INDEX ai_engine_decisions_conversation_idx ON ai_engine_decisions(conversation_id,created_at,id);
-- Pin at conversation creation, not at the later asynchronous model evaluation.
CREATE FUNCTION ai_engine_pin_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO ai_engine_state(conversation_id,settings_version)
 SELECT NEW.id,max(version) FROM ai_engine_settings ON CONFLICT(conversation_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_engine_pin_settings AFTER INSERT ON ai_conversations
FOR EACH ROW EXECUTE FUNCTION ai_engine_pin_settings();
INSERT INTO ai_engine_state(conversation_id,settings_version)
SELECT id,(SELECT max(version) FROM ai_engine_settings) FROM ai_conversations ON CONFLICT(conversation_id) DO NOTHING;
