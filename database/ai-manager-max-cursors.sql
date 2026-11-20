CREATE TABLE ai_max_private_cursors (
 conversation_id uuid PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE RESTRICT,
 phase_id uuid NOT NULL REFERENCES ai_request_phases(id) ON DELETE RESTRICT,
 through_time bigint NOT NULL CHECK(through_time>=0),
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- An explicit criteria change may start a new qualification phase of the same request.
-- The previous phase and its criteria/fields remain historical.
ALTER TABLE ai_request_phases DROP CONSTRAINT IF EXISTS ai_request_phases_request_id_conversation_id_key;
