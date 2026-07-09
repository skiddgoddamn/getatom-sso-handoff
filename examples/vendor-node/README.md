# Пример интеграции: сервис партнёра (Node.js / Express)

Референсная реализация приёма пользователей getatom через `GET /sso?token=<jwt>` — все проверки из [docs/vendor-consumer.md](../../docs/vendor-consumer.md): подпись по JWKS, `iss`/`aud`/`exp`, одноразовый `jti`, собственная host-only сессия, немедленный redirect.

## Запуск локально (MOCK-режим)

Без доступа к getatom — сервер сам имитирует issuer:

```bash
npm install
npm start
# открыть http://localhost:3000/
```

Что произойдёт: `/` → нет сессии → редирект на `/mock-login` (имитация `getatom.ru/api/sso/crm`) → выпуск токена → `302 /sso?token=<jwt>` → проверки → сессия → `/` уже авторизован.

## Что потестировать руками

- **Повторный jti**: скопируйте из адресной строки URL `/sso?token=...` до редиректа (или из логов мока), откройте второй раз → `403 Ссылка уже использована`.
- **Истёкший токен**: подождите 90+ секунд с тем же URL → редирект на перевыпуск.
- **Чужой aud / мусор**: подставьте произвольный JWT → `403` без редирект-петли.

## Подключение к реальному getatom

```bash
GETATOM_ISSUER=https://getatom.ru \
GETATOM_JWKS_URL=https://getatom.ru/.well-known/jwks.json \
AUDIENCE=crm.getatom.ru \
GETATOM_SSO_URL=https://getatom.ru/api/sso/crm \
NODE_ENV=production \
npm start
```

## Перенос в свой стек

Логика умещается в один обработчик — см. `server.js`, секция `app.get('/sso', ...)`. Под любой язык есть аналог `jose`:

| Стек | Библиотека |
|---|---|
| Node.js | `jose` (используется здесь) |
| PHP | `firebase/php-jwt` + JWKS-кэш |
| Python | `PyJWT` + `PyJWKClient` |
| Java | `com.nimbusds:nimbus-jose-jwt` |
| Go | `github.com/lestrrat-go/jwx` |
| .NET | `Microsoft.IdentityModel.Tokens` |

В проде замените in-memory `usedJti` и `sessions` на Redis/БД — в примере они в памяти только для наглядности.
