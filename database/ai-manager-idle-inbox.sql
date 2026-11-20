-- Closed-period inbox is retained only as identity/outcome, without private text.
-- A server echo may arrive after the next request starts (WhatsApp timestamps
-- have second precision). Its durable receipt, not arrival time, owns its phase.
CREATE OR REPLACE FUNCTION ai_request_pin_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_phase uuid; expired timestamptz; active_started timestamptz; active_closed timestamptz; active_status text;
BEGIN
 IF TG_TABLE_NAME='ai_inbox' THEN
  IF NEW.origin='service' THEN
   SELECT a.request_phase_id,r.content_expired_at INTO receipt_phase,expired
    FROM ai_outbox a LEFT JOIN ai_request_phases p ON p.id=a.request_phase_id LEFT JOIN ai_requests r ON r.id=p.request_id
    WHERE a.conversation_id=NEW.conversation_id AND a.external_message_id=NEW.external_message_id AND a.state='confirmed'
    ORDER BY a.created_at,a.id LIMIT 1;
   IF FOUND THEN
    NEW.request_phase_id:=receipt_phase;
    IF expired IS NOT NULL THEN NEW.text:='[Срок хранения текста истёк]';END IF;
    RETURN NEW;
   END IF;
  END IF;
 END IF;
 SELECT v.active_phase_id,p.started_at,p.closed_at,v.business_status INTO NEW.request_phase_id,active_started,active_closed,active_status
  FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.id=NEW.conversation_id;
 IF TG_TABLE_NAME='ai_inbox' THEN
  -- Private messages outside the active request are consumed for global opt-out
  -- by the application, but must never seed its model or restore expired text.
  -- Source envelopes are separately verified and may predate activation.
  IF NEW.origin<>'service' AND NEW.external_message_id NOT LIKE 'group-source:%' AND
    (active_closed IS NOT NULL OR active_status IN ('closed','refused') OR NEW.occurred_at<active_started) THEN
   NEW.request_phase_id:=NULL;
   NEW.text:='[Сообщение вне активной заявки]';
   RETURN NEW;
  END IF;
 END IF;
 RETURN NEW;
END$$;
