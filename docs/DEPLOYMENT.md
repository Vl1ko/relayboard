# Развёртывание Relayboard 1.0.0

## Требования к серверу

- Linux x86_64, Docker Engine 26+ и Docker Compose v2;
- минимум 2 vCPU, 4 ГБ RAM, 20 ГБ свободного диска;
- домен и TLS-сертификат для производственной установки;
- исходящий доступ к Telegram, MAX и WhatsApp Web.

## Установка

1. Передайте каталог проекта на сервер.
2. Создайте `.env` из `.env.example`; задайте все секреты разными случайными значениями.
3. Для HTTPS установите `SESSION_COOKIE_SECURE=true`.
4. Выполните `docker compose up -d --build`.
5. Проверьте `docker compose ps`, `curl http://127.0.0.1:3001/api/health` и логи `docker compose logs --tail=100`.
6. Настройте reverse proxy на `127.0.0.1:3001`; bridge-, Redis- и PostgreSQL-порты наружу не открывать.

Миграция запускается API автоматически и является повторяемой. При обновлении сначала создайте резервную копию.

## Обновление

```bash
docker compose down
docker compose up -d --build
```

Не применяйте `docker compose down -v`: параметр `-v` удалит базу, файлы и сессии.
