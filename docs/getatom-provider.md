# Сторона getatom (issuer)

Что реализует maxBackend (Java / Spring Boot). Партнёру этот документ нужен только для понимания — реализация целиком наша.

## Эндпоинты

### `GET /api/sso/{service}` — точка входа

- Требует живую сессию getatom. Аноним → редирект на логин с `returnUrl` обратно на этот эндпоинт.
- `service` — код сервиса из реестра (для CRM — `crm`). Неизвестный сервис → 404.
- Логика:
  1. найти/создать псевдонимный UUID пользователя для этого сервиса;
  2. выпустить JWT (см. [jwt-spec.md](jwt-spec.md));
  3. `302 Location: https://crm.getatom.ru/sso?token=<jwt>`.

### `GET /.well-known/jwks.json` — публичные ключи

Отдаёт JWK Set. Кэшируемый, публичный, без авторизации.

## Реестр сервисов

Конфигурация в БД или properties — на каждый подключённый сервис:

| Поле | Пример |
|---|---|
| `code` | `crm` |
| `aud` / хост | `crm.getatom.ru` |
| `ssoUrl` | `https://crm.getatom.ru/sso` |
| `enabled` | `true` |

## Псевдонимные идентификаторы

Коллекция `user_sso_ids`:

```
{ userId: <внутренний id>, service: "crm", pseudoId: "d0a1f3c4-...", createdAt }
```

- Уникальный индекс по `(userId, service)` и по `pseudoId`.
- `pseudoId` генерируется один раз (UUIDv4) и никогда не меняется — у партнёра пользователь стабильный.
- Внутренний `userId` наружу не уходит никогда.

## Выпуск токена (Nimbus JOSE)

Зависимость: `com.nimbusds:nimbus-jose-jwt`.

```java
@GetMapping("/api/sso/{service}")
public ResponseEntity<Void> sso(@PathVariable String service, Authentication auth) {
    SsoService cfg = ssoRegistry.getEnabled(service); // 404 если нет
    String pseudoId = pseudoIdService.findOrCreate(currentUserId(auth), service);

    Instant now = Instant.now();
    JWTClaimsSet claims = new JWTClaimsSet.Builder()
            .issuer("https://getatom.ru")
            .audience(cfg.aud())
            .subject(pseudoId)
            .claim("name", currentUserDisplayName(auth)) // опционально
            .issueTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(60)))
            .jwtID(UUID.randomUUID().toString())
            .build();

    SignedJWT jwt = new SignedJWT(
            new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(activeKeyId).build(),
            claims);
    jwt.sign(new RSASSASigner(privateKey)); // ключ из env/секрета, не из репозитория

    URI target = URI.create(cfg.ssoUrl() + "?token=" + jwt.serialize());
    return ResponseEntity.status(HttpStatus.FOUND).location(target).build();
}
```

## Хранение ключей

- Приватный ключ RSA (2048+) — в переменной окружения / секрете деплоя (`SSO_SIGNING_KEY_PEM`), **не в git**.
- `kid` — версионируемая строка (`2026-07-a`); при ротации новый ключ добавляется в JWKS заранее (процедура в [jwt-spec.md](jwt-spec.md)).

## Кука сессии getatom

Обязательно: кука сессии выставляется **host-only** на `getatom.ru` (без `Domain=.getatom.ru`). Иначе она полетит на поддомены партнёров — это утечка учётных данных, весь протокол теряет смысл.

## Кнопка в сайдбаре (maxFrontend)

Обычная ссылка в той же вкладке:

```tsx
<a href="/api/sso/crm">CRM</a>
```

Никакой логики на фронте: редиректы делает бэкенд.
