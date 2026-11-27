# ADR BE13-11K — Decision gate: reconciliación end-to-end del publisher

Estado: **`RECOMMENDATION_READY`**. Nada de esto está `DECIDED`: toda decisión requiere aprobación humana (filas 72 y 73 de `MATRIZ_DECISIONES_HUMANAS_BE13.md`). Documental: no se implementó nada, no se levantó Docker, no se tocó EMQX, auth ni Production. `productionReady=false`.

Semántica que se mantiene en todo el documento: **at-least-once + procesamiento idempotente + confirmación end-to-end**. No se afirma exactly-once.

## 1. Evidencia que sustenta las decisiones (leída de los informes, no de memoria)
| Fuente | Qué demuestra |
|---|---|
| 11F | Cola offline de sesión durable sobrevive restart/kill (`PROVEN_LOCAL`); estado inflight/ACK **no** (D04, `PUBACKED_BUT_NOT_RECOVERED` 1–3 por ciclo) ; ventana PUBACK→durable (D27: 50/50 perdidos con buffer de 3 s); F-E2 `BLOCKED_BY_BROKER_CAPABILITY`; 5.8.6 CE sin escritura síncrona |
| 11G | F-F7 refutado/mal clasificado; lectura majority en el pre-check de idempotencia |
| 11H | `D13 → D13b` reproduce la no-entrega 3/3 (1 propio, 59 no, 60 stale) |
| 11I | `SESSION_STATE_LOSS_LOCAL`: tras drenar los 60 stale, 0 de 59 en 80–234 s y 4 reconexiones; no es demora de ventana |
| 11J | La reconciliación del publisher recupera 56 de 59; 57/60 `CONFIRMED`, 3 `UNCONFIRMED_EXPLICIT`, 0 eventos con >1 medición, cross-tenant `not-found`, 6/6 mutantes muertos |
Conclusión técnica: el PUBACK no es evidencia de ingestión ni siquiera con sesiones durables (F-E2 + 11I). Ninguna configuración probada lo arregla.

## 2. Decisión 72 — cómo cerrar la brecha de F-E2
| | A. Confiar solo en el broker | **B. Reconciliación E2E obligatoria del publisher** | C. Cambiar/actualizar broker + mantener reconciliación | D. Store-and-forward durable del publisher |
|---|---|---|---|---|
| garantía | ninguna sobre la entrega al backend | todo evento termina `CONFIRMED`, `QUARANTINED` o `UNCONFIRMED_EXPLICIT`; ninguno se asume | igual que B; reduce la frecuencia de reintentos si el broker mejora | un evento no se descarta del publisher hasta `CONFIRMED`; sobrevive a reinicios/corte del publisher |
| complejidad | nula | media (loop + consulta + política) | alta (migración, re-certificación, posible licencia/clúster) | alta en el dispositivo (almacenamiento, rotación, límites) |
| impacto operativo | alto riesgo silencioso: pérdida no detectable | tráfico de consulta; alertas por `UNCONFIRMED` | cambio de plataforma | espacio/energía del dispositivo |
| dependencia de publisher | ninguna | **sí**: debe implementar el contrato | sí (B sigue siendo necesario) | sí, más fuerte |
| riesgo residual | pérdida silenciosa (demostrada) | un publisher que no reconcilie conserva la brecha; `UNCONFIRMED` requiere proceso humano/operativo | sin evidencia de que cualquier versión elimine la brecha: el PUBACK seguiría ≠ ingestión | capacidad finita del dispositivo |
| costo | 0 | bajo-medio (prototipo ya existe) | alto + investigación abierta | alto |
| compatibilidad con la evidencia | **contradice 11F/11H/11I** | **compatible (11J)** | compatible, pero no sustituye a B | compatible; complementa a B |
| clasificación | **NO RECOMENDADA** | **RECOMENDADA** | OPCIONAL, ticket de evidencia (no bloqueante) | RECOMENDADA como *outbox acotado* dentro de B; el store-and-forward completo solo donde el dispositivo lo permita |

**Recomendación fila 72:** adoptar **B** como contrato obligatorio de publishers, con un **outbox acotado** (parte de D) que retiene cada evento hasta recibir un estado confirmante. C se evalúa como mejora de frecuencia de reintentos, nunca como reemplazo. *Sujeto a aprobación humana.*

