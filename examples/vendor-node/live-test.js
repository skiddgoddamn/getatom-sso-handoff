// Живой тест против настоящего getatom.ru: лендинг с кнопкой «Войти через
// getatom» → логин на getatom → возврат на /sso с токеном → сессия.
//
// Требует, чтобы на стороне getatom SSO_CRM_SSO_URL указывал на этот сервер
// (http://localhost:3000/sso). Запуск: node live-test.js
//
// Отличие от server.js: страница «/» не редиректит анонима автоматически,
// а показывает кнопку — как это будет выглядеть на лендинге партнёра.

import express from 'express';
import crypto from 'node:crypto';
import * as jose from 'jose';

const PORT = Number(process.env.PORT || 3000);
const ISSUER = process.env.GETATOM_ISSUER || 'https://getatom.ru';
const AUDIENCE = process.env.AUDIENCE || 'crm.getatom.ru';
const JWKS_URL = process.env.GETATOM_JWKS_URL || 'https://getatom.ru/api/public/sso/jwks.json';
const GETATOM_SSO_URL = process.env.GETATOM_SSO_URL || 'https://getatom.ru/api/sso/crm';
const CLOCK_TOLERANCE_SEC = 30;

const app = express();
const usedJti = new Map();
const users = new Map();
const sessions = new Map();

const jwks = jose.createRemoteJWKSet(new URL(JWKS_URL), { cacheMaxAge: 10 * 60_000 });

const page = (body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SSO live-тест</title>
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:80px auto;line-height:1.6">
${body}</body>`;

function getSession(req) {
  const sid = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith('sid='))?.slice(4);
  return sid ? sessions.get(sid) : undefined;
}

app.get('/', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.send(page(`
      <h2>Тестовый «сервис партнёра»</h2>
      <p>Вы не авторизованы. Нажмите кнопку — произойдёт полный SSO-цикл:
      вход на getatom.ru (если нужно) и возврат сюда уже с сессией.</p>
      <p><a href="${GETATOM_SSO_URL}" style="display:inline-block;padding:12px 24px;
      background:#007AFF;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">
      Войти через getatom</a></p>`));
  }
  const user = users.get(session.sub);
  res.send(page(`
    <h2>✅ Вы авторизованы</h2>
    <p>Привет, <b>${user.name}</b>!</p>
    <p>Псевдонимный ID (<code>sub</code>): <code>${user.sub}</code></p>
    <p>Токен выпущен getatom, подпись проверена по JWKS, jti погашен.
    Это вся информация, которую сервис получил о пользователе.</p>
    <p><a href="/logout">Выйти</a> · <a href="${GETATOM_SSO_URL}">Пройти SSO ещё раз</a></p>`));
});

app.get('/sso', async (req, res) => {
  const { token, retry } = req.query;
  if (!token) {
    if (retry) return res.status(403).send(page('<h2>Ошибка входа</h2><p>Токен не пришёл повторно.</p>'));
    return res.redirect(302, `${GETATOM_SSO_URL}?retry=1`);
  }
  let payload;
  try {
    ({ payload } = await jose.jwtVerify(String(token), jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }));
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired && !retry) {
      return res.redirect(302, `${GETATOM_SSO_URL}?retry=1`);
    }
    console.warn('[sso] отклонён токен:', err.code || err.message);
    return res.status(403).send(page(`<h2>Ошибка входа</h2><p>${err.code || err.message}</p>`));
  }
  const { jti, exp, sub, name } = payload;
  if (!jti || !sub) return res.status(403).send(page('<h2>Ошибка</h2><p>Нет обязательных claims.</p>'));
  if (usedJti.has(jti)) return res.status(403).send(page('<h2>Ошибка</h2><p>Ссылка уже использована (jti).</p>'));
  usedJti.set(jti, (exp || 0) + CLOCK_TOLERANCE_SEC);

  if (!users.has(sub)) users.set(sub, { sub, name: name || 'Пользователь' });
  else if (name) users.set(sub, { ...users.get(sub), name });

  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { sub });
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  res.redirect(303, '/');
});

app.get('/logout', (req, res) => {
  const session = getSession(req);
  if (session) for (const [sid, s] of sessions) if (s === session) sessions.delete(sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect(302, '/');
});

app.listen(PORT, () => {
  console.log(`Live-тест: http://localhost:${PORT}`);
  console.log(`issuer=${ISSUER}  aud=${AUDIENCE}`);
  console.log(`jwks=${JWKS_URL}`);
  console.log(`Кнопка ведёт на: ${GETATOM_SSO_URL}`);
});
