# Резервное копирование и восстановление

Копировать необходимо PostgreSQL и volumes `uploads`, `telegram_session`, `whatsapp_session`. Redis содержит восстанавливаемую очередь, но его копия полезна при аварийном восстановлении активных заданий.

## PostgreSQL

Создание дампа:

```bash
docker compose exec -T postgres pg_dump -U relayboard -d relayboard -Fc -f /tmp/relayboard.dump
docker compose cp postgres:/tmp/relayboard.dump ./relayboard.dump
```

Восстановление в пустую базу:

```bash
docker compose cp ./relayboard.dump postgres:/tmp/relayboard.dump
docker compose exec -T postgres pg_restore -U relayboard -d relayboard --clean --if-exists /tmp/relayboard.dump
```

## Файлы и сессии

Остановите `api`, `worker`, `telegram`, `whatsapp`, затем архивируйте соответствующие Docker volumes штатным средством резервного копирования сервера. Храните копию шифрованно: сессии предоставляют доступ к личным аккаунтам.

Проверяйте восстановление минимум раз в месяц на отдельном сервере. После восстановления убедитесь, что вложения скачиваются, подключения отображаются, а остановленные задания не запустились повторно.