## 3. Decisión 73A — canal de confirmación
| Criterio | HTTP (consulta por `eventId`) | Topic MQTT de confirmación |
|---|---|---|
| dependencia de la sesión MQTT | ninguna | total |
| circularidad con F-E2 | **ninguna** (canal distinto del que falla) | **sí**: la confirmación viaja por el mismo mecanismo (sesión durable/QoS 1) cuya entrega no es confiable; una confirmación perdida obliga a reconciliar la confirmación |
| seguridad / tenant | reutiliza la resolución principal → scope; respuesta uniforme | exige ACLs de topic por tenant y emisión por evento; fugas de ACL son cross-tenant |
| observabilidad | request/response medibles, códigos HTTP | push sin traza de recepción |
| retries | pull explícito e idempotente | hay que reintentar publish **y** esperar un push |
| rate limiting | estándar por principal | no aplicable al push; el costo lo asume el broker |
| complejidad del publisher | un `GET` (cliente HTTP) | mantener suscripción + correlación + timeouts |
| operación | un endpoint stateless | topics por tenant, retención/expiración de confirmaciones |
**Recomendación:** HTTP. MQTT queda como *aceleración opcional futura* (hint de "probablemente confirmado"), nunca como fuente de verdad. *Sujeto a aprobación humana.*

## 4. Decisión 73B — política de retry (VALORES PROPUESTOS, no aprobados)
Anclaje en evidencia: en 11J, delays de 2 s a 6 s y 4 intentos en 60 s recuperaron 56/59; 3 quedaron sin confirmar (con intentos sin PUBACK, ver §9).
| Parámetro | **PROPUESTO** | Estado | Motivo |
|---|---|---|---|
| espera inicial antes de la 1ª consulta | 3 s | PROPUESTO | cubre el procesamiento observado (sub-segundo) con margen |
| backoff | ×2 | PROPUESTO | reduce tráfico bajo falla prolongada |
| tope de espera | 60 s | PROPUESTO | acota la latencia de detección |
| jitter | ±25 % (equal jitter) | PROPUESTO | evita tormentas sincronizadas tras un restart del broker |
| intentos máximos (carril rápido) | 8 | PROPUESTO | ≈ 4–5 min acumulados |
| tiempo máximo (carril rápido) | 10 min | PROPUESTO | |
| clasificación al agotar | `UNCONFIRMED` (terminal para el carril rápido): alerta + **carril lento** cada 15 min hasta 24 h o capacidad del outbox | PROPUESTO | no es pérdida declarada ni éxito |
| offline (sin broker o sin endpoint) | el evento permanece en el outbox acotado; no se descarta; al volver la red se reanuda con el **mismo** `eventId`; al llenarse el outbox se aplica la política de descarte que el negocio decida (**decisión humana**) | PROPUESTO | evita perder en silencio |
| `eventId` | inmutable entre intentos | **ya demostrado** (11J, M2) | idempotencia |
**VALORES APROBADOS: ninguno.** El default productivo sigue `BLOCKED`.

## 5. Decisión 73C — indexación del lookup (auditoría del lookup actual)
Hechos del código:
- El Durable Inbox (`broker-inbox.models.ts`) guarda `rawPayload` crudo, `rawPayloadSha256`, `sourceId`, `realm`, `rawPersistedAt` y **no** `eventId`. Su único índice es `{ realm: 1, rawPersistedAt: 1 }`. El validador es cerrado (`additionalProperties: false`).
- Por eso `mongo-ingest-confirmation.evidence.ts` hace `find({ realm, sourceId })` ordenado por `rawPersistedAt`, `limit(5000)`, y parsea el `eventId` de cada `rawPayload`. 5000 es una cota de seguridad, no un diseño.
- Impacto esperado: el índice disponible solo cubre `realm`+tiempo; el filtro por `sourceId` se resuelve recorriendo registros del realm, así que el costo crece con el volumen de **otros** tenants; cada consulta trae hasta 5000 documentos con su payload y los parsea. Un evento más antiguo que la ventana devuelve `not-found` (fail-closed pero con falso negativo). *No se midió latencia: no hubo benchmark.*
- `declared.eventId` ya existe en `mqtt-ingestion-boundary.service.ts` cuando se llama a `persistVerifiedDelivery` (el inbox guarda solo entregas **verificadas**), por lo que persistirlo no exige parsear bytes sin verificar.

