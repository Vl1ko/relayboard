CREATE TABLE ai_workflow_status_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
 from_status text NOT NULL, to_status text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_workflow_status_history_conversation_idx ON ai_workflow_status_history(conversation_id,created_at,id);
CREATE TABLE ai_manager_target (
 id integer PRIMARY KEY CHECK(id=1), account_id uuid NOT NULL, external_id text NOT NULL
);
CREATE TABLE ai_handoff_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
 logical_key text NOT NULL, fingerprint text NOT NULL,
 reason text NOT NULL CHECK(reason IN ('qualified','human_requested','insufficient_data','reply_limit')),
 summary text NOT NULL, parameters jsonb NOT NULL, source jsonb,
 contact_snapshot jsonb NOT NULL, channel_snapshot jsonb NOT NULL,
 target_account_id uuid, target_external_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','confirmed','unknown','rejected')),
 attempt_token uuid, external_message_id text, outcome_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,logical_key), CHECK(state<>'confirmed' OR external_message_id IS NOT NULL)
);
CREATE INDEX ai_handoff_pending_idx ON ai_handoff_notifications(created_at,id) WHERE state='pending';
CREATE TABLE ai_followup_rules (
 scenario text PRIMARY KEY CHECK(scenario IN ('no_reply','not_booked','not_completed','requested_later')),
 enabled boolean NOT NULL, timezone text NOT NULL, weekdays integer[] NOT NULL,
 start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
 end_minute integer NOT NULL CHECK(end_minute BETWEEN 1 AND 1440 AND end_minute>start_minute),
 steps jsonb NOT NULL, max_sends integer NOT NULL CHECK(max_sends BETWEEN 1 AND 20),
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_followup_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
 logical_key text NOT NULL, scenario text NOT NULL REFERENCES ai_followup_rules(scenario),
 step integer NOT NULL, text text NOT NULL, due_at timestamptz NOT NULL,
 automation_epoch bigint NOT NULL, rule_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','enqueued','cancelled')),
 outbox_id uuid REFERENCES ai_outbox(id), cancellation_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,logical_key,step)
);
CREATE INDEX ai_followup_due_idx ON ai_followup_jobs(due_at,id) WHERE state='pending';
