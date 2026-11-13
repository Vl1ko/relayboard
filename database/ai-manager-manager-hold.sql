ALTER TABLE ai_conversations ADD COLUMN manager_hold boolean NOT NULL DEFAULT false;
UPDATE ai_conversations v SET manager_hold=true
 WHERE v.business_status NOT IN ('closed','refused') AND EXISTS(
 SELECT 1 FROM ai_handoff_notifications n WHERE n.conversation_id=v.id AND n.reason='qualified'
 AND NOT EXISTS(SELECT 1 FROM ai_workflow_status_history h WHERE h.conversation_id=v.id AND h.to_status='closed' AND h.created_at>n.created_at));
