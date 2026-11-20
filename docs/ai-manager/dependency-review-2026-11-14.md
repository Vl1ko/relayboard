# Проверка зависимостей Relayboard, 14 ноября 2026

Manifest: package.json / package-lock.json. Исходный npm audit:17 замечаний,11 high /6 moderate; это число затронутых узлов дерева, а не17 независимых CVE. Исходная lockfile:32 прямых зависимости, дополнительные/платформенные пакеты учитываются в SBOM. Актуальные полные количества фиксируются npm audit и CycloneDX артефактами.

## Классификация исправлений

По Security Fixer Policy (dependency-scanning): ip-address10.7.0→10.7.6 — auto-fix, узкое обновление вложенной библиотеки. WhatsApp1.34.7→1.34.8 и Puppeteer24→25.17.0, scoped glob14 для archiver-utils5 — assisted-fix: затрагивают браузер и совместимость вложенных API. Работа входит в ранее утверждённый пользователем план полного завершения проекта и санации зависимостей. Сначала проверяется отдельная временная копия; production и настоящие браузерные профили не меняются. Окончательный коммерческий релиз требует live WhatsApp-приёмки, включённой в общий план.

Обновление Puppeteer необходимо для удаления старого extract-zip без опубликованного патча; выпуск25 переводит библиотеку на ESM и меняет некоторые API путей/аргументов запуска. Node24 уже используется локально и в Dockerfile. Проверяется явный Chromium executablePath, CDP prepared boundary, CommonJS импорт из WhatsApp SDK и необязательная цепочка архивации. Сохраняется LocalAuth; RemoteAuth не включается и реальные профили не читаются. Puppeteer-core объявляется прямой dev-зависимостью для используемого smoke-инструмента.

## Уязвимости до исправления

| CVE / первичный источник | Пакет / диапазон | Severity / CVSS | EPSS | CISA KEV | Приоритет |
|---|---|---|---|---|---|
| [CVE-2026-102990](https://github.com/advisories/GHSA-c475-qrg2-pj4r) | basic-ftp <=6.2.3 | high / None | 0.003700000 | нет в выгрузке | P2 |
| [CVE-2026-126345](https://github.com/advisories/GHSA-5pm8-86m8-9m6r) | basic-ftp <=6.2.3 | medium / 5.3 | 0.004950000 | нет в выгрузке | P3 |
| [CVE-2026-126346](https://github.com/advisories/GHSA-r4jh-29pc-gfqr) | basic-ftp <=6.2.3 | medium / 5.9 | 0.016720000 | нет в выгрузке | P3 |
| [CVE-2026-56876](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) | extract-zip * | high / 8.1 | 0.005260000 | нет в выгрузке | P2 |
| [CVE-2026-19693](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) | extract-zip * | high / 8.1 | 0.004530000 | нет в выгрузке | P2 |
| [CVE-2026-118773](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | glob 9.0.0 - 14.0.1 | medium / None | 0.003500000 | нет в выгрузке | P3 |
| [CVE-2026-101912](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) | ip-address <=10.7.3 | medium / None | 0.003700000 | нет в выгрузке | P3 |
| [CVE-2026-101911](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) | ip-address <=10.7.3 | medium / None | 0.003830000 | нет в выгрузке | P3 |
| [CVE-2026-111997](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | ip-address <=10.7.3 | medium / None | 0.003150000 | нет в выгрузке | P3 |
| [CVE-2026-118764](https://github.com/advisories/GHSA-g3hv-75wg-m249) | minimatch 7.0.0 - 11.0.0 | medium / None | 0.003010000 | нет в выгрузке | P3 |
| [CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | zod <4.6.6 | high / 7.5 | нет данных | нет в выгрузке | P2 |

Первичные данные: GitHub advisory API, [FIRST EPSS](https://api.first.org/data/v1/epss), [CISA KEV](https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json), публикация каталога2026-11-13. Отсутствующий EPSS не считается нулём. Прямых совпадений CVE в полученном каталоге KEV нет; это не доказательство отсутствия эксплуатации. Связанные транзитивные узлы отдельно не удваивают CVE.

## Лицензии

В исходной lockfile node-webpmux3.2.1 указан как LGPL-3.0-or-later; это отдельная проверка обязательств при распространении, не решение о юридической допустимости. jszip имеет двойную MIT OR GPL-3.0-or-later. Для buffers, busboy, streamsearch и старого вложенного async лицензия отсутствует в lockfile: нужен просмотр поставляемого LICENSE, отсутствие метаданных не означает отсутствие лицензии. Артефакт license-inventory.json фиксирует metadata новой цепочки. Юридические выводы и принятие риска этой проверкой не делаются.

## Supply chain и границы

Зафиксированные manifest/lockfile и npm integrity hashes; пакеты из официального npm. Есть install hooks esbuild/fsevents/msgpackr-extract/Puppeteer; пробная установка использует --ignore-scripts и не скачивает Chrome. Некоторые унаследованные зависимости ExcelJS/WhatsApp помечены deprecated; нулевой npm audit их не сертифицирует. Признаков подмены имени при локальном просмотре не найдено; provenance/SLSA build attestations не подтверждены. CycloneDX inventory описывает зависимости, а не доказанную безопасность.

## Проверки и откат

Перед переносом нужны typecheck/build, весь синтетический набор, compiled AI/MAX/WhatsApp owners, настоящий isolated Chrome prepared-send и archive round-trip. Затем проверяется неизменность исходников относительно baseline7b57aaf; переносятся только manifest/lock и доказательства. Production не развёртывается. Для локального отката вернуть package.json и package-lock.json из7b57aaf и выполнить npm ci с PUPPETEER_SKIP_DOWNLOAD=true; рабочие данные и схемы БД не меняются. Live WhatsApp остаётся обязательной проверкой до релиза.

## Результат пробной проверки

В изолированной копии333 PASS /0 FAIL /0 SKIP; typecheck/build и четыре compiled smoke проверки PASS, включая настоящий Chrome с Puppeteer25.17.0. CommonJS SDK и LocalAuth/RemoteAuth конструкторы, scoped glob, zip/extract round-trip PASS. npm audit:0 известных уязвимостей. CycloneDX1.5:479 компонентов. Исходники src/web/database/scripts побайтно сверены с основной копией перед переносом: различий нет. Изменены только manifest/lockfile; runtime проектных модулей тот же.

Проверка поставляемых LICENSE: busboy, streamsearch и вложенный async содержат MIT-текст, несмотря на пропуск в lockfile. buffers0.1.1 (ExcelJS→unzipper→binary) не содержит LICENSE или явного лицензионного раздела; остаётся отдельный вопрос происхождения/условий распространения. LGPL node-webpmux требует учёта при подготовке поставки. Этот отчёт не даёт юридического заключения.
