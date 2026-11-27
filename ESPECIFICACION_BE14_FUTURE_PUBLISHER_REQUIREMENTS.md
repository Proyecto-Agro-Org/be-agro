# ESPECIFICACIÓN — Qué debe implementar el futuro publisher (BE14-05)

Estado: **especificación de integración consolidada. No es firmware ni elige plataforma.** `productionReady=false`. Fuentes canónicas (no se reabren): `CONTRATO_BE13_RECONCILIACION_E2E.md`, `CONTRATO_PUBLISHER_OUTBOX.md`, `INFORME_BE14_02_EVENTID_CONTRACT_ALIGNMENT.md`, `CONTRATO_BE14_03_PUBLISHER_CONFORMANCE.md`, `CONTRATO_BE14_04_EXTERNAL_FAULT_CONTROL.md`, y el código real (`src/iot/event-id.ts`, `src/iot/broker-payload.parser.ts`). Donde el código y un documento difieren, manda el código y se anota.

Semántica del sistema: **at-least-once + procesamiento idempotente + almacenamiento durable + reconciliación end-to-end. No exactly-once.**

## 0. Clasificación (solo estas cuatro, sin ambigüedad)
| Clase | Significado |
|---|---|
| **MUST** | obligatorio para cumplir el contrato; un publisher que lo viole **no** es conforme |
| **SHOULD** | recomendado; su ausencia no rompe la compatibilidad básica |
| **PENDING_PRODUCT_DECISION** | no puede fijarse sin decisión humana (ver §14, ninguna está `DECIDED`) |
| **PLATFORM_SPECIFIC** | depende del hardware/firmware elegido; se evalúa al elegir plataforma |

Columna "Verificación": `KIT:<test>` = test del kit de conformidad (L0–L5); `REF:<archivo>` = test de la referencia BE14-01/02, no del kit; `REVIEW` = revisión manual/checklist (no automatizable como caja negra); `—` = sin verificación posible hasta que exista la decisión/plataforma.

