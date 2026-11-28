# MATRIZ BE13-11D — Campaña real contra EMQX local

Entorno: EMQX 5.8.6 (contenedor Docker desechable, puertos publicados solo en `127.0.0.1`) + MongoDB 8.0 de 3 nodos del launcher (`-Suite be13-11d`) + MQTT.js 5.16.1 (MQTT 5). Credenciales `labpw-…` generadas por corrida, en memoria, nunca impresas; el log de EMQX se revisó (E36). Script: `scripts/audit-be13-11d-emqx-local.ts`. Sin Atlas, sin broker externo, sin hardware, sin Production. Nada se simuló: un escenario no controlable se marca `NO_VERIFICABLE` (en las corridas finales hubo 0).

## Resultado de las dos corridas finales

| Corrida | PASS | FAIL | NO_VERIFICABLE | Contenedores EMQX residuales | Cleanup Mongo |
|---|---:|---:|---:|---:|---|
| 1 | 34 | 0 | 0 | 0 | confirmado |
| 2 | 34 | 0 | 0 | 0 | confirmado |

(Antes de la corrida final hubo 2 corridas de desarrollo con fallos del propio arnés (E12: `end(true)` descartaba el PUBLISH QoS 0; E18: en Windows `SIGKILL` no informa señal) y una tercera con 31/31. Se corrigió el arnés, no el producto.)

## Escenarios

| ID | Qué se prueba contra el broker real | Resultado |
|---|---|---|
| E01 | Conexión autenticada válida; consumer con nueva `connectionReference` | PASS |
| E02 | Contraseña incorrecta: **rechazada por el broker** (`Bad User Name or Password`); no llega al boundary. Credential stuffing: 7 intentos (contraseñas erróneas, usuario desconocido, usuario vacío), todos rechazados | PASS |
| E03/E26/E27 | Principal autenticado pero **sin mapping** (usa el client id de A): 0 inbox, 0 cuarentena, 0 medición | PASS |
| E04/E10/E29 | A, QoS 1: orden `persist → acked → processed`; bytes idénticos; SHA; `rawPersistedAt` = tiempo del servidor Mongo; sin credenciales en el registro; estado `completed(admission-processed)` | PASS |
| E05 | Spoof de `mqttClientId` (A conecta como B) → `technical-identity-mismatch` | PASS |
| E06 | Topic ajeno denegado por ACL (135); publicar en el topic verificado denegado (135); topic `production` no cambia el realm | PASS |
| E07 / E08 | `sourceId` / `realm` falsos en el payload → rechazados (envelope cerrado) | PASS |
| E09/E28 | Clave técnica incorrecta rechazada; A no puede suplantar a B; B se acepta bajo SU source | PASS |
| E11 | QoS 1 duplicado: 2 registros de inbox, 1 medición | PASS |
| E12 | QoS 0 normal | PASS |
| E13 | Con el inbox realmente inalcanzable: **QoS 0 se pierde para siempre**; QoS 1 se retiene y se reentrega al volver | PASS |
| E14 | Retained bloqueado | PASS |
| E15 / E15b / E16 / E17 | JSON inválido, UTF-8 inválido, claves peligrosas (incluidas anidadas), payload enorme: rechazados antes del inbox | PASS |
| E18 | Consumer **matado antes de persistir**: sin registro ni ACK ⇒ redelivery ⇒ 1 medición | PASS |
| E19 | Consumer matado **tras el receipt, antes del ACK**: redelivery ⇒ 2 registros, 1 medición; el primero queda `receipted` | PASS |
| E20 | Consumer matado **tras el ACK, antes de la medición**: el broker NO reentrega; registro durable `receipted`; 0 mediciones | PASS |
| E21c | Cross-realm: un store de `preview` no lista ni reclama el `receipted` de `test` | PASS |
| E21/E22 | Recuperación por política TEST_ONLY: 1 medición; segunda recuperación `duplicate`; otros `receipted` resueltos como `already-processed` | PASS |
| E23 | Reinicio del consumer: nueva `connectionReference`, entrega correcta | PASS |
| E24 | Reinicio real del broker: consumer nuevo, publishers siguen autenticando, el atacante sigue rechazado | PASS |
| E25 | Failover del primary de Mongo durante la entrega: sin ACK sin receipt majority; 1 medición. En esta corrida la entrega esperó la elección y se ACKeó (`acked-after-election`) | PASS |
| E31 | QoS 2 (cobertura, no requisito): PUBREC diferido | PASS |
| E32 | Evidencia N1 (relojes broker / adapter / Mongo) en el mismo host: 0 ms, 6–7 ms | PASS |
| E33 | Mongo sin majority con la sesión del broker viva: sin ACK, reentrega, un registro huérfano posible | PASS |
| E34 | Reconciliación final: todo resuelto, sin duplicados `(eventId, field)` | PASS |
| E26b/E27b | Eventos del atacante: 0 inbox, 0 mediciones; 0 filas de cuarentena en toda la campaña | PASS |
| E35 | Métricas y audit acotados, sin usernames ni topics ni payload | PASS |
| E36 | Ninguna credencial generada aparece en el log de EMQX ni en los registros | PASS |
| E37 | Credenciales de B con el client id de A y cuerpo de A ⇒ rechazado (el principal sale de la autenticación vigente) | PASS |
| E30 | Cleanup: contenedor EMQX removido, sin procesos hijos | PASS |

## Mutantes sobre la campaña real

| Mutante | Detectado en |
|---|---|
| M3 principal desconocido aceptado | E03/E26/E27 (el atacante con client id de A habría sido aceptado) |
| M7 realm omitido en el claim de `receipted` | E21c |

## Evidencia N1 (sin elegir tolerancia)

Una entrega real: `publish_received_at` del broker = `receivedAt` del adapter (0 ms de diferencia) y `rawPersistedAt` de Mongo 7 ms posterior. Mismo host y mismo reloj del kernel: **no valida el desfase de producción**. La regla `persistedAt < receivedAt ⇒ invalid-timestamp` no cambia.
