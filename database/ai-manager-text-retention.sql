CREATE TABLE ai_storage_settings(
 id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 0,
 dialogue_days integer NOT NULL DEFAULT 30 CHECK(dialogue_days BETWEEN 1 AND 3650),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_storage_settings(id)VALUES(1);
ALTER TABLE ai_requests ADD COLUMN content_expired_at timestamptz;
ALTER TABLE ai_leads ADD COLUMN content_expired_at timestamptz;
CREATE INDEX ai_request_text_retention_idx ON ai_requests(closed_at,id) WHERE lifecycle='closed' AND content_expired_at IS NULL;
ALTER TABLE ai_workflow_status_history ADD COLUMN request_phase_id uuid REFERENCES ai_request_phases(id) ON DELETE RESTRICT;
UPDATE ai_workflow_status_history h SET request_phase_id=(SELECT p.id FROM ai_request_phases p WHERE p.conversation_id=h.conversation_id AND p.started_at<=h.created_at AND (p.closed_at IS NULL OR p.closed_at>=h.created_at) ORDER BY p.started_at DESC,p.id LIMIT 1);
CREATE TRIGGER pin_request_phase BEFORE INSERT ON ai_workflow_status_history FOR EACH ROW EXECUTE FUNCTION ai_request_pin_phase();
CREATE INDEX ai_status_history_phase_idx ON ai_workflow_status_history(request_phase_id);
