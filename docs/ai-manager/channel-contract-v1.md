# E01-C: синтетический контракт v1

READY_FOR_REVIEW, не live PoC. Реализация: src/core/channel-contracts.ts; проверки: channel-contracts.test.ts. Старые bridges/MessengerAdapter не менялись, новый модуль не подключён к сети/БД.

Событие: version=1; platform=max|whatsapp; accountId/conversationId/messageId; occurredAt с ISO-зоной; direction=inbound|outbound; origin=customer|service|human|unresolved; text. ID непрозрачны, без trim/нормализации, blank запрещён. Ограничение ID512 — инженерное предложение, проверить с платформами до интеграции. Дополнительные поля допускаются; неизвестная major version отклоняется.

Origin — доверенное утверждение будущего нормализатора, не поле клиентского текста/публичного API. fromMe или отсутствие receipt не доказывают human. Подтверждённый remote_sender inbound → customer; service_receipt outbound → service; native_human outbound → human; иначе unresolved. Disposition: process_customer/suppress_service_echo/takeover/hold_for_review. Это не разрешение send: opt-out/mode/epoch/auth проверяются отдельно.

Транспортный ключ SHA256 от JSON tuple version/platform/account/conversation/message, без timestamp/text. Он не определяет контакт/заявку и не обеспечивает durable dedup без БД.

Исход confirmed требует operationId/externalMessageId и never retry; rejected — доказанный not_started и never/refresh_auth/after_delay; unknown — только reconcile_or_manual_review. Коды расширяемы. permitsAutomaticRetry разрешает повторное рассмотрение rejected, не обход свежих guard-проверок. Legacy accepted-timestamp нельзя считать подтверждением без доказательства коннектора.

MAX: bulk subscriptions отключены; API/worker могут конкурировать за соединение токена. Нужен проверенный владелец WebSocket/подписок. Реальная корреляция own/native human и replay в обоих каналах пока UNVERIFIED.
