import "dotenv/config";

const base = "http://localhost:3001";
const expectedPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
const username = process.env.ADMIN_USERNAME || "admin";

async function request(path, init = {}, cookie = "") {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const unauthorized = await request("/api/integrations");
if (unauthorized.response.status !== 401) throw new Error(`unauthorized=${unauthorized.response.status}`);

const badLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password: "definitely-wrong" }) });
if (badLogin.response.status !== 401) throw new Error(`badLogin=${badLogin.response.status}`);

const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password: expectedPassword }) });
if (!login.response.ok) throw new Error(`login=${login.response.status} ${login.body.error || ""}`);
const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
if (!cookie) throw new Error("login cookie missing");
if (!/HttpOnly/i.test(login.response.headers.get("set-cookie") || "")) throw new Error("login cookie is not HttpOnly");

const session = await request("/api/auth/session", {}, cookie);
if (!session.response.ok) throw new Error(`session=${session.response.status}`);

const removedPlatform = await request("/api/integrations", {
  method: "POST",
  body: JSON.stringify({ platform: "vk", name: "Недопустимая платформа", credentials: {} }),
}, cookie);
if (removedPlatform.response.status !== 400) throw new Error(`removedPlatform=${removedPlatform.response.status}`);

const integrations = await request("/api/integrations", {}, cookie);
if (!integrations.response.ok || !integrations.body.length) throw new Error("need at least one integration for smoke test");
const integration = integrations.body[0];
const externalId = `relayboard-smoke-${Date.now()}`;
const destination = await request("/api/destinations", {
  method: "POST",
  body: JSON.stringify({ integrationId: integration.id, externalId, title: "Relayboard backend smoke", kind: "group" }),
}, cookie);
if (!destination.response.ok) throw new Error(`destination=${destination.response.status} ${destination.body.error || ""}`);

const form = new FormData();
form.append("files", new Blob(["relayboard smoke attachment"], { type: "text/plain" }), "smoke.txt");
const uploaded = await request("/api/uploads", { method: "POST", body: form }, cookie);
if (!uploaded.response.ok || uploaded.body.length !== 1) throw new Error(`upload=${uploaded.response.status}`);

const post = await request("/api/posts", {
  method: "POST",
  body: JSON.stringify({
    text: "Relayboard backend smoke — не отправлять",
    mode: "scheduled",
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    timezone: "Europe/Moscow",
    destinationIds: [destination.body.id],
    attachmentIds: [uploaded.body[0].id],
    intervalSeconds: 2,
    maxAttempts: 2,
    retryDelaySeconds: 2,
  }),
}, cookie);
if (!post.response.ok) throw new Error(`post=${post.response.status} ${post.body.error || ""}`);

for (const command of ["pause", "resume", "stop"]) {
  const result = await request(`/api/posts/${post.body.id}/${command}`, { method: "POST" }, cookie);
  if (!result.response.ok) throw new Error(`${command}=${result.response.status} ${result.body.error || ""}`);
}
const removePost = await request(`/api/posts/${post.body.id}`, { method: "DELETE" }, cookie);
if (!removePost.response.ok) throw new Error(`deletePost=${removePost.response.status}`);
const removedFile = await request(`/api/attachments/${uploaded.body[0].id}`, {}, cookie);
if (removedFile.response.status !== 404) throw new Error(`removedFile=${removedFile.response.status}`);
const removeDestination = await request(`/api/destinations/${destination.body.id}`, { method: "DELETE" }, cookie);
if (!removeDestination.response.ok) throw new Error(`deleteDestination=${removeDestination.response.status}`);
const logout = await request("/api/auth/logout", { method: "POST" }, cookie);
if (!logout.response.ok) throw new Error(`logout=${logout.response.status}`);
const loggedOut = await request("/api/auth/session", {}, cookie);
if (loggedOut.response.status !== 401) throw new Error(`loggedOut=${loggedOut.response.status}`);

console.log(JSON.stringify({
  unauthorized: unauthorized.response.status,
  badLogin: badLogin.response.status,
  login: login.response.status,
  upload: uploaded.response.status,
  removedPlatform: removedPlatform.response.status,
  lifecycle: ["pause", "resume", "stop", "delete"],
  loggedOut: loggedOut.response.status,
  cleanup: "ok",
}));