## 1. Matriz única de requisitos
### 1.1 Identidad
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-ID-01 | Cada dispositivo tiene **una identidad técnica** (clave técnica) que cumple el patrón canónico de §2 y es su `clientId` MQTT | MUST | KIT:L1-04 |
| REQ-ID-02 | El dispositivo **nunca** envía tenant/realm/`sourceId`: los deriva el servidor del principal autenticado; el sobre es **cerrado** (clave de primer nivel desconocida ⇒ payload malformado) | MUST | KIT:L0-03, L5-03 |
| REQ-ID-03 | Aprovisionamiento, inventario, rotación y descomisión de la identidad técnica | PENDING_PRODUCT_DECISION | — |
### 1.2 `eventId`
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-EID-01 | `eventId` cumple `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$` | MUST | KIT:L0-02, L0-09 |
| REQ-EID-02 | **Los reintentos conservan el mismo `eventId`** (tras PUBACK, timeout, `not-found`, reconexión, restart) | MUST | KIT:L2-01 |
| REQ-EID-03 | Un `eventId` es único por medición lógica de esa identidad, también entre reinicios | MUST | KIT:L0-02, L3-04, L4-05 |
| REQ-EID-04 | El `eventId` **no depende del reloj** (no es la única fuente de unicidad) | MUST | KIT:L3-05 |
| REQ-EID-05 | Un `eventId` jamás se reutiliza para otro contenido (mismo contenido = idempotente; otro = rechazo explícito) | MUST | KIT:L0-09 (BE14-05) |
| REQ-EID-06 | La secuencia que alimenta el `eventId` se persiste de forma atómica con el outbox (o equivalente) | MUST | KIT:L3-04, L3-02 |
| REQ-EID-07 | Estrategia `<claveTécnica>:<seq>` | SHOULD (REFERENCE STRATEGY, no requisito universal) | REF:be14-01 |
### 1.3 Tiempo
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-TS-01 | `deviceTimestamp` presente y **entero seguro ≥ 0** (medido contra el boundary real: string —incluido ISO—, `null`, flotante y negativo son cuarentenados; booleano/objeto/≥129 caracteres los rechaza el parser) | MUST | KIT:L0-06, L0-03 |
| REQ-TS-02 | Unidad: **epoch en milisegundos** (convención de los vectores y de la referencia, p. ej. `1795115599000`). **El backend no impone la unidad** (solo exige entero ≥ 0) y hoy no usa el valor declarado como autoridad temporal | SHOULD | KIT:L0-01 (vectores) |
| REQ-TS-03 | `deviceTimestamp` y `sentAt` quedan **fijos en los bytes** de todos los reintentos; `sentAt` entero 0…8.64e15 | MUST | KIT:L2-01, L0-03 |
| REQ-TS-04 | Autoridad temporal: reloj declarado vs `received-at`, tolerancia, precisión, **qué hacer con el reloj sin sincronizar** (hoy el backend usa `received-at` y no aprueba `declared-at`) | PENDING_PRODUCT_DECISION | — |
### 1.4 Payload y hash
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-PL-01 | Sobre JSON UTF-8: `version:1`, `eventId`, `sentAt`, `clientid` (opcional; si se envía = identidad), `deviceTimestamp`, `payload`, `mqtt{messageType:"telemetry", dataOrigin, topic?}`; sin claves desconocidas | MUST | KIT:L0-03 |
| REQ-PL-02 | Claves de `payload` `^[a-z][a-z0-9_]{0,63}$`; valores escalares (número finito, string, boolean, null) | MUST | KIT:L0-03, L0-09 |
| REQ-PL-03 | `dataOrigin` ∈ `simulated | physical-unverified | unknown`; el dispositivo no se atribuye verificación (la autoridad la decide el backend) | MUST | KIT:L0-03 |
| REQ-PL-04 | **`payloadSha256` = SHA-256 de los bytes exactos publicados**, idéntico en cada reintento | MUST | KIT:L0-04, L2-01 |
| REQ-PL-05 | **Una sola serialización** alimenta publicación, hash y outbox (prohibido serializar una vez para enviar y otra para hashear) | MUST | KIT:L0-04, L2-01 |
| REQ-PL-06 | Los reintentos son **byte-idénticos** (no basta "semánticamente equivalente") | MUST | KIT:L2-01 |
| REQ-PL-07 | Serialización determinista de la misma lectura | SHOULD | KIT:L0-05 (opcional) |
| REQ-PL-08 | Tamaño/profundidad/claves máximas del payload (el boundary los configura; el kit usa 1 MiB / profundidad 8 / 64 claves / strings 256) | PENDING_PRODUCT_DECISION | — |
### 1.5 MQTT
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-MQ-01 | `clientId` MQTT = identidad técnica (el boundary rechaza `technical-identity-mismatch`); estable entre reintentos; nunca aleatorio, nunca tenant/`sourceId`/`eventId` | MUST | KIT:L1-04 |
| REQ-MQ-02 | **Una conexión activa por identidad** (dos con el mismo `clientId` = colisión de identidad) | MUST | KIT:L1-04, L1-05; observer (BE14-04) |
| REQ-MQ-03 | Telemetría publicada con **QoS 1** | MUST | KIT:L1-01 (BE14-05) |
| REQ-MQ-04 | **`PUBACK` = `BROKER_ACCEPTED`**; no es entrega, no es durabilidad en backend, no es éxito | MUST | KIT:L1-02 |
| REQ-MQ-05 | Tras pérdida de conexión reconecta con el mismo `clientId` | MUST | KIT:L1-05 |
| REQ-MQ-06 | Topic: string no vacío ≤ 1024 bytes, sin NUL ni comodines (`+`, `#`) | MUST | KIT:L0-07 |
| REQ-MQ-07 | **Topic productivo** (hoy solo el *contrato de pruebas* `agro/lab/in/<x>`; los de `iot-ingest` son strings opacos no confirmados) | PENDING_PRODUCT_DECISION | — |
| REQ-MQ-08 | Estrategia de broker de producción, TLS, política de sesión | PENDING_PRODUCT_DECISION | — |
| REQ-MQ-09 | Librería MQTT, versión del protocolo (la referencia usa MQTT 5; el contrato no lo exige), keep-alive, buffers | PLATFORM_SPECIFIC | PLATFORM_TEST |
### 1.6 Outbox
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-OB-01 | **Outbox durable**: el evento se persiste **antes** de publicarse | MUST | KIT:L3-01, L3-02 |
| REQ-OB-02 | Sobrevive a reboot, pérdida de red, publish ambiguo, PUBACK sin confirmación y API caída | MUST | KIT:L3-01, L2-04, L2-05, L4-01, L4-02 |
| REQ-OB-03 | Registro mínimo (§6) | MUST | KIT:L3-06 (vista `inspectPending`) + REVIEW |
| REQ-OB-04 | **Atomicidad**: ningún evento desaparece por un crash entre escritura, publish, PUBACK, confirmación y limpieza | MUST | KIT:L3-02 |
| REQ-OB-05 | Outbox corrupto o ilegible ⇒ **fail-closed** (jamás arranca vacío en silencio); una escritura parcial nunca reemplaza el último estado válido | MUST | KIT:L3-03 |
| REQ-OB-06 | **No descarte silencioso** en ningún camino (el registro terminal también se conserva) | MUST | KIT:L3-06, L4-03 |
| REQ-OB-07 | Saturación: la lectura se **retiene o se rechaza explícitamente**; jamás se descarta ni se sobrescribe en silencio | MUST | KIT:L4-03 |
| REQ-OB-08 | **Qué** hace el firmware al saturar (rechazar, prioridad, backpressure, alarma local) y la **capacidad** | PENDING_PRODUCT_DECISION | — |
| REQ-OB-09 | Retención/limpieza de entradas terminales y confirmadas | PENDING_PRODUCT_DECISION | — |
| REQ-OB-10 | Tecnología de almacenamiento (§8) | PLATFORM_SPECIFIC | PLATFORM_TEST |
### 1.7 Reintentos
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-RT-01 | Reintento **finito** con el mismo `eventId` y los mismos bytes | MUST | KIT:L2-01, L4-04 |
| REQ-RT-02 | Backoff entre intentos; **sin bucle agresivo** | MUST | KIT:L2-09, L4-04 |
| REQ-RT-03 | **Agotamiento explícito**: `UNCONFIRMED_EXPLICIT`, retenido (ni éxito ni pérdida) | MUST | KIT:L4-04 |
| REQ-RT-04 | Modelo de dos carriles (rápido → alerta → lento → agotamiento) | SHOULD | KIT:L4-04 |
| REQ-RT-05 | Jitter para evitar *thundering herd* | SHOULD | REF:be14-01 |
| REQ-RT-06 | **Valores** (intervalos, factor, topes, intentos, ventanas) | PENDING_PRODUCT_DECISION | — |
### 1.8 Reconciliación
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-RC-01 | Éxito **solo** con `processed` \| `duplicate-confirmed` \| `received-durable`, `confirmed=true`, HTTP 200 y `eventId` coincidente | MUST | KIT:L1-03, L5-01 |
| REQ-RC-02 | `pending`, `not-found`, estado desconocido, malformado y toda ausencia de respuesta ⇒ **nunca éxito** ⇒ reintento | MUST | KIT:L1-03, L5-02, L2-03 |
| REQ-RC-03 | Consulta `GET /ingest-confirmations/{eventId}?payloadSha256=<hex64>`, solo ese parámetro, sin tenant/realm | MUST | KIT:L0-08 |
| REQ-RC-04 | HTTP 429 ⇒ respetar `Retry-After`; sin republicar ni consultar antes | MUST | KIT:L2-08 |
| REQ-RC-05 | 401/403 ⇒ jamás éxito, sin bucle agresivo | MUST | KIT:L2-09 |
| REQ-RC-06 | 5xx/timeout/reset ⇒ el evento se conserva y se reintenta | MUST | KIT:L2-10, L4-02 |
| REQ-RC-07 | `conflict` ⇒ **terminal que requiere revisión**; no se genera un `eventId` de reemplazo para ocultarlo | MUST | KIT:L2-06 |
| REQ-RC-08 | `quarantined` ⇒ **terminal sin éxito**; sin retry infinito | MUST | KIT:L2-07 |
| REQ-RC-09 | El dispositivo solo habla como sí mismo; un tercero ve un evento ajeno igual que uno inexistente | MUST | KIT:L5-03 |
| REQ-RC-10 | Canal HTTP definitivo (recomendado, `RECOMMENDATION_READY`) | PENDING_PRODUCT_DECISION | — |
| REQ-RC-11 | Cliente HTTP/TLS/timeouts de la plataforma | PLATFORM_SPECIFIC | PLATFORM_TEST |
### 1.9 Seguridad y autenticación (todo hoy `BLOCKED_BY_POLICY`)
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-SEC-01 | Ningún secreto en código fuente, logs, payloads ni outbox | MUST | REVIEW |
| REQ-SEC-02 | Tecnología de **auth MQTT** y **auth HTTP** (§10) | PENDING_PRODUCT_DECISION | — |
| REQ-SEC-03 | Almacenamiento, rotación y revocación de credenciales | PENDING_PRODUCT_DECISION | — |
| REQ-SEC-04 | **Si** se aprueba auth con secretos: almacenamiento seguro de credenciales (§12) | PLATFORM_SPECIFIC | PLATFORM_TEST |
| REQ-SEC-05 | Valores de rate limit | PENDING_PRODUCT_DECISION | — |
### 1.10 Reinicio, energía, desconexión
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-RS-01 | Tras reiniciar, el outbox se reconstruye idéntico (mismo `eventId`, bytes y hash) y continúa hasta la confirmación | MUST | KIT:L3-01 |
| REQ-RS-02 | **Corte de energía** en los puntos críticos (antes de persistir, tras persistir, tras publish, tras PUBACK, tras la respuesta, antes de borrar) **no produce éxito silencioso ni pérdida** | MUST | KIT:L3-02 |
| REQ-RS-03 | Watchdog / recuperación automática | SHOULD | PLATFORM_TEST |
| REQ-OF-01 | Sin red: medición → outbox → retener → publicar después | MUST | KIT:L4-01 |
| REQ-OF-02 | MQTT caído: no se pierde | MUST | KIT:L4-01 |
| REQ-OF-03 | Reconciliación caída: no se pierde | MUST | KIT:L4-02 |
| REQ-OF-04 | Backend caído/sin respuesta: **no se asume éxito** | MUST | KIT:L1-02, L2-10 |
### 1.11 Observabilidad y logs (lado dispositivo)
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-OBS-01 | **MUST diagnóstico**: profundidad del outbox y conteo por estado (pendiente, aceptado por broker, confirmado, `conflict`, `quarantined`, `unconfirmed`) e intentos por evento, consultables localmente | MUST | KIT:L3-06 (vista `inspectPending`) |
| REQ-OBS-02 | Logs con `eventId`, transición, clase de error e intento; **sin payload ni secretos** | MUST | REVIEW (la referencia lo prueba en REF:be14-01) |
| REQ-OBS-03 | Antigüedad del pendiente más viejo, último error MQTT, último error de reconciliación | SHOULD | REF:be14-01 |
| REQ-OBS-04 | Telemetría de contadores hacia el backend/operador | SHOULD | — |
### 1.12 Otros
| ID | Requisito | Clase | Verificación |
|---|---|---|---|
| REQ-OTA-01 | ¿La plataforma debe soportar actualización remota (OTA)? | PENDING_PRODUCT_DECISION | — |
| REQ-OWN-01 | Ownership humano de `UNCONFIRMED_EXPLICIT` (quién investiga, en qué plazo) | PENDING_PRODUCT_DECISION | — |
| REQ-HW-01 | Plataforma/hardware, conectividad, energía, almacenamiento, vida útil | PLATFORM_SPECIFIC | — |

