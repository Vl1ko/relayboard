CREATE TABLE ai_source_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lead_id uuid NOT NULL UNIQUE REFERENCES ai_leads(id),
 target_account_id uuid,
 target_external_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','confirmed','unknown','rejected')),
 external_message_id text,
 outcome_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state <> 'confirmed' OR external_message_id IS NOT NULL)
);
CREATE INDEX ai_source_notifications_pending_idx ON ai_source_notifications(created_at,id) WHERE state='pending';
