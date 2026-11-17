# Security Specification — Mujeeb Persistent Cloud Store

## 1. Data Invariants
1. Every document lives strictly inside `/users/{userId}/...` and MUST carry `ownerId == userId == request.auth.uid`.
2. Unauthenticated or unverified-email requests (`request.auth == null || request.auth.token.email_verified != true`) are unconditionally denied for all reads and writes.
3. Document IDs (`userId`, `pageId`, `ruleId`) MUST match `^[a-zA-Z0-9_\-]+$` and be `<= 128` chars.
4. Every string field is bounded with explicit `.size() <= MAX` checks; every array (`keywords`, `excludeKeywords`, `publicReplies`, `repliedCommentIds`) is strictly bounded in size and validates element type at index 0 when non-empty.
5. `ownerId` and `createdAt` are immutable after creation; `createdAt == request.time` on create and `updatedAt == request.time` on create and update.
6. Every update uses explicit action branches with `incoming().diff(existing()).affectedKeys().hasOnly([...])` wrapped in `isValid[Entity](incoming())`.

## 2. "Dirty Dozen" Adversarial Payloads (All Expected: PERMISSION_DENIED)
1. Unauthenticated read of `/users/u1/settings/main` -> DENIED (`request.auth == null`).
2. Verified user `u2` attempting `get` or `list` on `/users/u1/rules` -> DENIED (`request.auth.uid != userId`).
3. Signed-in user with `email_verified: false` attempting write to `/users/u1/settings/main` -> DENIED (`email_verified == true` required).
4. Shadow field injection on create (`{ ..., isAdmin: true }`) -> DENIED (`keys().hasOnly(...)`).
5. Shadow field injection on update (`{ ..., extraKey: "hack" }`) -> DENIED (`affectedKeys().hasOnly(...)` + `keys().hasOnly(...)`).
6. Identity spoofing (`ownerId: "victim_uid"` under `/users/u1/...`) -> DENIED (`ownerId == request.auth.uid`).
7. Out-of-range `autoReplyDelaySeconds` (`0` or `9999`) -> DENIED (`>= 1 && <= 300`).
8. Oversized string injection (`aiPrompt` > 4000 chars or `name` > 200 chars) -> DENIED (`.size()` limit).
9. Resource-poisoning doc ID (`ruleId` > 128 chars or containing invalid symbols) -> DENIED (`isValidId(ruleId)`).
10. Client-forged timestamp (`createdAt: "2020-01-01"` instead of `request.time`) -> DENIED (`== request.time`).
11. Mutating immutable `ownerId` or `createdAt` during update -> DENIED (`incoming().ownerId == existing().ownerId && incoming().createdAt == existing().createdAt`).
12. Unbounded array injection (`keywords` with 500 items or `publicReplies[0]` as integer) -> DENIED (`.size() <= 50` and `[0] is string`).
