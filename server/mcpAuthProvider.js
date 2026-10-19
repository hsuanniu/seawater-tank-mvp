import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { escapeHtml } from "../services/formatService.js";

export const REEF_MCP_SCOPE = "reef:read";
const ACCESS_SECONDS = 30 * 60;
const REFRESH_MS = 30 * 86400000;
const opaque = () => randomBytes(32).toString("base64url");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const same = (a, b) => typeof a === "string" && a.length <= 4096 && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export function createMcpAuthProvider({ store, adminPassword, readToken, publicUrl, now = () => Date.now() }) {
  const resource = `${publicUrl}/api/mcp`;
  const origin = new URL(publicUrl).origin;
  const authVersion = hash(`reef-mcp-v1\0${adminPassword}\0${readToken}`);
  const encryptionKey = Buffer.from(authVersion, "hex");
  const current = (data) => data?.authVersion === authVersion;
  const encrypt = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  };
  const decrypt = (value) => {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", encryptionKey, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  };
  const checkResource = (value) => {
    if (value && value.href !== resource) throw new InvalidTargetError("Only the Reef MCP resource is supported");
  };
  const checkScopes = (scopes = []) => {
    if (scopes.some((scope) => scope !== REEF_MCP_SCOPE)) throw new InvalidScopeError("Only reef:read is supported");
    return [REEF_MCP_SCOPE];
  };
  const requestData = (client, params) => ({ clientId: client.client_id, redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge, state: params.state || "", resource, scopes: checkScopes(params.scopes) });

  function consentPage(res, client, params, ticket, error = "") {
    const fields = { response_type: "code", client_id: client.client_id, redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge, code_challenge_method: "S256", scope: REEF_MCP_SCOPE,
      state: params.state || "", resource, consent_ticket: ticket };
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.type("html").send(`<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>連接海水缸資料</title>
      <style>html{color-scheme:light;font-family:system-ui,-apple-system,sans-serif;background:#eef8fb;color:#102a36}*{box-sizing:border-box}body{margin:0;padding:32px 20px calc(24px + env(safe-area-inset-bottom))}main{max-width:420px;margin:0 auto}img{border-radius:16px}h1{font-size:24px;margin:18px 0}p,li{line-height:1.65}form{margin-top:24px}label{display:block;font-weight:600}input,button{font:inherit;min-height:48px;width:100%;border-radius:8px;padding:12px;margin:8px 0;border:1px solid #afcbd4}input{font-size:16px;background:white}button{background:#087fa0;color:white;font-weight:700}button.secondary{background:white;color:#304d5b}.error{color:#b52638}small{display:block;color:#496675;line-height:1.6}</style></head>
      <body><main><img src="/reef-clownfish.png" width="64" height="64" alt=""><h1>連接海水缸資料</h1><p>${escapeHtml(client.client_name || "海水缸分析庫")} 正在要求讀取你的魚缸資料</p>
      <small>授權回傳至 ${escapeHtml(new URL(params.redirectUri).host)}</small><ul><li>讀取水質、滴定設定與安全引擎建議</li><li>讀取滴定桶推估庫存與提醒</li><li>不能修改滴定設定、刪除紀錄或控制設備</li></ul><small>查詢會沿用既有庫存補算機制，更新推估庫存與計算紀錄；不會調整滴定量。</small>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/authorize">
      ${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("")}
      <label for="password">原本的雲端管理密碼</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
      <button name="decision" value="allow">允許查詢並連接</button><button class="secondary" name="decision" value="deny" formnovalidate>取消</button></form>
      <small>請只在 ${escapeHtml(new URL(publicUrl).host)} 輸入密碼，不需要把密碼或 Token 貼到聊天裡。</small></main></body></html>`);
  }

  async function codeFor(client, code) {
    const data = await store.get("code", code);
    if (!current(data) || data.clientId !== client.client_id) throw new InvalidGrantError("Authorization code is invalid or expired");
    return data;
  }

  async function issueTokens(kind, source, data) {
    const access = opaque(), refresh = opaque();
    const tokenData = { authVersion, clientId: data.clientId, scopes: data.scopes, resource,
      familyId: data.familyId || randomUUID(), refreshExpiresAt: data.refreshExpiresAt || now() + REFRESH_MS };
    if (tokenData.refreshExpiresAt <= now()) throw new InvalidGrantError("Connection has expired; reconnect to authorize");
    const exchanged = await store.exchange(kind, source, data, [
      { kind: "access", token: access, clientId: data.clientId, data: { ...tokenData, expiresAt: Math.floor(now() / 1000) + ACCESS_SECONDS }, expiresAt: now() + ACCESS_SECONDS * 1000 },
      { kind: "refresh", token: refresh, clientId: data.clientId, data: tokenData, expiresAt: tokenData.refreshExpiresAt },
    ]);
    if (!exchanged) throw new InvalidGrantError("Credential has already been exchanged");
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: REEF_MCP_SCOPE };
  }

  return {
    clientsStore: {
      async getClient(clientId) {
        const data = await store.get("client", clientId);
        if (!current(data)) return undefined;
        try { return decrypt(data.encrypted); } catch { return undefined; }
      },
      async registerClient(client) {
        if (!client.redirect_uris?.length || client.redirect_uris.length > 5 || client.redirect_uris.some((value) => {
          const url = new URL(value);
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          return value.length > 2048 || url.username || url.password || url.hash
            || (!loopback && !["chatgpt.com", "chat.openai.com"].includes(url.hostname))
            || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback));
        })) throw new InvalidClientMetadataError("Use a ChatGPT HTTPS or local Codex redirect URI");
        if (client.client_name?.length > 100 || !["none", "client_secret_post", undefined].includes(client.token_endpoint_auth_method)) throw new InvalidClientMetadataError("Unsupported client metadata");
        if (client.scope) checkScopes(client.scope.split(" "));
        await store.put("client", client.client_id, client.client_id, { authVersion, encrypted: encrypt(client) }, now() + 90 * 86400000);
        return client;
      },
    },
    async authorize(client, params, res) {
      checkResource(params.resource);
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state || "").length > 2048) throw new InvalidRequestError("Use a valid S256 PKCE challenge");
      const details = requestData(client, params);
      const req = res.req;
      const ticket = req.body?.consent_ticket;
      if (req.method === "POST" && ["allow", "deny"].includes(req.body?.decision)) {
        const pending = await store.get("consent", ticket);
        const cookie = (req.headers.cookie || "").split(";").map((v) => v.trim()).find((v) => v.startsWith("reef_mcp_consent="))?.slice("reef_mcp_consent=".length) || "";
        if (req.headers.origin !== origin || !current(pending) || !same(cookie, pending.nonce || "")
          || !isDeepStrictEqual(pending.details, details)) throw new InvalidGrantError("Authorization page expired; start the connection again");
        if (req.body.decision === "allow" && !same(req.body.password, adminPassword)) return consentPage(res, client, params, ticket, "管理密碼不正確，請使用原本雲端同步的管理密碼");
        const code = opaque();
        const records = req.body.decision === "deny" ? [] : [{ kind: "code", token: code, clientId: client.client_id,
          data: { ...details, authVersion }, expiresAt: now() + 5 * 60000 }];
        if (!await store.exchange("consent", ticket, pending, records)) throw new InvalidGrantError("Authorization has already been completed");
        res.clearCookie("reef_mcp_consent", { path: "/authorize" });
        const redirect = new URL(params.redirectUri);
        redirect.searchParams.set(req.body.decision === "deny" ? "error" : "code", req.body.decision === "deny" ? "access_denied" : code);
        if (params.state) redirect.searchParams.set("state", params.state);
        redirect.searchParams.set("iss", `${publicUrl}/`);
        return res.redirect(302, redirect.href);
      }
      const consent = opaque(), nonce = opaque();
      await store.put("consent", consent, client.client_id, { authVersion, details, nonce }, now() + 10 * 60000);
      res.cookie("reef_mcp_consent", nonce, { httpOnly: true, sameSite: "lax", secure: new URL(publicUrl).protocol === "https:", path: "/authorize", maxAge: 10 * 60000 });
      return consentPage(res, client, params, consent);
    },
    async challengeForAuthorizationCode(client, code) { return (await codeFor(client, code)).codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, target) {
      checkResource(target);
      const data = await codeFor(client, code);
      if (redirectUri !== data.redirectUri) throw new InvalidGrantError("redirect_uri must match authorization");
      return issueTokens("code", code, data);
    },
    async exchangeRefreshToken(client, token, scopes, target) {
      checkResource(target); checkScopes(scopes);
      const data = await store.get("refresh", token);
      if (!current(data) || data.clientId !== client.client_id) throw new InvalidGrantError("Refresh token is invalid or expired");
      return issueTokens("refresh", token, data);
    },
    async verifyAccessToken(token) {
      const data = await store.get("access", token);
      if (!current(data) || data.resource !== resource || !data.scopes?.includes(REEF_MCP_SCOPE)) throw new InvalidTokenError("Access token is invalid or expired");
      return { token, clientId: data.clientId, scopes: data.scopes, expiresAt: data.expiresAt, resource: new URL(resource) };
    },
    async revokeToken(client, { token }) {
      const data = await store.get("access", token) || await store.get("refresh", token);
      if (current(data) && data.clientId === client.client_id) await store.revokeFamily(client.client_id, data.familyId);
    },
  };
}
