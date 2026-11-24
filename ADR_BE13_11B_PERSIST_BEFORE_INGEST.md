# ADR BE13-11B — Persistir antes de ingerir (Durable Broker Inbox)

## Estado

Aceptado para la implementación **offline**. Siguen pendientes de decisión humana: la retención del inbox, la clasificación de privacidad del payload crudo, la semántica de revocación, la programación de la recuperación y el responsable de un worker futuro (`MATRIZ_DECISIONES_HUMANAS_BE13.md`).

## Contexto

H1 (BE13-11A): BE13-04 exige el instante técnico en que se persistió el mensaje crudo (`persistedAt`). Un consumer MQTT directo no lo tiene. BE13-11A lo había dejado como un dato **observado opcional** (`rawPersistedAt`), que cualquier adapter podía declarar.

## Decisión

1. **El instante persistido solo existe si el inbox persistió de verdad.** `rawPersistedAt` se eliminó del contexto observado: una entrega que lo trae es `broker-context-malformed`. El camino directo de BE13-11A no tiene instante persistido, así que BE13-04 bloquea toda medición que pase por ahí.
2. **Flujo:** entrega → prevalidación estructural → verificación de procedencia (VERIFIED) → identity mapping → **escritura durable en el inbox** → receipt → procesamiento **desde el registro persistido** → BE13-02…10B.
3. **No se persiste lo no verificado:**
   - un rechazo de seguridad (REJECTED, UNVERIFIED, mismatch) no deja inbox, cuarentena ni medición: protección anti-inundación;
   - un verifier caído tampoco se persiste (conservador). La entrega depende del redelivery del futuro broker.
4. **Escritura durable:**
   - `w: 'majority'`, `j: true`, `wtimeoutMS: 5000`.
   - `inboxId` aleatorio de 128 bits, generado por el store. Nunca viene del dispositivo, del caller ni del packet id.
   - `rawPersistedAt` = `$$NOW` del **servidor** MongoDB en la misma operación que crea el registro.
   - El receipt se emite solo después del ack majority y de una relectura con `readConcern: majority`.
5. **Semántica honesta del instante.** `rawPersistedAt` es la hora del servidor en la operación de escritura, **no** el instante del commit majority. La garantía de durabilidad la da el receipt (ack majority + j), no el valor del timestamp.
6. **Bytes exactos.** Se guardan los bytes recibidos como BinData, sin reserializar. `sha256(bytes originales) == sha256(bytes recuperados)`.
7. **Vínculo con la procedencia.** El registro guarda:
   - `contextFingerprint`: realm, hechos observados y sha de los bytes;
   - `provenanceFingerprint`: identidad verificada, contexto, sha y revisiones.
   
   El store se niega a escribir si los bytes o el contexto no son exactamente los verificados. La recuperación **recomputa** todo y cualquier diferencia produce `broker-inbox-integrity-failed`, sin reparar nada.
8. **Recuperación:** `processPersistedBrokerDelivery({ inboxId })`. El realm sale del bootstrap y la lectura filtra `{ _id, realm }` con `readConcern: majority`. Solo usa los bytes almacenados, los vuelve a parsear con los límites vigentes y vuelve a chequear las rutas y la identidad técnica. `admitForReplay` usa **el mismo** camino.
9. **No se revalida la procedencia contra una autoridad externa** (opción A + integridad). El verifier verificó una conexión viva y no existe un contrato para consultarle sobre una entrega pasada. Qué hacer si la identidad se revoca después es una decisión pendiente; no se inventa una revocación retroactiva.
10. **Duplicados:** dos entregas idénticas generan dos registros y **una** medición. La deduplicación de negocio sigue siendo `realm + sourceId + operation + eventId + field`. No se deduplica por packet id, client id, sha ni topic.
11. **Inmutabilidad por API:** el store solo inserta y lee; no hay update, delete ni TTL. No se afirma WORM.
12. **Sin worker:** no hay cola, polling ni reintentos programados. La recuperación es una llamada explícita.

## Alternativas descartadas

- **Aceptar `rawPersistedAt` del adapter:** cualquiera puede declararlo.
- **Usar como instante el reloj de la aplicación:** no prueba persistencia.
- **Persistir antes de verificar:** el inbox se vuelve almacenamiento gratuito para publicadores no autenticados.
- **Deduplicar en el inbox:** borraría eventos legítimos idénticos.
- **Un MAC sobre el registro:** exige gestión de claves no decidida (BE13-10A: sin criptografía inventada).

## Consecuencias

- Las mediciones del broker solo se aceptan por el camino del inbox.
- Una escritura no confirmada (por ejemplo, sin majority) puede volverse visible más tarde **sin receipt**. Ese registro huérfano no se procesa solo (N4).
- Si el reloj del adapter (`receivedAt`) va adelantado respecto del servidor Mongo (`rawPersistedAt`), la medición se rechaza por `invalid-timestamp` (N1).
