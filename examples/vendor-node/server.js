// Пример сервиса-партнёра, принимающего SSO-пользователей getatom.
// Реализует GET /sso?token=<jwt> со всеми проверками из docs/vendor-consumer.md.
//
// Два режима:
//   - MOCK (по умолчанию): сервер сам играет роль getatom — генерирует ключи,
//     отдаёт /.well-known/jwks.json и выпускает токены на /mock-login.
//     Позволяет проверить интеграцию локально без доступа к getatom.
//   - PROD: задайте env-переменные, и /sso начнёт принимать реальные токены getatom:
//       GETATOM_ISSUER=https://getatom.ru
//       GETATOM_JWKS_URL=https://getatom.ru/.well-known/jwks.json
//       AUDIENCE=crm.getatom.ru
//       GETATOM_SSO_URL=https://getatom.ru/api/sso/crm

import express from 'express';
import crypto from 'node:crypto';
import * as jose from 'jose';

const PORT = Number(process.env.PORT || 3000);
const MOCK = !process.env.GETATOM_JWKS_URL;

const ISSUER = process.env.GETATOM_ISSUER || `http://localhost:${PORT}`;
const AUDIENCE = process.env.AUDIENCE || 'crm.getatom.ru';
const JWKS_URL = process.env.GETATOM_JWKS_URL || `http://localhost:${PORT}/.well-known/jwks.json`;
const GETATOM_SSO_URL = process.env.GETATOM_SSO_URL || `http://localhost:${PORT}/mock-login`;
const CLOCK_TOLERANCE_SEC = 30;

const app = express();

// ---------------------------------------------------------------------------
// Хранилища. В примере — in-memory; в проде jti и сессии кладите в Redis/БД.
// ---------------------------------------------------------------------------

/** Использованные jti → unix-время, до которого запись надо хранить (exp + skew). */
const usedJti = new Map();
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, keepUntil] of usedJti) if (keepUntil < now) usedJti.delete(jti);
}, 60_000).unref();

/** Пользователи партнёра: ключ — псевдонимный sub из токена getatom. */
const users = new Map();

/** Сессии партнёра: случайный sid → { sub } */
const sessions = new Map();

function findOrCreateUser(sub, name) {
  let user = users.get(sub);
  if (!user) {
    user = { sub, name: name || 'Пользователь', createdAt: new Date().toISOString() };
    users.set(sub, user);
  } else if (name) {
    user = { ...user, name };
    users.set(sub, user);
  }
  return user;
}

function createSession(res, sub) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { sub, createdAt: Date.now() });
  // Host-only кука (без Domain=!), HttpOnly, SameSite=Lax; Secure — в проде (https).
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
}

function getSession(req) {
  const sid = (req.headers.cookie || '')
    .split(';').map(c => c.trim())
    .find(c => c.startsWith('sid='))?.slice(4);
  return sid ? sessions.get(sid) : undefined;
}

// ---------------------------------------------------------------------------
// JWKS getatom — кэшируется библиотекой jose, ключ выбирается по kid.
// Создаём лениво, чтобы в MOCK-режиме сервер успел подняться.
// ---------------------------------------------------------------------------

let remoteJwks;
function jwks() {
  if (!remoteJwks) {
    remoteJwks = jose.createRemoteJWKSet(new URL(JWKS_URL), { cacheMaxAge: 10 * 60_000 });
  }
  return remoteJwks;
}

// ---------------------------------------------------------------------------
// ГЛАВНОЕ: GET /sso?token=<jwt>
// ---------------------------------------------------------------------------

