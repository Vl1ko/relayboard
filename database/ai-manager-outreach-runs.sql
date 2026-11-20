CREATE TABLE ai_outreach_runs (
 id uuid PRIMARY KEY,
 fingerprint text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','stopped','completed','review')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_outreach_items (
 run_id uuid NOT NULL REFERENCES ai_outreach_runs(id),
 request_id uuid NOT NULL UNIQUE REFERENCES ai_requests(id),
 contact_id uuid NOT NULL REFERENCES ai_contacts(id),
 conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
 action_id uuid REFERENCES ai_outbox(id),
 skipped_reason text,
 PRIMARY KEY(run_id,request_id)
);
CREATE INDEX ai_outreach_items_action_idx ON ai_outreach_items(action_id);
CREATE TABLE ai_outreach_clocks (
 account_id uuid PRIMARY KEY,
 last_started_at timestamptz
);
