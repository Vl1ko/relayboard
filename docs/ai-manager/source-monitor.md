# Источники и первое обращение

Миграция17, SOURCE_MONITOR_ENABLED=false по умолчанию. Перед запуском нужны db:migrate:ai, актуальная сборка, MAX/WhatsApp owners и AI worker с одинаковым флагом/тестовой областью. Это руководство к реализованному инкременту, а не подтверждение production readiness.

В UI выбираются до5 MAX и5 WhatsApp групп, один reader на platform/chat; отправители и интервал берутся из настроек первого обращения. Порядок sender в пределах source-платформы проверяется владельцем. Несовпадение доступного канала остаётся pending review, не превращается в guessed/fallback send. Импортированные запросы сохраняют прежний приоритет каналов. Изменение выбранных источников не меняет адресата уже начатой отправки.

Настройки поиска: описание спроса, optional include/exclude literal phrases, confidence threshold50–99%, auto-contact. Start проверяет источник, GigaChat model, а для auto-contact — квалификацию и sender allowlist. API и последний first-contact gate требуют свежих heartbeat coordinator/соответствующего reader; mode active сам по себе не доказывает, что процесс работает. Pause сохраняет очередь, stop завершает её generation; старый первый контакт не возрождается при новом start. SOURCE_MONITOR_ENABLED=false на старте AI worker ставит активный монитор на pause. Продолжающиеся клиентские диалоги отделены от приостановки поиска новых клиентов.

MAX читает raw48/49 CHAT, WhatsApp читает проверенный group Chat и actual author. Курсор продвигается только после durable capture. Boundaries: MAX до50×100 сообщений за catch-up, WhatsApp до500 за history query; при неполном покрытии сохраняется ошибка и прежний cursor. Это явная остановка, не пропуск событий. Расширенный gap recovery сверх этих границ и реальный corpus остаются открытой эксплуатационной проверкой.

Source ledger имеет global platform/chat/message dedup и fingerprint автора/времени/текста. Own messages, чужой test scope и незарегистрированные чаты не попадают в модель. Подходящие pending raw texts ограничены5000; заполнение останавливает capture без продвижения cursor. Известный opt-out повторно проверяется перед моделью. Excluded/noise messages оставляют минимальную metadata/hash запись; candidate text переносится в lead, raw copy очищается. Ротация metadata и TTL завершённых диалогов реализуются в RES09, а не объявляются готовыми здесь.

Scorer использует общий GigaChat JSON client и credential-wide single stream. Никаких tools или выбора IDs в модели. Exact demand quote/parameter quotes, поле и numeric type проверяет сервер. Ambiguous и низкий score требуют review; ошибки/несогласованное evidence остаются pending с backoff. Criteria revision во время модели отбрасывает ответ. Результат последующей policy version не переписывает уже принятое решение фазы.

Route owner повторно читает исходное сообщение. MAX проверяет DIALOG/participants; WhatsApp проверяет PN/LID и group author. Другой WhatsApp sender получает маршрут только по подтверждённому PN; скрытый LID без PN ограничен исходным reader account. Namespace LID включает account; canonical PN глобален. Sender, private recipient и source reader/author различаются в source ledger. Имена не являются identity key; конфликт связей не сливает историю автоматически.

Activation держит lead lock и в одной транзакции выполняет bindSourceRequestInTransaction, approval, source→lead связь и first customer inbox. Уже закрытый/использованный source не создаёт новую заявку. Новая публичная публикация при открытой заявке не включает второй авто-канал. Verified params seed в qualification state содержат точный group-source evidence ID и quote; неизвестный параметр/тип отклоняется. Существующий личный customer event не перезаписывается запоздавшей группой.

Первый source reply или qualification completion использует monitor pause/stop/epoch/heartbeat, allowlist, account interval и uncertainty clocks даже при kind!=first_message. Текст — согласованный generated qualification response с configured greeting/completion; импортный literal first-message template сохраняет своё назначение. Unknown другого автоматического действия контакта блокирует новый auto reply; manual action остаётся явным действием оператора. Unknown/confirmed не replay.

UI: Sources + MonitorControls, человеческие поля/цитаты и sender выбора для monitored lead. Ручной legacy approve с произвольным contact/request запрещён для monitored source: подтверждение проходит через verified source route. HTTP approved replay возвращает существующую заявку до нового network lookup. Source first action не отправляется самим браузером: он создаёт durable input для worker.

Проверки: source-monitor.test.ts, lead-router.test.ts, gigachat-source-scorer.test.ts, а также прежний transport/lifecycle regression. outputs/res05-sources-2026-11-14 содержит313 PASS и browser proof на fake данных. Реальные MAX/WhatsApp/GigaChat,10 аккаунтов, media/publishing prepared boundary, коммерческий scope, хранение/backup и полный выпуск ещё требуют остальных RES.


## Критерии отдельных чатов,17 ноября2026

Поддерживаются наследование общих, обязательное дополнение и полная замена критериев для каждой пары мессенджер/чат. Эффективная политика участвует в capture, classify, activation и проверке до первой отправки. Подробности и проверки — [chat-cards-review.md](chat-cards-review.md).