Conteo: ver `MATRIZ_BE14_REQUIREMENT_TO_CONFORMANCE.md` (trazabilidad completa y brechas).

## 2. `eventId` — qué debe saber el firmware
- Patrón exacto `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`: **1–128 caracteres**; primer carácter letra/dígito; luego letras, dígitos, `:`, `_`, `-`. **Sin `.`**, sin espacios, sin Unicode.
- **Sensible a mayúsculas**; **sin normalización** de ningún tipo (el backend compara el string exacto).
- Un id fuera del patrón se rechaza localmente: si se publicara, el parser lo trata como payload malformado (sin rastro) y la API responde `400 invalid-event-id`.
- No usar el reloj como única fuente de unicidad. Un retry **conserva** el id.

## 3. Generación del `eventId` y persistencia de la secuencia
La referencia usa `<claveTécnica>:<seq>` (**REFERENCE STRATEGY**: no es requisito universal). Propiedades obligatorias de **cualquier** estrategia:
1. **Estabilidad**: fijado en la creación, nunca regenerado.
2. **Unicidad suficiente** para esa identidad durante toda la vida del dispositivo.
3. **Persistencia**: el estado que garantiza la unicidad sobrevive a reboot y a corte de energía.
4. **Recuperación tras reboot**: tras reiniciar no se puede reemitir un id ya usado.
Opciones conceptuales (sin elegir almacenamiento): contador persistido junto al outbox (como la referencia); secuencia monotónica persistente independiente; combinación de identidad + contador de arranque + secuencia en RAM (exige que el contador de arranque sea persistente). Crítico: si se pierde el contador, el siguiente id puede colisionar con uno viejo ⇒ `conflict` en el backend (correcto, pero evitable).

