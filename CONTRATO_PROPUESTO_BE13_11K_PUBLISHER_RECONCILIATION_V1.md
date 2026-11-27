# CONTRATO PROPUESTO — `PublisherReconciliationContract` v1

Estado: **`PROPUESTO` / `RECOMMENDATION_READY`**. No aprobado, no implementado como producto, no habilitado en Production. Basado en el prototipo `TEST_ONLY` de BE13-11J (`CONTRATO_BE13_11J_INGEST_CONFIRMATION.md`) y en las decisiones recomendadas en `ADR_BE13_11K_RECONCILIATION_DECISION.md`. Las partes marcadas **[NUEVO vs 11J]** no existen todavía.

Semántica: **at-least-once + procesamiento idempotente + confirmación end-to-end.** El contrato no promete exactly-once.

## 1. Roles
- **Publisher:** dispositivo/gateway con una identidad única. Conserva cada evento en un outbox acotado hasta recibir un estado confirmante.
- **Backend:** recibe vía broker, persiste en el Durable Inbox, procesa con idempotencia y responde consultas de confirmación.
- **Broker:** transporte. Sus garantías no forman parte del contrato.

## 2. Publish y significado de PUBACK
1. El publisher fija `eventId` (único por `(realm, sourceId)`, estable entre reintentos, independiente del `clientId` MQTT) y construye los bytes del mensaje **una sola vez**.
2. Calcula `payloadSha256` = SHA-256 de esos bytes exactos **[NUEVO]** y conserva ambos en el outbox.
3. Publica QoS 1. El PUBACK significa **solo** `BROKER_ACCEPTED`. **No** significa ingestión, persistencia del backend ni procesamiento. Un publisher que trate el PUBACK como final **incumple** el contrato.

## 3. Consulta de confirmación
`GET /ingest-confirmations/{eventId}?payloadSha256={hex64}` **[NUEVO: `payloadSha256` obligatorio; sin él → 400]**
- El ámbito (`realm`, `sourceId`, y para cuarentena también `principalReference`) lo deriva el **servidor** de la identidad autenticada; ninguna parte de la request lo amplía.
- Solo lectura, sin efectos secundarios. `Cache-Control: no-store`.
- Respuesta 200: `{ eventId, status, confirmed, evidenceVersion, deliveries, durableAt }`.
- Otros códigos: 400 entrada inválida, 401 sin autenticar, 403 sin ámbito, 429 límite de tasa (`Retry-After`), 503 backend no disponible. **Ningún código distinto de 200 confirma.**

## 4. Estados
| Estado | `confirmed` | Significado | Acción del publisher |
|---|---|---|---|
| `processed` | sí | claim durable (majority) para `(realm, sourceId, eventId)` con ese `payloadSha256` | cerrar el evento |
| `duplicate-confirmed` | sí | procesado y admitido ≥ 2 veces; resuelto idempotentemente | cerrar el evento |
| `received-durable` | sí | registro durable en el inbox, aún sin claim; el backend lo procesa | cerrar el evento |
| `quarantined` | **no** | el backend lo retuvo de forma controlada | no reintentar sin cambio; escalar a operación |
| `conflict` **[NUEVO]** | **no** | el `eventId` existe con **otro** `payloadSha256` | no reintentar; es un error del publisher (reutilizó el id); alerta |
| `pending` | no | el backend no puede demostrar el estado (fuente no disponible) | reintentar según política |
| `not-found` | no | todas las fuentes respondieron y no lo tienen (también para ajenos) | reintentar (re-publicar) según política |
Cualquier estado o código desconocido **no** confirma (fail-closed).

## 5. Retry y UNCONFIRMED
- Reintento = **re-publicar el mismo mensaje** (mismo `eventId`, mismos bytes) y volver a consultar. Nunca un `eventId` nuevo para el mismo evento.
- Política acotada (valores *propuestos* en el ADR §4; ninguno aprobado; default productivo `BLOCKED`): espera inicial, backoff, jitter, intentos máximos, tiempo máximo.
- Al agotar el carril rápido el resultado es **`UNCONFIRMED`**: ni éxito ni "pérdida" declarada. El evento sigue en el outbox, se alerta y pasa a un carril lento acotado. Salir de `UNCONFIRMED` solo ocurre con un estado confirmante o con una decisión explícita de descarte (humana/operativa).
- Sin conectividad: el evento permanece en el outbox; el contrato no autoriza a descartarlo en silencio.
- Respetar 429/`Retry-After` dentro del backoff.

## 6. Duplicados e idempotencia
- El backend deduplica por `(realm, sourceId, operation, eventId, field)`; **una medición lógica por clave**, sin importar cuántas veces se entregue o se republique.
- Re-entregas (stale replay incluido) se resuelven de forma idempotente y siguen siendo confirmables (`duplicate-confirmed`).
- La confirmación nunca crea ni modifica mediciones.

## 7. Reutilización de `eventId`
Un `eventId` identifica **un** contenido. Si la consulta trae un `payloadSha256` distinto del registrado ⇒ `conflict` (sin revelar el contenido registrado). El publisher no debe reutilizar un `eventId` para otro contenido.

## 8. Cuarentena
- Una entrada cuarentenada es un estado controlado, **no** un éxito.
- Para que sea reconciliable, la cuarentena debe registrar un ámbito atado a la identidad autenticada al momento de escribir (`source` o `principal`, nunca derivado del payload), el `eventId` si es parseable y `payloadSha256` **[NUEVO: almacenamiento aún no modificado]**. La consulta coincide solo con los ámbitos del principal autenticado.

## 9. Aislamiento de tenant
- Ámbito derivado del principal autenticado (`principalReference` → `sourceId`), mismo mapeo que usa el publish.
- Un `eventId` ajeno es indistinguible de uno inexistente (misma forma, código y estado `not-found`).
- Sin listados, sin búsqueda por prefijo, sin parámetros de ámbito en la request.

## 10. Seguridad operativa (requisitos, sin elegir tecnología)
Identidad única por publisher y distinta de operadores; autenticación real (hoy `PRODUCTION AUTH = PENDING`); rate limiting por principal y global; rotación con credenciales solapadas; auditoría de consultas/denegaciones sin payload.

## 11. Cambios respecto al prototipo 11J
| Prototipo 11J | Contrato v1 propuesto |
|---|---|
| consulta solo por `eventId` | + `payloadSha256` obligatorio y estado `conflict` |
| inbox sin `eventId`, escaneo de hasta 5000 filas | `eventId` indexado en el inbox |
| cuarentena con `sourceId` nullable invisible | ámbito `source`/`principal` + hash |
| `authenticate` inyectado, sin rate limiting | identidad real + límites de tasa |
| política de retry `TEST_ONLY` | política aprobada de dos carriles + outbox |

## 12. Fuera de alcance
Exactly-once, cambio de broker, elección de tecnología de autenticación, aprobación de valores de política, habilitación en Production.
