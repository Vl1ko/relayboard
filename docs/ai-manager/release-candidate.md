# Проверенный Linux RC

15 ноября2026. **Автономная сборка/регрессия завершены; production не допущен.**24ч F06 ещё выполняется, реальная приёмка F08 открыта.

- Исходники: bc7c7b4d7ead9a548cc42156b18efb79d5616b6f, чистый git archive, без локальных .env/profiles/untracked файлов.
- Локальный образ: relayboard:rc-bc7c7b4, Linux/amd64, USER node (UID1000),434923410 байт. В registry не отправлялся.
- Digest: sha256:ee5ae5449e11ec24fca2a794a4e09a70d5b2edfb6a43f06d517c7ac7b4024fd4.
- Node24.22.3, Chromium156.0.8078.79 (Debian12), PostgreSQL16, Redis7. AI миграции1–23 с исходными checksum.
- Полные исходники:371 PASS/0 FAIL/0 SKIP; production build/typecheck PASS. Тот же набор compiled в финальном Linux образе:371 PASS/0 FAIL/0 SKIP.
- Финальные API/legacy публикации/вложения/scheduled pause-resume-stop, Chromium media, preflight/schema12/checksum, сохранение unknown/hold/opt-out: PASS. Внешние запросы отсутствуют; доставка fixture/synthetic.
- Owners/SIGKILL/compiled AI и совместимость RC→предыдущий RC→RC прошли на непосредственно предшествующем4e06b8b. Между ним и финальным runtime изменились только read-only preflight и выделение неизменённого чтения списка миграций; итоговый образ повторно прошёл полный compiled suite, API/Chrome/protected-state smoke. Возврат именно production-версии ещё не принят.
-60с Linux workload предшествующего4e06b8b:1200 событий,по30 заявок MAX/WhatsApp,20 открытых,0 дублей,p95 цикла758.6мс. Это не сутки и не latency настоящей модели/сети.

Машиночитаемый [manifest](../../outputs/res10-final-rc-2026-11-15/image-manifest.json), [полный Linux лог](../../outputs/res10-final-rc-2026-11-15/compiled-tests.log), [предыдущий комплект](../../outputs/res10-linux-rc-2026-11-15/image-manifest.json). Lockfile и архив исходников позволяют повторить сборку; базовые пакеты могут обновиться, поэтому новая сборка получает собственный digest и не объявляется побайтно идентичной. Испытанный локальный образ не был развёрнут на VPS.

## Повторение автономной проверки

Из checkout нужного коммита с Docker Desktop/Engine, отдельным project name и без реальных volumes:

```sh
docker build --build-arg RELEASE_REVISION=bc7c7b4d7ead9a548cc42156b18efb79d5616b6f -t relayboard:rc-bc7c7b4 .
docker tag relayboard:rc-bc7c7b4 relayboard:rc-20261115
docker compose --env-file /dev/null -p relayboard-rc-test-20261115 -f work/docker-compose.rc-test.yml up -d --wait
docker exec --user root relayboard-rc-test-20261115-api-1 mkdir -p /app/work
docker cp work/linux-compiled-tests.mjs relayboard-rc-test-20261115-api-1:/app/work/linux-compiled-tests.mjs
docker exec relayboard-rc-test-20261115-api-1 node work/linux-compiled-tests.mjs
docker compose --env-file /dev/null -p relayboard-rc-test-20261115 -f work/docker-compose.rc-test.yml down --volumes --remove-orphans
```

Это tmpfs fixture-контур с internal network без внешней сети; он не использует production .env. Удалять volumes допустимо **только** для этого собственного одноразового проекта. Рабочие Compose/volumes/образы не очищать. Снимок реального сервера, его конфигурация и APP_ENCRYPTION_KEY сохраняются до любой установки. Уведомления/модель/отправки для приёмки включаются отдельно и только в разрешённом объёме.

## Суточное доказательство

Длинный synthetic baseline начался15 ноября02:58:33 UTC (05:58:33 МСК). Ожидаемый конец —16 ноября05:58:33 МСК. Активные status.json/metrics.jsonl в outputs/res09-soak-24h-2026-11-15 не коммитятся до завершения. work/report-soak.mjs --wait уже запущен как одноразовый сборщик; после остановки теста он создаст final-report.json с PASS/FAIL, сверив длительность/профиль/каждый цикл и разрывы замеров. Fixture проверки сборщика приняли полный день и отвергли прерывание/разрыв. Итог не объявляет productionReady.

Промежуточно327 циклов/6540 событий,по60 заявок платформы,20 активных,queue/unknown/дубли0. Прогон начат на раннем инкременте; final-regressions.md перечисляет отдельные новые ветки и их доказательства. Mac должен оставаться работающим; временная защита только от idle sleep действует до конца процесса, закрытая крышка/выключение могут прервать тест. Прерывание не превращается в24ч PASS.

## Оставшийся допуск

[RELEASE_ACCEPTANCE.md](RELEASE_ACCEPTANCE.md) содержит все TC01–12 и один заключительный блок участия владельца: реальные5+5 сессий и тестовые собеседники/источники, коммерческий модельный доступ, бизнес-настройки/корпус, ресурсы/полные копии и разрешение конкретного выпуска. Суточная симуляция не заменяет эти проверки.