## 4. Bytes, hash y determinismo
1. Se serializa **una vez**. Esos bytes: (a) se guardan en el outbox, (b) se publican, (c) se hashean con SHA-256 → `payloadSha256`, (d) se republican idénticos.
2. La consulta de reconciliación envía ese hash exacto.
3. **El backend exige bytes idénticos en los reintentos** (evidencia: `conflict` = mismo `eventId` con otro `payloadSha256`; no existe "semánticamente igual"). Cambiar un espacio en blanco, el orden de claves o `sentAt` cambia el hash ⇒ `conflict`.
4. Por eso el outbox guarda los **bytes**, no la lectura: re-serializar al reintentar es un defecto.

## 5. `deviceTimestamp` — contrato real
- **Verificado en el código y en el kit**: el único valor procesable es un **entero seguro ≥ 0**. El esquema del parser acepta string/number/null (por eso parsea), pero el pipeline cuarentena todo lo que no sea entero ≥ 0.
- **Unidad**: la convención de los vectores y de la referencia es **epoch en ms**. **No está impuesta por el backend** (acepta cualquier entero ≥ 0, incluido `0`) y el valor declarado **no** es autoridad temporal hoy. Por eso la unidad se fija como SHOULD y la autoridad como `PENDING_PRODUCT_DECISION` (REQ-TS-02/04).
- Riesgo: un firmware sin reloj válido podría enviar `0` y el pipeline lo aceptaría. Qué hacer con un reloj sin sincronizar **no está definido**: no se inventa (decisión §14).

