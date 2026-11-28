# CONTRATO BE14-03 — Conformidad de publishers

Define **qué debe cumplir cualquier publisher** (referencia, firmware ESP32, gateway, otro lenguaje) para reportar `CONFORMANCE PASS LOCAL`. Deriva del contrato canónico (`CONTRATO_BE13_RECONCILIACION_E2E.md`, `CONTRATO_PUBLISHER_OUTBOX.md`, definición única de `eventId` de BE14-02) y de lo **medido contra el pipeline real**. No elige plataforma ni lenguaje. **No es certificación de producción.**

## 1. Principio
Black-box: el kit conduce al publisher solo a través de un adapter mínimo y observa comportamiento: bytes publicados, `clientId`, consultas HTTP, estado del outbox. No exige acceso a estructuras internas.

## 2. Interfaz del adapter (conceptual; puente stdio JSON-lines para publishers externos)
`capabilities()` · `boot(config)` · `createEvent(reading)` → `accepted{eventId}` | `rejected{reason}` · `advance(ms)` (deja pasar tiempo) · `inspectPending()` → entradas **retenidas, incluidas las terminales**: `{eventId, payloadSha256, payloadB64, state, lane?, attempts}` · `restart()` · `shutdown()` · opcionales según capacidad: `armCrash(point)`, `setClock(ms)`, `corruptOutbox(kind)`.
Estados lógicos observables: `pending`, `broker-accepted`, `confirmed`, `quarantined`, `conflict`, `unconfirmed` (carril lento), `unconfirmed-explicit`.
Capacidades: `explicit-event-input`, `crash-injection`, `clock-control`, `capacity-config`, `policy-config`, `outbox-corruption`, `canonical-serialization`.
Protocolo del puente: una petición JSON por línea `{"id","op","args"}`, una respuesta `{"id","ok","result"|"error"}`.

## 3. Niveles
| Nivel | Valida |
|---|---|
| **L0 CONTRACT** | vectores (bytes, SHA-256, parser, `eventId`, `deviceTimestamp`, topic); `eventId` canónico y único; forma del payload; hash == SHA-256 de los bytes publicados y == hash consultado; serialización determinista (opcional); `deviceTimestamp` requerido; topic válido; forma de la consulta de reconciliación; entradas inválidas rechazadas |
| **L1 DELIVERY** | publish normal; **PUBACK ≠ éxito**; semántica de confirmación; `clientId` = identidad técnica, estable, una conexión; reconexión |
| **L2 RETRY** | mismo `eventId` y bytes/hash; sin duplicar; confirmación perdida; caída antes/después de PUBACK; `conflict` y `quarantined` terminales; HTTP 429/401/403/5xx |
| **L3 DURABILITY** | restart; matriz de crash C1–C6; outbox corrupto fail-closed y escritura parcial; persistencia de secuencia; independencia del reloj; sin pérdida silenciosa |
| **L4 FAILURE RECOVERY** | MQTT caído; reconciliación no disponible; saturación sin descarte silencioso; carriles de retry y agotamiento explícito; concurrencia |
| **L5 SECURITY BOUNDARY** | respuesta de otro `eventId`; respuesta malformada/estado desconocido; scope (el publisher solo habla como sí mismo; otro tenant ve un evento ajeno igual que uno inexistente) |
Un publisher se reporta como `L0 PASS … L5 PASS`. Vocabulario permitido: **`CONFORMANCE PASS LOCAL`**. Prohibido: *production certified / hardware certified*.

## 4. Reglas de contenido (derivadas del pipeline real)
- **`eventId`:** `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$` (sin `.`, sin normalización).
- **`payloadSha256`:** SHA-256 de los bytes **exactos** publicados; idéntico en cada reintento. No se acepta "equivalente semánticamente".
- **`deviceTimestamp`:** obligatorio y, medido contra el boundary real, el **único valor procesable es un entero ≥ 0** (epoch ms). Strings (incluido ISO), `null`, flotantes y negativos son parseables pero el pipeline los cuarentena (`invalid-authority-response`); booleanos/objetos/≥129 caracteres los rechaza el parser. Un publisher debe rechazar localmente lo no procesable.
- **Payload:** claves `^[a-z][a-z0-9_]{0,63}$`, valores escalares finitos, sin claves de nivel superior desconocidas; debe parsear con el parser real del backend.
- **Topic:** string no vacío ≤ 1024 bytes, sin NUL ni comodines `+ #`. Los topics del contrato de `iot-ingest` son *strings opacos*, **no topics productivos confirmados**.
- **Consulta:** `GET /ingest-confirmations/{eventId}?payloadSha256=<hex64>`; únicamente ese parámetro; solo la identidad del publisher; sin `clientid`/tenant/realm.
- **`clientId` MQTT:** = clave técnica del dispositivo; estable entre reintentos; una conexión activa por identidad; nunca aleatorio ni usado como tenant.
- **Confirmantes:** solo `processed`, `duplicate-confirmed`, `received-durable`. No confirman: `pending`, `not-found`, `quarantined`, `conflict`, timeout, respuesta malformada/de otro evento, estado desconocido.
- **Terminales sin éxito:** `conflict`, `quarantined`, `unconfirmed-explicit`; ninguno se reintenta indefinidamente ni sale del outbox.
- **Saturación:** el kit no exige un número; exige **nunca descartar en silencio** (retenido o rechazado explícito).
- **Carriles:** el kit no exige valores; exige reintento finito, mecanismo lento/equivalente configurable y agotamiento explícito.

## 5. Resultado y política de SKIP
Cada caso produce `{testId, level, status PASS|FAIL|SKIP|NOT_RUN, evidence, durationMs, failureCode}`. `SKIP` solo con `OPTIONAL_CAPABILITY_ABSENT:<cap>` (prueba opcional) o `DECISION_PENDING:<tema>` (capacidad cuya política depende de una decisión humana pendiente). Una capacidad requerida ausente es **FAIL** (`CAPABILITY_REQUIRED`). `NOT_RUN` marca lo que el kit no puede ejecutar (modo externo sin mundo MQTT) y hace el veredicto **INCOMPLETE**; nunca se oculta un fallo.
Códigos de salida: `0` PASS · `1` FAIL de conformidad · `2` configuración inválida · `3` infraestructura no disponible · `4` incompleto.
