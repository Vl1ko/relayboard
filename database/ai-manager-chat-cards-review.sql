-- Per-chat search policy follows the messenger/chat, including reader changes.
CREATE TABLE ai_chat_criteria (
 platform text NOT NULL CHECK(platform IN ('max','whatsapp')),
 chat_id text NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 mode text NOT NULL CHECK(mode IN ('inherit','extend','replace')),
 settings jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(platform,chat_id)
);
CREATE TABLE ai_qualification_reviews (
 decision_id uuid PRIMARY KEY REFERENCES ai_engine_decisions(id),
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
 request_phase_id uuid NOT NULL REFERENCES ai_request_phases(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','rejected','taken')),
 manager_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz
);
ALTER TABLE ai_handoff_notifications DROP CONSTRAINT ai_handoff_notifications_reason_check;
ALTER TABLE ai_handoff_notifications ADD CHECK(reason IN ('qualified','human_requested','insufficient_data','reply_limit','qualification_review'));
CREATE TABLE ai_contact_notes (
 id uuid PRIMARY KEY,
 contact_id uuid NOT NULL REFERENCES ai_contacts(id),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
 revision integer NOT NULL DEFAULT 0,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_contact_notes_contact_idx ON ai_contact_notes(contact_id,created_at);
CREATE TABLE ai_contact_files (
 id uuid PRIMARY KEY,
 contact_id uuid NOT NULL REFERENCES ai_contacts(id),
 original_name text NOT NULL,
 storage_path text NOT NULL UNIQUE,
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 20971520),
 sha256 text NOT NULL,
 deleted_at timestamptz,
 purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_contact_files_contact_idx ON ai_contact_files(contact_id,created_at);
CREATE INDEX ai_import_outreach_batch_idx ON ai_import_outreach_jobs(batch_id,id);
-- Pending negative outcomes from the previous version require human review too.
INSERT INTO ai_qualification_reviews(decision_id,conversation_id,request_phase_id)
 SELECT d.id,v.id,v.active_phase_id FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id
 JOIN ai_engine_decisions d ON d.request_phase_id=p.id AND d.automation_epoch+1=v.automation_epoch
 JOIN ai_handoff_notifications n ON n.logical_key='ai-handoff:'||d.id::text AND n.conversation_id=v.id
 WHERE v.business_status='unqualified' AND v.automation_mode='paused' AND p.closed_at IS NULL AND d.business_status='unqualified' AND d.disposition='handoff'
 ON CONFLICT DO NOTHING;
UPDATE ai_outbox a SET state='cancelled',cancellation_requested=true,outcome_code='manager_review_required',updated_at=now()
 FROM ai_qualification_reviews r WHERE a.logical_key='qualification-notice:'||r.decision_id::text AND a.state='pending';
UPDATE ai_conversations v SET business_status='manager_required',manager_hold=true
 FROM ai_qualification_reviews r WHERE r.conversation_id=v.id AND v.active_phase_id=r.request_phase_id;
UPDATE ai_handoff_notifications n SET reason='qualification_review',state='pending',outcome_code=NULL
 FROM ai_qualification_reviews r WHERE n.logical_key='ai-handoff:'||r.decision_id::text AND n.state='rejected' AND n.outcome_code='qualification_not_passed';