app.get('/sso', async (req, res) => {
  const { token, retry } = req.query;

  // Нет токена → отправляем на getatom за новым (один раз, без петли).
  if (!token) return redirectToGetatom(res, retry);

  let payload;
  try {
    // Подпись по JWKS + строгие iss/aud/alg + допуск по времени 30с — всё в одном вызове.
    ({ payload } = await jose.jwtVerify(String(token), jwks(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'], // всё остальное (none/HS256/...) отклоняется до проверки подписи
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }));
  } catch (err) {
    // Истёкший токен — штатная ситуация (пользователь долго шёл по ссылке): пробуем перевыпустить.
    if (err instanceof jose.errors.JWTExpired) return redirectToGetatom(res, retry);
    // Всё остальное (подпись, iss, aud, alg) — не «протухло», а атака или misconfig. Без редиректов.
    console.warn('[sso] отклонён токен:', err.code || err.message);
    return res.status(403).send(errorPage('Недействительный токен авторизации.'));
  }

  // Одноразовость: jti обязателен и не должен встречаться повторно.
  const { jti, exp, sub, name } = payload;
  if (!jti || !sub) return res.status(403).send(errorPage('В токене нет обязательных полей.'));
  if (usedJti.has(jti)) {
    console.warn('[sso] ИНЦИДЕНТ: повторное использование jti', jti);
    return res.status(403).send(errorPage('Ссылка для входа уже была использована.'));
  }
  usedJti.set(jti, (exp || 0) + CLOCK_TOLERANCE_SEC);

  const user = findOrCreateUser(sub, typeof name === 'string' ? name : undefined);
  createSession(res, user.sub);

  // Немедленный redirect: токен не должен остаться в адресной строке/истории/Referer.
  res.redirect(303, '/');
});

function redirectToGetatom(res, retry) {
  if (retry) {
    // Уже пробовали перевыпустить — стоп, иначе петля редиректов.
    return res.status(403).send(errorPage('Не удалось выполнить вход. Откройте CRM из меню getatom ещё раз.'));
  }
  const sep = GETATOM_SSO_URL.includes('?') ? '&' : '?';
  res.redirect(302, `${GETATOM_SSO_URL}${sep}retry=1`);
}

function errorPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>Ошибка входа</title>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto">
<h2>Ошибка входа</h2><p>${message}</p>
<p><a href="${GETATOM_SSO_URL}">Войти через getatom</a></p></body>`;
}

// ---------------------------------------------------------------------------
// Приложение партнёра (демо-страница за авторизацией)
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  const session = getSession(req);
  if (!session) return res.redirect(302, GETATOM_SSO_URL);
  const user = users.get(session.sub);
  res.send(`<!doctype html><meta charset="utf-8"><title>CRM</title>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto">
<h2>Вы в CRM</h2>
<p>Привет, <b>${user.name}</b>!</p>
<p>Ваш псевдонимный ID (sub): <code>${user.sub}</code></p>
<p>Это всё, что CRM знает о пользователе getatom.</p>
<p><a href="/logout">Выйти</a></p></body>`);
});

app.get('/logout', (req, res) => {
  const session = getSession(req);
  if (session) for (const [sid, s] of sessions) if (s === session) sessions.delete(sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect(302, '/');
});

// ---------------------------------------------------------------------------
// MOCK-режим: локальная имитация getatom (issuer + JWKS)
// ---------------------------------------------------------------------------

if (MOCK) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const publicJwk = { ...(await jose.exportJWK(publicKey)), kid: 'mock-1', use: 'sig', alg: 'RS256' };

  app.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: [publicJwk] }));

  // Имитация GET /api/sso/crm на стороне getatom: выпустить токен и редиректнуть на /sso.
  app.get('/mock-login', async (req, res) => {
    const token = await new jose.SignJWT({ name: 'Иван (мок)' })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(req.query.sub || 'd0a1f3c4-9b2e-4f7a-8c1d-5e6f7a8b9c0d')
      .setIssuedAt()
      .setExpirationTime('60s')
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    res.redirect(302, `/sso?token=${token}`);
  });
}

app.listen(PORT, () => {
  console.log(`Пример вендора запущен: http://localhost:${PORT}`);
  console.log(MOCK
    ? 'Режим MOCK: откройте http://localhost:' + PORT + '/ — произойдёт полный цикл SSO локально.'
    : `Режим PROD: issuer=${ISSUER}, aud=${AUDIENCE}, jwks=${JWKS_URL}`);
});