## 6. Registro mínimo del outbox
`eventId` · bytes exactos (`payloadB64` o equivalente) · `payloadSha256` · `createdAt`/secuencia · `publishAttempts` · `reconciliationAttempts` · `lastPublishAt` / `lastReconciliationAt` · `nextAttemptAt` · `state` · `lane`/estado de política · `unconfirmedSince` · resultado de la última reconciliación. Estados: `PENDING_PUBLISH` → `BROKER_ACCEPTED` → `WAITING_CONFIRMATION` → `CONFIRMED` | `QUARANTINED` | `CONFLICT_REQUIRES_REVIEW` | `RETRY_REQUIRED` → … | `UNCONFIRMED_EXPLICIT`. **No existe arista a `CONFIRMED` desde `PENDING_PUBLISH`/`BROKER_ACCEPTED`.**

## 7. Atomicidad (propiedad, no tecnología)
Para cada instante entre **escribir → publicar → PUBACK → consultar → confirmar → limpiar**, un corte de energía o un crash deja el evento **recuperable** (nunca perdido, nunca "confirmado" sin evidencia). La forma segura es: persistir antes de publicar; el único camino a `CONFIRMED` es la evidencia del backend; borrar solo después. El kit lo prueba inyectando 6 puntos de crash (C1–C6) y corrupción de archivo.

## 8. `PLATFORM_SPECIFIC` — a evaluar al elegir hardware (no se resuelven sin plataforma)
Resistencia de la flash (ciclos de escritura) · amplificación de escritura del outbox · **atomicidad** de escritura (¿existe commit atómico?) · comportamiento ante corte de energía · almacenamiento disponible · sistema de archivos · almacén clave-valor (NVS/KV) · wear-leveling · tamaño de RAM para buffers de payload · librería MQTT/HTTP/TLS · criptografía (SHA-256 por hardware/software) · watchdog · herramientas de desarrollo y factibilidad del puente de conformidad.

## 9. Reintentos: semántica vs valores
**Semántica obligatoria** (MUST): finito · mismo `eventId` · mismos bytes · backoff · sin bucle agresivo · agotamiento explícito.
**Valores** (intervalos, factor, topes, número de intentos, ventanas de los carriles): `PENDING_PRODUCT_DECISION`. Los valores `3 s ×2, tope 60 s, ±25 %, 8 intentos, 10 min; lento 15 min hasta 24 h` de BE13-11K son **PROPOSED, no aprobados**.
**Modelo de dos carriles** (SHOULD): rápido (reintento con backoff) → alerta `UNCONFIRMED` → lento (intervalo largo, mismo evento) → `UNCONFIRMED_EXPLICIT` retenido. No se fijan tiempos.

