CREATE TABLE ai_search_source_settings(id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 0);
INSERT INTO ai_search_source_settings(id)VALUES(1);
CREATE TABLE ai_search_sources(account_id uuid NOT NULL,chat_id text NOT NULL,platform text NOT NULL CHECK(platform IN ('max','whatsapp','telegram')),PRIMARY KEY(account_id,chat_id));