**Propuesta (sin migración todavía):**
1. Agregar al registro del inbox `eventId` (string, mismo patrón `^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$`), escrito junto al registro, solo lectura posterior.
2. Índice no único `inbox_realm_source_event: { realm: 1, sourceId: 1, eventId: 1, rawPersistedAt: -1 }`. No único porque las re-entregas son registros válidos (sostienen `duplicate-confirmed`).
3. Evolución del validador (`collMod`) para admitir el campo opcional; **backfill** acotado y reanudable de registros previos desde su `rawPayload`, con el escaneo actual como *fallback* solo para registros sin `eventId` durante la transición.
4. Lookup directo: `find({ realm, sourceId, eventId })` con majority, `limit` pequeño.
Riesgos: cambio de schema de una colección con política "registro inmutable" (el campo se escribe en el insert); migración sobre datos retenidos; no cubre registros que no pasaron por el inbox.

## 6. Reutilización de `eventId` con payload distinto
Hecho: la idempotencia usa `(realm, sourceId, operation, eventId, field)` + `fingerprint`; con otro contenido el store responde `conflict` (se cuarentena). Pero una consulta solo por `eventId` devuelve `processed` por el **primer** contenido: el publisher que reutilizó el id para un contenido nuevo recibiría un falso éxito.
| Opción | Qué hace | Evaluación |
|---|---|---|
| A. Rechazar por fingerprint distinto | el publisher envía un fingerprint en la consulta y el backend compara | requiere que el publisher calcule el fingerprint canónico del contrato técnico (incluye campos derivados del broker): frágil |
| **B. Guardar fingerprint canónico junto al `eventId`** | el inbox ya guarda `rawPayloadSha256`; se indexa junto al `eventId`; el publisher calcula SHA-256 de **los bytes exactos que publica** (idénticos en cada reintento) y lo envía como `payloadSha256` | simple, determinista y verificable por el publisher |
| C. Conflicto explícito | si `eventId` existe con otro hash, estado propio no confirmante (`conflict`) | necesario como *resultado* de B |
**Recomendación: B (con C como resultado visible).** La consulta lleva `payloadSha256`; mismatch ⇒ `conflict` (no confirmante, no revela el contenido ajeno). Sin `payloadSha256` en la consulta, v1 la rechaza (400). *Sujeto a aprobación humana.*

## 7. Cuarentena sin `sourceId`
Hecho: `sourceId` es nullable en la cuarentena; filas generadas antes de resolver identidad (p. ej. etapa `mapper`) no se pueden atribuir a un tenant, y la confirmación las oculta (el publisher ve `not-found` y agota el presupuesto).
Evidencia mínima para reconciliar sin filtrar cross-tenant:
- **Ámbito de reconciliación atado a identidad autenticada en el momento de escribir** (nunca tomado del payload): `reconcileScope = { kind: 'source' | 'principal', id }`, donde `principal` es el `principalReference` verificado por el broker cuando aún no hay `sourceId`.
- `eventId` si es parseable, y siempre `payloadSha256` (el publisher lo conoce), de modo que un payload malformado sin `eventId` también sea reconciliable por hash.
- `reasonCode` de un vocabulario cerrado y `status`; sin contenido del payload.
Contrato: la consulta se resuelve contra el/los ámbitos del principal autenticado (su `sourceId` **y** su `principalReference`); filas de otro ámbito nunca coinciden. Si no existe principal autenticado (conexión rechazada en el broker) no hay a quién informar. No se modifica almacenamiento en esta etapa.

