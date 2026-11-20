ALTER TABLE ai_followup_rules ADD COLUMN label text NOT NULL DEFAULT '' CHECK(length(label)<=120);
ALTER TABLE ai_followup_rules ADD COLUMN channel text NOT NULL DEFAULT 'current' CHECK(channel IN ('current','max','whatsapp'));
ALTER TABLE ai_followup_rules ADD COLUMN acknowledgement_message text NOT NULL DEFAULT 'Хорошо, свяжемся позже.' CHECK(length(acknowledgement_message) BETWEEN 1 AND 2000);
ALTER TABLE ai_followup_rules ADD COLUMN automatic_enabled_at timestamptz;
UPDATE ai_followup_rules SET label=CASE scenario WHEN 'no_reply' THEN 'Не ответил' WHEN 'not_booked' THEN 'Этап 1' WHEN 'not_completed' THEN 'Этап 2' ELSE 'Попросил позже' END,automatic_enabled_at=CASE WHEN enabled THEN now() END;
CREATE FUNCTION ai_latest_request_customer_sequence(conversation uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 WITH current AS(SELECT v.id,p.request_id FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.id=conversation)
 SELECT coalesce(max(i.ingest_sequence),0)::bigint FROM current v LEFT JOIN ai_inbox i ON i.origin='customer' AND (
  v.request_id IS NULL AND i.conversation_id=v.id OR v.request_id IS NOT NULL AND EXISTS(SELECT 1 FROM ai_request_phases p WHERE p.id=i.request_phase_id AND p.request_id=v.request_id))
$$;
ALTER TABLE ai_outbox ADD COLUMN customer_sequence bigint NOT NULL DEFAULT 0 CHECK(customer_sequence>=0);
CREATE FUNCTION ai_pin_outbox_customer_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.customer_sequence:=ai_latest_request_customer_sequence(NEW.conversation_id);RETURN NEW;END$$;
CREATE TRIGGER ai_outbox_customer_sequence BEFORE INSERT ON ai_outbox FOR EACH ROW EXECUTE FUNCTION ai_pin_outbox_customer_sequence();
UPDATE ai_outbox a SET customer_sequence=i.ingest_sequence FROM ai_engine_decisions d JOIN ai_inbox i ON i.event_key=d.event_key WHERE a.logical_key='ai-reply:'||d.id::text AND a.conversation_id=d.conversation_id;
CREATE TABLE ai_request_business_state(
 request_id uuid PRIMARY KEY REFERENCES ai_requests(id) ON DELETE RESTRICT,
 revision integer NOT NULL DEFAULT 0,
 booking_state text NOT NULL DEFAULT 'none' CHECK(booking_state IN ('none','offered','booked')),
 order_state text NOT NULL DEFAULT 'none' CHECK(order_state IN ('none','started','completed')),
 requested_contact_at timestamptz,followups_stopped boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_business_events(
 id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 request_phase_id uuid NOT NULL REFERENCES ai_request_phases(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('booking_offered','booking_confirmed','order_started','order_completed','requested_later','stop_followups')),
 actor text NOT NULL CHECK(actor IN ('manager','customer')),
 fingerprint text NOT NULL,note text NOT NULL DEFAULT '',not_before timestamptz,
 source_event_key text REFERENCES ai_inbox(event_key) ON DELETE RESTRICT,
 automation_epoch bigint NOT NULL,customer_sequence bigint NOT NULL,business_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(source_event_key,kind),
 CHECK(actor='manager' OR kind='requested_later' AND source_event_key IS NOT NULL)
);
ALTER TABLE ai_followup_jobs ADD COLUMN trigger_action_id uuid REFERENCES ai_outbox(id) ON DELETE RESTRICT;
ALTER TABLE ai_followup_jobs ADD COLUMN business_event_id uuid REFERENCES ai_business_events(id) ON DELETE RESTRICT;
ALTER TABLE ai_followup_jobs ADD COLUMN business_revision integer;
ALTER TABLE ai_followup_jobs ADD COLUMN trigger_customer_sequence bigint;
CREATE INDEX ai_business_events_request_idx ON ai_business_events(request_id,created_at,id);
CREATE TABLE ai_automatic_followup_triggers(
 logical_key text PRIMARY KEY,request_id uuid NOT NULL REFERENCES ai_requests(id) ON DELETE RESTRICT,
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 request_phase_id uuid NOT NULL REFERENCES ai_request_phases(id) ON DELETE RESTRICT,
 scenario text NOT NULL REFERENCES ai_followup_rules(scenario),
 trigger_action_id uuid REFERENCES ai_outbox(id) ON DELETE RESTRICT,
 business_event_id uuid REFERENCES ai_business_events(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(trigger_action_id IS NOT NULL OR business_event_id IS NOT NULL)
);
