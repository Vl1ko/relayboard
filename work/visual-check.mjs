import puppeteer from "puppeteer";
import QRCode from "qrcode";

const integrations = [
  { id: "11111111-1111-4111-8111-111111111111", platform: "telegram", name: "Новости компании", enabled: true, destination_count: 2 },
  { id: "22222222-2222-4222-8222-222222222222", platform: "max", name: "Рабочий MAX", enabled: true, destination_count: 1 },
  { id: "33333333-3333-4333-8333-333333333333", platform: "whatsapp", name: "Рабочий номер", enabled: true, destination_count: 1 },
  { id: "44444444-4444-4444-8444-444444444444", platform: "vk", name: "Личный VK", enabled: true, destination_count: 1 },
];
const destinations = [
  { id: "a1111111-1111-4111-8111-111111111111", integration_id: integrations[0].id, external_id: "-100123456", title: "Общая команда", kind: "group", platform: "telegram", integration_name: "Новости компании" },
  { id: "a2222222-2222-4222-8222-222222222222", integration_id: integrations[1].id, external_id: "93827364", title: "Региональные менеджеры", kind: "group", platform: "max", integration_name: "MAX бот" },
  { id: "a3333333-3333-4333-8333-333333333333", integration_id: integrations[2].id, external_id: "1203630@g.us", title: "Отдел продаж", kind: "group", platform: "whatsapp", integration_name: "Рабочий номер" },
  { id: "a4444444-4444-4444-8444-444444444444", integration_id: integrations[3].id, external_id: "2000000001", title: "Партнёры", kind: "group", platform: "vk", integration_name: "Сообщество" },
];
const dashboard = { counts: { integrations: 4, destinations: 5, sent: 128, failed: 2 }, recent: [] };
const maxGroups = [
  { id: "93827364", title: "Региональные менеджеры", participantsCount: 18 },
  { id: "88442211", title: "Маркетинг", participantsCount: 9 },
];
const telegramQr = await QRCode.toDataURL("tg://login?token=relayboard-visual-check", { width: 360, margin: 2 });
let telegramStatusMode = "qr";

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on("request", (request) => {
  const url = request.url();
  if (url.endsWith("/api/telegram/status")) {
    const status = telegramStatusMode === "qr"
      ? { status: "qr", qr: telegramQr, profile: null, error: null, configured: true }
      : { status: "disconnected", qr: null, profile: null, error: null, configured: false };
    return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
  }
  if (url.endsWith("/api/telegram/dialogs")) return request.respond({ status: 200, contentType: "application/json", body: "[]" });
  if (url.includes("/api/max/groups/")) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(maxGroups) });
  const match = url.match(/\/api\/(integrations|destinations|dashboard)$/);
  if (!match) return request.continue();
  const body = match[1] === "integrations" ? integrations : match[1] === "destinations" ? destinations : dashboard;
  request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle0" });
await page.evaluate(() => sessionStorage.setItem("relayboard-key", "visual-check-key"));
await page.reload({ waitUntil: "networkidle0" });
await page.click("nav button:nth-child(2)");
await page.waitForSelector(".session-panel");
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Обновить статус"));
  if (button instanceof HTMLButtonElement) button.click();
});
await page.waitForSelector(".telegram-qr-card");
await page.screenshot({ path: "work/relayboard-connections-wide.png", fullPage: true });
await page.click(".delete-connection");
await page.waitForSelector(".delete-dialog");
const deleteDialogText = await page.$eval(".delete-dialog", (dialog) => dialog.textContent || "");
if (!deleteDialogText.includes("Новости компании") || !deleteDialogText.includes("2 связанных бесед")) {
  throw new Error(`Диалог удаления не содержит деталей подключения: ${deleteDialogText}`);
}
await page.screenshot({ path: "work/relayboard-delete-dialog.png", fullPage: true });
await page.click(".dialog-actions .ghost");
await page.waitForSelector(".delete-dialog", { hidden: true });

const messengerSelect = await page.$(".two-columns form:first-child select");
await messengerSelect.select("max");
await page.waitForSelector('a[href="https://web.max.ru/"]');
await page.click(".max-groups-panel .session-actions button");
await page.waitForFunction(() => document.querySelector(".max-groups")?.textContent?.includes("Маркетинг"));
const maxGroupsText = await page.$eval(".max-groups", (list) => list.textContent || "");
if (!maxGroupsText.includes("Добавлена") || !maxGroupsText.includes("Добавить")) throw new Error("Некорректные действия в списке MAX-групп");
await messengerSelect.select("vk");
await page.waitForSelector('a[href="https://vk.com/apps?act=manage"]');
await page.type('input[placeholder="Например, 12345678"]', "12345678");
const vkOAuthHref = await page.$eval('a[href^="https://oauth.vk.com/authorize"]', (link) => link.href);
if (!vkOAuthHref.includes("client_id=12345678") || !vkOAuthHref.includes("scope=messages,offline")) {
  throw new Error(`Некорректная ссылка VK OAuth: ${vkOAuthHref}`);
}

telegramStatusMode = "missing";
await messengerSelect.select("telegram");
await page.waitForSelector('input[placeholder="Строка из API development tools"]');
const telegramLoginDisabled = await page.$eval(".telegram-login", (button) => button.disabled);
if (!telegramLoginDisabled) throw new Error("Кнопка Telegram должна ждать ручные API-реквизиты");
await page.type('input[placeholder="Например, 12345678"]', "12345678");
await page.type('input[placeholder="Строка из API development tools"]', "0123456789abcdef0123456789abcdef");
const telegramLoginEnabled = await page.$eval(".telegram-login", (button) => !button.disabled);
if (!telegramLoginEnabled) throw new Error("Кнопка Telegram не активировалась после ручного ввода");

telegramStatusMode = "qr";
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.reload({ waitUntil: "networkidle0" });
await page.click("nav button:nth-child(2)");
await page.waitForSelector(".session-panel");
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Обновить статус"));
  if (button instanceof HTMLButtonElement) button.click();
});
await page.waitForSelector(".telegram-qr-card");
await page.screenshot({ path: "work/relayboard-connections-mobile.png", fullPage: true });
await browser.close();