## 8. Requisitos mínimos de autenticación y consulta (sin elegir tecnología)
`PRODUCTION AUTH = PENDING` (ADR 11D). Requisitos:
- **identidad del publisher:** una identidad única por publisher/dispositivo, distinta de la identidad de operadores humanos;
- **relación publisher → tenant:** la misma `principalReference` que autentica el publish determina el `sourceId` de la consulta (`brokerIdentityMapping`); nunca un parámetro de la request;
- **autorización de consulta:** solo lectura, solo del propio ámbito; sin listados ni búsquedas por prefijo;
- **protección contra enumeración:** respuesta uniforme `not-found` para ajeno e inexistente (ya demostrado en 11J), mismos códigos y forma, sin diferencias de timing evidentes;
- **rate limiting:** por principal y global; propuesta inicial (NO aprobada) 10 req/s sostenido, ráfaga 50, respuesta 429 con `Retry-After`; el publisher debe respetarla en su backoff; consulta por lote (`≤100 eventIds`) como mejora opcional para bajar la carga;
- **rotación de credenciales:** dos credenciales válidas en paralelo durante la ventana de rotación, revocación efectiva en minutos, sin pérdida de eventos en el outbox;
- **auditoría:** consulta y denegaciones registradas sin payload.

## 9. Los 3 `UNCONFIRMED_EXPLICIT` de 11J — hipótesis de `clientId` compartido
Lectura del código (sin Docker): `pubOpen = async (user = 'lab-device-a', clientId = user, ...)` y `publish()` abre `pubOpen(o.user ?? 'lab-device-a')`; en 11J cada re-publicación llama `publish([eid], { window: 1 })` desde 20 workers concurrentes. Por tanto **todas las conexiones concurrentes usan el mismo `clientId` MQTT** `lab-device-a`. Según la especificación MQTT, un servidor debe desconectar a la conexión anterior con el mismo `clientId`.
Clasificación: **`HARNESS_COLLISION_RISK_CONFIRMED`** — el compartir `clientId` está demostrado por el código. **No** está demostrado que sea la causa de los 3 sin confirmar (en 11J solo sus 9 reintentos carecieron de PUBACK mientras ~90 re-publicaciones sí lo obtuvieron); ese vínculo causal queda `UNVERIFIED_HYPOTHESIS` hasta una corrida con `clientId` únicos (ticket 11N, no ahora).

## 10. Tabla de decisiones
| Decisión | Opción recomendada | Alternativas | Evidencia | Riesgo si no se decide |
|---|---|---|---|---|
| **Fila 72** F-E2 | **B**: reconciliación E2E obligatoria + outbox acotado | A (no recomendada), C (opcional), D completo | 11F, 11H, 11I, 11J | pérdida silenciosa de eventos PUBACKed |
| Canal (73A) | **HTTP por `eventId`** | topic MQTT | circularidad con F-E2; 11J | confirmación no fiable |
| Retry (73B) | política propuesta §4 (carril rápido + lento) | otras | 11J (56/59 con 4 intentos/60 s) | `BLOCKED`: ningún publisher reconcilia |
| Indexación (73C) | `eventId` en inbox + índice `{realm,sourceId,eventId}` + backfill | seguir escaneando; colección auxiliar | código del lookup | falsos `not-found` y costo creciente por tenant |
| Fingerprint de evento | **B**: `payloadSha256` + `conflict` | A, solo C | claim/`conflict` ya existentes | falso éxito por `eventId` reutilizado |
| Identidad de cuarentena | `reconcileScope` atado a principal + `payloadSha256` | no reconciliar esos casos | cuarentena con `sourceId` nullable | `UNCONFIRMED` inevitable para esos rechazos |
| Auth | identidad publisher=principal del publish; tecnología TBD | — | ADR 11D (`PRODUCTION AUTH = PENDING`) | endpoint sin autorización real |
| Rate limiting | por principal + global, 429/`Retry-After` | sin límite | carga de consulta 11J (20 workers) | enumeración/DoS |

## 11. Recomendación final
Recomiendo **adoptar la reconciliación end-to-end del publisher (opción B)** como contrato obligatorio, consultando por **HTTP**, con **`eventId` indexado e `payloadSha256`** en el inbox, **cuarentena reconciliable por ámbito autenticado**, política de retry de dos carriles y un **outbox acotado** en el publisher, y evaluar una versión distinta de broker solo como ticket opcional de evidencia. Todo **sujeto a aprobación humana**; hasta entonces `productionReady=false` y el default productivo de la política de retry sigue `BLOCKED`.
