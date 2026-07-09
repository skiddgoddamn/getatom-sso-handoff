# Сторона getatom (issuer)

Справочное описание нашей стороны протокола. Партнёру для интеграции достаточно [vendor-consumer.md](vendor-consumer.md) — этот документ о том, как issuer устроен внутри (реализован в maxBackend, пакет `org.skiddgoddamn.sso`).

## Эндпоинты

### `GET /api/sso/{service}` — точка входа

- С живой сессией getatom: выпускает JWT (см. [jwt-spec.md](jwt-spec.md)) и отвечает `302 → <ssoUrl>?token=<jwt>`.
- Аноним: `302 → https://getatom.ru/auth?redirect=/api/sso/{service}` — после логина фронт возвращает браузер сюда полной навигацией, и хендофф завершается. Так работает кнопка «Войти через getatom» на лендинге партнёра.
- Неизвестный/выключенный сервис или незаданный ключ → 404.
- Целевой URL берётся **только из конфигурации** — redirect-параметры не принимаются, open redirect исключён by construction.

### `GET /.well-known/jwks.json` — публичные ключи

JWK Set, публичный, `Cache-Control: max-age=600`. При невыставленном ключе — 404.

## Конфигурация (env)

| Переменная | Назначение | Default |
|---|---|---|
| `SSO_SIGNING_KEY_PEM` | Приватный RSA-ключ PKCS#8. Принимается PEM с настоящими переводами строк, PEM с экранированными `\n` (однострочный env) или голый base64 без PEM-обёртки. **Пусто → SSO выключен целиком.** | пусто |
| `SSO_KEY_ID` | `kid` активного ключа (в JWT header и JWKS) | `2026-07-a` |
| `SSO_ISSUER` | Значение `iss` | `https://getatom.ru` |
| `SSO_CRM_ENABLED` | Включение сервиса `crm` | `false` |
| `SSO_CRM_AUD` | `aud` токенов для crm — хост сервиса партнёра | `crm.getatom.ru` |
| `SSO_CRM_SSO_URL` | Точка приёма токена у партнёра | `https://crm.getatom.ru/sso` |

Хост партнёра может быть любым — меняются только `SSO_CRM_AUD` и `SSO_CRM_SSO_URL`. Новый сервис-партнёр = новый блок `sso.services.<code>.*` в `application.properties` (по образцу crm) — код трогать не нужно.

Генерация ключа:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
```

## Псевдонимные идентификаторы

Коллекция `user_sso_ids`: `{ userId, service, pseudoId (UUIDv4), createdAt }`, уникальные индексы `(userId, service)` и `pseudoId` (создаёт `SsoIndexInitializer`). `pseudoId` выдаётся один раз и не меняется; гонка первого клика разрешается через DuplicateKeyException-retry. Внутренний `userId` наружу не уходит.

## Куки

Кука сессии getatom — host-only (без `Domain=`), см. `CookieSerializer` в SecurityConfig. Это обязательное условие протокола: сессионные куки не должны уходить на поддомены.

## Фронтенд (maxFrontend)

- `next.config.ts`: rewrite `/.well-known/jwks.json → бэкенд` (путь вне `/api`, иначе Next отдал бы 404).
- `AuthPageClient`: сохранённый `?redirect=`, указывающий на `/api/*`, после логина уходит `window.location.assign` (полная навигация) — это бэкенд-эндпоинт с 302, а не SPA-роут.
- Точки входа — любая ссылка на `/api/sso/{service}` (кнопка в продукте, ссылка на лендинге партнёра). Отдельной кнопки в сайдбаре сейчас нет — вход со стороны партнёра.

## Ротация ключей

Процедура описана в [jwt-spec.md](jwt-spec.md). Текущая реализация публикует в JWKS один активный ключ; на время ротации потребуется отдавать старый и новый одновременно (небольшая доработка `SsoService.publicJwks()` — второй ключ в `JWKSet`). Контракт для партнёра неизменен: резолвить ключ по `kid`, при неизвестном — перечитать JWKS.
