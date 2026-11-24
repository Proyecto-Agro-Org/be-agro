# ADR BE13-11A — Frontera de confianza de procedencia (broker → ingesta)

## Estado

Aceptado para la implementación **offline**. El mecanismo de autenticación del broker, la fuente de identidad, las ACL de topics, los límites productivos, la política de retained y el timeout del verifier son **decisiones humanas pendientes** (`MATRIZ_DECISIONES_HUMANAS_BE13.md`).

## Contexto

El pipeline BE13-02…10B recibe documentos protegidos con una capacidad de procedencia. Faltaba definir quién emite esa capacidad cuando la fuente sea un broker MQTT, y cómo evitar que el dispositivo se autoasigne identidad, realm, ownership o autorización.

## Decisión

1. **Nada que controle el dispositivo es autoridad.** El payload, el topic, el MQTT client id, el username declarado, los headers y el `sourceId` o la metadata declarados son datos. Nunca son identidad, realm, ownership, autenticidad ni autorización.
2. **Dos namespaces que no se mezclan:**
   - `brokerObserved` (`BrokerDeliveryContext`): hechos que observó el adapter, como referencias opacas, client id, topic, QoS, retain, packet id e instantes técnicos.
   - `payloadDeclared` (`DeclaredDeviceEnvelope`): claims del dispositivo. El sobre es cerrado: una clave como `realm`, `sourceId`, `trusted` o `verified` hace malformada la entrega.
3. **Autenticación y autorización separadas:**
   - `BrokerProvenanceVerifier` devuelve `VERIFIED`, `UNVERIFIED` o `REJECTED`, ligado a un `contextFingerprint` (sha256 del realm, cada hecho observado y los bytes exactos).
   - `BrokerIdentityMapping` toma el principal autenticado y devuelve el `sourceId` autorizado y la clave técnica que esa conexión puede usar.
4. **El boundary es dueño de la procedencia.** `createMqttIngestionBoundary` compone el bootstrap de operaciones con **su propio** verifier, que solo acepta objetos de evidencia que el boundary emitió tras verificar. Si se intenta inyectar un `provenanceVerifier` de pipeline, falla. No hay camino al pipeline que se salte la verificación.
5. **Realm** solo del bootstrap. **`sourceId`** solo del mapping. **Clave técnica:** la conexión debe usar la clave autorizada para su principal, y todo claim (`clientid`, alias `client_id`) debe coincidir con ella.
6. **`VERIFIED` significa únicamente** que el verifier autorizado confirmó que **esta** entrega provino de una conexión autenticada como ese principal. No significa hardware genuino, sensor físico genuino, datos verdaderos ni ownership final de negocio.
7. **Los rechazos del boundary no crean cuarentenas.** Un publicador no autenticado podría inundar la cuarentena, y sus entregas no tienen una clave de deduplicación confiable. Esos rechazos quedan como resultados cerrados, audit (sin payload), métricas y alertas. Lo que ya pasó la procedencia sigue en cuarentena dentro del pipeline como hasta ahora.
8. **Clasificación cerrada:**
   - Las fallas de procedencia son `security`, no reintentables.
   - Un verifier inalcanzable (excepción o timeout) es `transient`.
   - Una respuesta malformada es `invalid-authority-response` (`security`).
   - Nada en la entrega puede cambiar la clase.
9. **Retained:** bloqueado por defecto (`policy-blocked`). Solo se acepta con una configuración explícita.
10. **QoS y packet id** son solo evidencia. La idempotencia sigue siendo `realm + sourceId + operation + eventId + field`.
11. **`rawPersistedAt`:** BE13-04 exige un instante persistido. Un consumer directo no lo tiene, salvo que el adapter mantenga un inbox durable. Es un hecho observado opcional: si falta, BE13-04 bloquea (`unresolved-persisted-at`).

## Alternativas descartadas

- **Confiar en el topic o en el client id como identidad:** spoofing trivial.
- **Recibir un root ya construido:** permitiría un verifier permisivo inyectado aparte.
- **Poner en cuarentena toda entrega rechazada:** vector de inundación.
- **Un booleano `verified`:** ambiguo y fácil de forjar.
- **Un SDK de EMQX o un cliente MQTT en esta etapa:** no hace falta para el contrato.

## Consecuencias

- Con los placeholders, el boundary no admite ninguna entrega.
- La procedencia no se revalida antes de persistir (TOCTOU): si se revoca un principal entre la verificación y el commit, eso no se detecta. Tampoco es posible lograr atomicidad con el broker.
- El futuro adapter es responsable de producir hechos observados verdaderos. El boundary no puede detectar un adapter comprometido.
