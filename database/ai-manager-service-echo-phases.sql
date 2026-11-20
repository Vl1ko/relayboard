-- A server echo may arrive after the next request starts (WhatsApp timestamps
-- have second precision). Its durable receipt, not arrival time, owns its phase.
CREATE OR REPLACE FUNCTION ai_request_pin_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_phase uuid; expired timestamptz;
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
 SELECT active_phase_id INTO NEW.request_phase_id FROM ai_conversations WHERE id=NEW.conversation_id;
 RETURN NEW;
END$$;
WITH receipts AS(
 SELECT DISTINCT ON(a.conversation_id,a.external_message_id) a.conversation_id,a.external_message_id,a.request_phase_id,r.content_expired_at
 FROM ai_outbox a LEFT JOIN ai_request_phases p ON p.id=a.request_phase_id LEFT JOIN ai_requests r ON r.id=p.request_id
 WHERE a.state='confirmed' ORDER BY a.conversation_id,a.external_message_id,a.created_at,a.id
)
UPDATE ai_inbox i SET request_phase_id=r.request_phase_id,text=CASE WHEN r.content_expired_at IS NOT NULL THEN '[Срок хранения текста истёк]' ELSE i.text END
 FROM receipts r WHERE i.conversation_id=r.conversation_id AND i.external_message_id=r.external_message_id AND i.origin='service';
