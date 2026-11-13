# WhatsApp: граница подготовленной отправки (RES04, дизайн)

Это исходный дизайн границы. Реализованная и проверенная часть описана в runtime.md и progress.md; настоящая WhatsApp-приёмка ещё не выполнена.

Проверены локальные зависимости whatsapp-web.js 1.34.7 и Puppeteer 24.38.0. `Client.sendMessage` асинхронно ищет чат/выполняет подготовку, поэтому его нельзя прятать в синхронный PreparedChannelSend.start. `CDPSession.send` в установленном Puppeteer вызывает Connection._rawSend → CallbackRegistry → NodeWebSocketTransport.send синхронно. Для AI нужен подготовленный CDP command, а не поздний page.evaluate wrapper.

## Текстовый transport

1. До claim: проверить live session, источник, private recipient/PN-LID aliases и self identity; получить отдельный CDP session.
2. В Runtime.evaluate подготовить существующий private Chat, self PN/LID, новый WAWebMsgKey, ephemeral fields и простое text message. Не вызывать addAndSendMsgToChat. Получить remote object и зарезервированный случайный message ID.
3. Сохранить durable intent: operation/outbox ID, account, target/verified aliases, reserved message ID. Подготовка сама ничего не отправляет.
4. Под контактными/диалоговыми блокировками core повторяет gate. Prepared.start синхронно пишет Runtime.callFunctionOn. Функция повторяет self/target/socket checks, выставляет окончательный текст из action, затем один раз вызывает WAWebSendMsgChatAction.addAndSendMsgToChat. Никаких повторов и поиска получателя после этого commit command.
5. Подтверждать только серверный ack>=1 и точный reserved message ID; локального message ID/ack0 недостаточно. Timeout/исключение после commit остаётся unknown.
6. Own event с зарезервированным ID — service echo, не native manager. message_ack или догруженная история с ack>=1 может подтвердить unknown по точным account/target/message-ID/body evidence. Совпадение текста/времени само по себе не является proof.
7. После known not_started reprepare допускается только с durable proof и свежим gate; unknown не возвращается в pending. Нужны отдельные rejected dispatch_state/retry_condition и intent history.
8. Для первого обращения clock после WA server ack является консервативной нижней границей следующего start. Неподтверждённый исход блокирует следующий первый контакт аккаунта.

## Проверки

- Unit: prepare=0 sends, синхронный CDP commit, подмена target/self, остановка/смена generation, stage expiry, missing/ack0/negative ack, timeout, повтор callback.
- Настоящий изолированный Chrome с пустым temporary profile и синтетическими WAWeb modules: execution context/object binding и реальный CDPSession. Не открывать личный профиль пользователя.
- PG: persist-before-start, pause во время подготовки, ошибка COMMIT после реального start, поздний ack, durable echo/duplicate и reconnect.
- Отдельно реальный разрешённый WhatsApp + тестовый собеседник: SDK/browser mocks не закрывают EV04.

## Остаток общей интеграции

Один WhatsApp owner до восстановления браузерных профилей; второй процесс ждёт и не удаляет SingletonLock живого профиля. Не запускать disabled/лишние аккаунты; до пяти браузерных сессий. Восстановление inbound использует собственный durable cursor и догрузку; не считать только события после рестарта полной историей. Private PN/LID aliases должны подтверждаться протоколом, не именем и не похожим номером.

Для source coordinator: автоматический первый source reply/qualification_notice должен использовать общие account allowlist, pause/stop и interval clocks, хотя у него kind не first_message. Условие initial_contact привязано к заявке; greeting считается по всей заявке, не повторяется при одной лишь смене criteria phase. Реактивные ответы и ручные сообщения требуют отдельного понятного поведения. Эти части ещё не реализованы source coordinator.


14 ноября: текстовый prepared transport, durable intents/late ack, safe not_started retry, self pinning, one-owner registry и bounded private catch-up реализованы. Изолированный настоящий Chrome/CDP и двухпроцессный SIGKILL smoke прошли. Остаток: live account acceptance, live source routing/coordinator, полная media/publishing prepared-граница и gap backfill за пределом500 последних сообщений. Дизайн не объявляет весь RES04 готовым.
