# CONTRATO BE13-11C — Puerto del futuro adapter EMQX

Estado: **solo contrato**. No hay implementación, SDK MQTT, conexión, credencial, suscripción ni consumer. Código: `src/iot/broker-adapter.contracts.ts`.

## 1. Qué puede producir el adapter (hechos observados)

| Campo | Descripción |
|---|---|
| `connectionReference` | Referencia técnica opaca de la conexión/sesión observada. |
| `authenticatedPrincipalReference` | Principal que el broker dice haber autenticado, o `null`. Es un hecho observado, **no** una verificación. |
| `mqttClientId` | Client id MQTT observado. |
| `topic` | Topic observado. Solo enrutamiento. |
| `qos` | 0, 1 o 2. |
| `retain` | Flag observado. La política sigue fail-closed (retained bloqueado por defecto). |
| `packetId` | Entero 1..65535 o `null`. Nunca identidad de negocio. |
| `receivedAt` | Instante técnico en que el adapter recibió el mensaje. |
| `payload` | Bytes exactos, sin transformar. |

Opcionalmente (`AdapterAuthenticationReferences`): referencia al mecanismo de autenticación, nodo del broker y sesión. Son referencias opacas; **no se eligió** mTLS, JWT, password ni plugin.

## 2. Qué NO puede producir (autoridad prohibida)

`ADAPTER_FORBIDDEN_AUTHORITY_FIELDS`: `realm`, `clientId`/`clientid`/`businessClientId`, `sourceId`, `trusted`, `verified`, `verification`, `hardwareIdentity`, `deviceId`, `sensorId`, `rawPersistedAt`, `persistedAt`.

El boundary lo hace cumplir: el delivery es un esquema **cerrado**; cualquier clave extra produce `broker-context-malformed` y no se persiste nada (R17, A11–A13).

| Autoridad | Quién la decide |
|---|---|
| Realm | Bootstrap/configuración autorizada del boundary. Nunca el topic ni el adapter (R18, A13). |
| Identidad técnica / `sourceId` | Verifier de procedencia + identity mapping (autoridades inyectadas). |
| `clientId` de negocio / ownership | Catálogo y asociaciones del backend, no el broker. |
| Hardware identity | Autoridad de hardware (BE13-03). |
| `rawPersistedAt` | Servidor Mongo en la escritura del inbox. |

## 3. Frontera de confianza

El adapter forma parte del **Trusted Computing Base**. Si miente sobre hechos observados (por ejemplo, declara otro principal o un `receivedAt` falso), el boundary **no puede detectarlo del todo**: solo verifica coherencia con el verifier/mapping y rechaza campos de autoridad. Mitigaciones futuras (fuera de este ciclo): revisión del adapter, autenticación mutua entre adapter y backend, y atestación del nodo del broker. Es un riesgo residual explícito.

## 4. Realm

Lo fija el bootstrap (`realmAuthority`). El adapter no lo conoce ni lo envía. Un topic que mencione `production` no cambia el realm (A13).

## 5. Pérdida de conexión (contrato conceptual)

Estados a distinguir en un consumer futuro:

| Estado | Significado | Qué se garantiza |
|---|---|---|
| `received` | El adapter recibió un mensaje. | Nada durable todavía. |
| `persist-pending` | Se llamó a `admit` y no hay respuesta. | Puede existir o no un registro (N4). No ACKear. |
| `persisted` | Hay receipt (majority + j). | Seguro ACKear. |
| `broker-connection-lost` | Se perdió el enlace con el broker. | Los `persist-pending` quedan ambiguos: la reconciliación (BE13-11C) los resuelve; QoS 1/2 puede redelivery y el negocio deduplica. |

No se implementa reconexión.

## 6. Reloj (N1)

Ver `INFORME_BE13_11C_INBOX_RECONCILIATION.md` §N1. El adapter provee `receivedAt`; la base asigna `rawPersistedAt`; BE13-02 exige `persistedAt >= receivedAt`. No se eligió tolerancia.
