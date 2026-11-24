# BE13-11A — Contrato de procedencia del broker

Fuente: `src/iot/mqtt-ingestion-boundary.contracts.ts`, `src/services/mqtt-ingestion-boundary.service.ts`.

## `BrokerDeliveryContext` (brokerObserved)

| Campo | Regla | Uso |
| --- | --- | --- |
| `connectionReference` | referencia opaca segura, 1–128 caracteres | fingerprint del contexto |
| `authenticatedPrincipalReference` | referencia opaca o `null` | `null` → `broker-provenance-unverified` sin consultar al verifier |
| `mqttClientId` | id técnico | identidad técnica de conexión; **nunca** el `clientId` de negocio |
| `topic` | 1–1024 caracteres, sin `+`, `#` ni NUL | solo routing (`topicRoutes`) |
| `qos` | 0, 1 o 2 | evidencia; no reemplaza la idempotencia |
| `retain` | booleano | bloqueado por defecto |
| `packetId` | 1–65535 o `null` | evidencia; nunca identidad de evento |
| `receivedAt` | instante técnico observado (ms) | `_receivedAt` y `receivedAt` del documento |
| `rawPersistedAt` | instante ≥ `receivedAt` o `null` | `persistedAt` del documento; sin él, BE13-04 bloquea |

El esquema es cerrado: cualquier campo extra (por ejemplo `verified` o `authenticated`) produce `broker-context-malformed`. Nunca hay contraseñas, claves, tokens completos ni `x-emqx-key`.

## Verificador

```ts
verify({ realm, brokerObserved, contextFingerprint }) → Promise<
  | { status: 'VERIFIED'; realm; principalReference; contextFingerprint; authentication: 'broker-confirmed'; verifiedAt; verifierRevision }
  | { status: 'UNVERIFIED'; realm; reason: 'not-authenticated' | 'principal-unknown' | 'not-authorized'; verifierRevision }
  | { status: 'REJECTED';  realm; reason: 'principal-mismatch' | 'context-mismatch' | 'policy-violation'; verifierRevision }>
```

El boundary acepta `VERIFIED` solo si se cumplen todas estas condiciones:

1. la respuesta es estricta y válida;
2. el realm es el del bootstrap;
3. el `contextFingerprint` es **el mismo** que calculó el boundary para esta entrega;
4. el `principalReference` es el que observó el adapter.

| Respuesta | Código | Clase |
| --- | --- | --- |
| Excepción o timeout (`verifierTimeoutMs` inyectable) | `broker-verifier-unavailable` | transient |
| Malformada, getter hostil, revisión inválida | `invalid-authority-response` | security |
| Realm distinto | `broker-realm-mismatch` | security |
| `UNVERIFIED` con `principal-unknown` | `broker-principal-unknown` | security |
| Otro `UNVERIFIED` | `broker-provenance-unverified` | security |
| `REJECTED` | `broker-provenance-rejected` | security |
| `VERIFIED` para otro contexto o principal | `broker-context-mismatch` | security |

## `BrokerProvenanceEvidence`

La arma el boundary con el verifier y el mapping: `realm`, `principalReference`, `authentication: 'broker-confirmed'`, `sourceId`, `technicalDeviceKey`, `connectionReference`, `contextFingerprint`, `verifiedAt`, `verifierRevision` y `mappingRevision`.

El resultado `ingested` expone `sourceId`, `principalReference`, `contextFingerprint` y las dos revisiones, para auditoría y revalidación futura. Son copias: mutar después las respuestas no cambia nada. **No es una atestación de hardware.**

## Revalidación

No se revalida antes de persistir. Hay una ventana TOCTOU entre `verify` y el commit, y no se promete atomicidad con el broker.
