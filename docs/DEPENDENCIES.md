# Зависимости и лицензии

Версии зафиксированы в `package-lock.json`. Прямые runtime-зависимости сборки 1.0.0:

| Пакет | Версия | Лицензия | Назначение |
|---|---:|---|---|
| @ounezz/umax | 1.0.8 | ISC | Неофициальная личная сессия MAX |
| bullmq | 6.3.4 | MIT | Очередь и расписания |
| cors | 2.8.6 | MIT | HTTP CORS |
| dotenv | 17.4.2 | BSD-2-Clause | Переменные окружения |
| express | 5.2.1 | MIT | HTTP API |
| ioredis | 6.0.0 | MIT | Подключение Redis |
| multer | 2.3.0 | MIT | Multipart-загрузка файлов |
| pg | 8.23.0 | MIT | PostgreSQL |
| qrcode | 1.5.4 | MIT | QR-коды авторизации |
| react / react-dom | 19.2.8 | MIT | Интерфейс |
| teleproto | 1.229.0 | MIT | Личная MTProto-сессия Telegram |
| vite | 6.4.3 | MIT | Сборка интерфейса |
| whatsapp-web.js | 1.34.7 | Apache-2.0 | Личная сессия WhatsApp Web |
| zod | 4.5.4 | MIT | Проверка входных данных |

`@vitejs/plugin-react` используется только при сборке и имеет лицензию MIT. Полное дерево версий находится в lock-файле; перед обновлением зависимостей обязательны QR- и файловые регрессионные тесты.