## 10. Autenticación — requisitos funcionales y opciones (sin elegir)
Requisitos funcionales (todas las opciones deben cubrirlos): identidad de dispositivo · almacenamiento de credencial · rotación · revocación · **vínculo con el tenant derivado por el servidor** · auth de la reconciliación · auth de MQTT.
| Opción | Soporte de hardware | Aprovisionamiento | Rotación | Revocación | Seguridad | Complejidad |
|---|---|---|---|---|---|---|
| usuario/contraseña por dispositivo | trivial | simple (por dispositivo) | manual/OTA | inmediata en el broker | media (secreto compartido) | baja |
| API key | trivial | simple | manual/OTA | inmediata en el servidor | media | baja |
| JWT / token | requiere reloj para `exp` | requiere emisor | por expiración (renovación) | por lista/expiración corta | media-alta | media |
| certificado de cliente (mTLS) | requiere TLS + almacenamiento de clave | PKI/CA, costoso | por reemisión | CRL/OCSP o desactivar en el broker | alta | alta |
| solicitud firmada | requiere crypto + clave | clave por dispositivo | por reemisión | por clave | alta | media-alta |
| otro mecanismo aprobado | a evaluar | a evaluar | a evaluar | a evaluar | a evaluar | a evaluar |
**No se elige automáticamente.** Una restricción aplica a todas: el reloj no sincronizado afecta a JWT/firmas.

## 11. Reconciliación: transporte y errores
HTTP es lo recomendado (`RECOMMENDATION_READY`, no `DECIDED`). Requisitos: endpoint `GET /ingest-confirmations/{eventId}?payloadSha256=`; auth (pendiente); `eventId` y `payloadSha256` exactos; timeout acotado por el cliente; 429 con `Retry-After`; clasificación de errores (404 = ruta ausente, **no** `not-found`); respuestas con `eventId` distinto o malformadas ⇒ no confirman. Valores de rate limit: pendientes; el firmware debe soportar 429, respetar `Retry-After` y evitar sincronía masiva (jitter).

## 12. Almacenamiento seguro (si se aprueba auth con secretos)
Se vuelve requisito de plataforma (REQ-SEC-04): el secreto no se guarda en claro en el outbox ni en logs; acceso restringido; borrado ante revocación/descomisión. No se implementa en BE14.

## 13. Conflict / quarantine / UNCONFIRMED — qué conserva y expone el dispositivo
- **`conflict`**: terminal, "requiere revisión"; conserva `eventId`, hash propio, intentos; **no** publica un id nuevo para ocultarlo; se expone al operador.
- **`quarantined`**: terminal sin éxito; sin retry infinito; se expone (el detalle vive en el backend).
- **`UNCONFIRMED_EXPLICIT`**: retenido con `eventId`, bytes, hash, `unconfirmedSince`, intentos de publicación/consulta, último error MQTT y de reconciliación, para diagnóstico posterior. **Ownership humano pendiente.**

## 14. Decisiones humanas (ninguna `DECIDED`)
| # | Decisión | Estado | Prioridad |
|---|---|---|---|
| D1 | plataforma / hardware | PENDING | BLOCKS FIRMWARE START |
| D2 | auth MQTT | PENDING | BLOCKS PRODUCTION ONLY (el esqueleto puede empezar con un puerto de credenciales) |
| D3 | auth HTTP (reconciliación) | PENDING | BLOCKS PRODUCTION ONLY |
| D4 | HTTP como canal definitivo | RECOMMENDATION_READY | CAN WAIT (el cliente se escribe contra el contrato) |
| D5 | retry rápido (valores) | PENDING | BLOCKS PRODUCTION ONLY (parametrizable) |
| D6 | retry lento (valores) | PENDING | BLOCKS PRODUCTION ONLY |
| D7 | capacidad del outbox | PENDING | BLOCKS FIRMWARE START **solo para dimensionar** el almacenamiento (§18); depende de D1 |
| D8 | comportamiento de saturación | PENDING | BLOCKS PRODUCTION ONLY (regla "no silent drop" ya fija) |
| D9 | owner de `UNCONFIRMED` | PENDING | BLOCKS PRODUCTION ONLY |
| D10 | tecnología de almacenamiento local | PENDING (derivada de D1) | BLOCKS FIRMWARE START |
| D11 | almacenamiento de credenciales | PENDING (depende de D2/D3) | BLOCKS PRODUCTION ONLY |
| D12 | OTA | PENDING | CAN WAIT (pero condiciona D1/D10) |
| D13 | rate limits | PENDING | BLOCKS PRODUCTION ONLY |
| D14 | estrategia de broker productivo (+ topic productivo) | PENDING | BLOCKS PRODUCTION ONLY |
| D15 | autoridad temporal / reloj sin sincronizar | PENDING | BLOCKS PRODUCTION ONLY |
| D16 | topic productivo y límites de payload | PENDING | CAN WAIT |
| D17 | estrategia del test L2-04 contra un broker real (ver MATRIZ §Brechas) | PENDING | BLOCKS el veredicto `PASS EXTERNAL` (no el inicio) |
**Qué bloquea realmente empezar**: solo D1 (y por derivación D10). La máquina de estados, el generador de `eventId`, el serializador, el cliente de reconciliación, la política parametrizable y la observabilidad pueden implementarse **sin** conocer rate limits, valores de retry, auth definitiva ni OTA (se inyectan como puertos/parámetros, como hace la referencia con defaults `BLOCKED`).

## 15. Reloj
`eventId` **no** depende del reloj. `deviceTimestamp` sí requiere una fuente temporal. Si el reloj no está sincronizado el backend no define comportamiento: no se inventa; queda como D15. Regla provisional segura: no derivar identidad del reloj, y no ocultar que el reloj es inválido (no enviar `0` silenciosamente sin decisión).

## 16. Capacidad (inputs, sin valores productivos)
- Almacenamiento mínimo del outbox: `eventsPerDay × offlineDays × (avgPayloadBytes + metadataOverhead) × safetyFactor`. Número de registros: `eventsPerDay × offlineDays × safetyFactor`. (`scripts/be14-05/capacity.ts`.)
- Red por evento: `bytesPorEvento = publishOverhead + payloadBytes`; con reintentos `× (1 + retryFactor)`; más la consulta de reconciliación `reconciliationOverhead × (1 + retryFactor)`. Tasa: `eventRate × bytesPorEvento`. No hay benchmark productivo.
- Energía: solo checklist (radio activo por intento, reintentos, escrituras a flash); no se estima sin hardware.

## 17. Criterios de entrada de hardware (necesarios **antes** de elegir plataforma)
Interfaces de sensores · frecuencia de muestreo · eventos/día · tamaño de payload · conectividad (Wi-Fi/LTE/LoRa/…) · fuente de energía · **duración máxima offline** · almacenamiento necesario · vida útil esperada · restricciones ambientales · requisito OTA · requisito de seguridad · costo. Se completan en `PLANTILLA_BE14_PUBLISHER_PLATFORM_INPUT.md`.

## 18. Puente de conformidad que debe implementar el firmware (Mode B)
Contrato existente, **sin cambios**: puente stdio JSON-lines (`{"id","op","args"}` → `{"id","ok","result"|"error"}`), ops `capabilities`, `boot`, `createEvent`, `advance`, `inspectPending`, `restart`, `shutdown` y, según capacidad, `armCrash`, `setClock`, `corruptOutbox`, más `identity` opcional (`testDouble:true` si es un doble). Capacidades para optar a **todos** los tests requeridos: `explicit-event-input`, `crash-injection`, `clock-control`, `capacity-config`, `policy-config`, `outbox-corruption` (y `canonical-serialization` opcional). Sin `capacity-config` y `policy-config`, L4-03 y L4-04 quedan `SKIP` y el veredicto no puede ser `PASS EXTERNAL` (BE14-05: son hooks de prueba, no valores productivos).

## 19. Aceptación vs readiness de producción
- **`CONFORMANCE PASS LOCAL`** (Mode A) / **`CONFORMANCE PASS EXTERNAL`** (Mode B, publisher real declarado): todos los tests requeridos aplicables en PASS, sin FAIL.
- **No** implica `productionReady`. Un firmware puede pasar L0–L5 y seguir con `productionReady=false` mientras haya decisiones pendientes (auth, valores, topic, broker, ownership), pruebas de campo, seguridad, OTA y operación sin resolver. Vocabulario prohibido: *production certified / hardware certified*.
