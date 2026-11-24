# BE13-02A — Auditoría adversarial de seguridad

## Alcance y método

Se auditó el commit `035ff5de3c7c89fe3da9adb3abc2a1c85c51f035` sobre `feature/be13-02-mapper-iot`, comparándolo directamente con BE-11, BE-12 y los schemas protegidos locales de `iot-ingest`. No se usaron Docker, MongoDB, Atlas, EMQX, Vercel, red ni hardware.

La auditoría intentó falsificar capacidades, cruzarlas entre eventos, manipular prototipos y getters, agotar límites estructurales, alterar tiempos y operaciones, introducir campos empresariales y convertir el candidate en un evento BE-12.

## Resumen ejecutivo

No se encontraron vulnerabilidades críticas o altas ni un camino hacia atribución empresarial. Se demostraron cinco defectos de severidad media y uno bajo. Los defectos permitían aceptar una forma técnica incompatible, ocultar una clave peligrosa, leer de manera inestable un resultado confiable, expresar una confianza demasiado amplia o clasificar ambiguamente una entrada. Todos quedaron corregidos.

El mapper sigue siendo exclusivamente técnico y offline. Un `candidate` no contiene autoridad empresarial y no satisface el schema de `TrustedMeasurementEvent`.

## Hallazgos corregidos

### H01 — Topic protegido incompleto — MEDIO

- Escenario: telemetría con topic nulo, wildcard o más de 1024 bytes podía producir candidate aunque `iot-ingest` la rechaza.
- Impacto: divergencia contractual en la frontera de entrada.
- Corrección: schema de topic equivalente y refinamiento de telemetría no nula.
- Evidencia: `protected-ingest.schemas.ts:6,27,35`; regresión `be13-02-mapper.test.js:208-217`.

### H02 — Clave peligrosa eliminada antes de validarse — MEDIO

- Escenario: una propiedad propia `__proto__` era descartada por Zod y el documento podía continuar como candidate.
- Impacto: el mapper no contaminaba prototipos, pero incumplía el rechazo fail-closed del contrato protegido.
- Corrección: clonar y validar el payload crudo antes del parseo Zod.
- Evidencia: `protected-ingest.mapper.ts:73-79`; regresión `be13-02a-adversarial.test.js:60-64`.

### H03 — Lecturas repetidas de output del verifier — MEDIO

- Escenario: getters variables podían entregar un valor al validar y otro al almacenar la capacidad.
- Impacto: capacidad vinculada a una identidad distinta de la primera validada.
- Corrección: snapshot de cada campo una única vez, validación y almacenamiento de ese snapshot.
- Evidencia: `ingest-provenance.authority.ts:27-39`; regresión `be13-02-mapper.test.js:230-240`.

### H04 — Confianza de payload ambigua — MEDIO

- Escenario: `authorization:'external-capability'` podía interpretarse como atestación del payload completo, aunque la capacidad solo vincula identidad técnica/evento.
- Impacto: un consumidor futuro podía sobreinterpretar datos técnicos alterados.
- Corrección: `technicalIdentityAuthorization`, `payloadIntegrity:'not-attested'` y `brokerIdentityDeclared`.
- Evidencia: `protected-ingest.contracts.ts:47-50`; `protected-ingest.mapper.ts:110-113`.

### H05 — Orden imposible de persistencia — MEDIO

- Escenario: `persistedAt` anterior a `_receivedAt` producía candidate.
- Impacto: timeline técnico incoherente e incompatible con BE-12.
- Corrección: cuarentena `invalid-timestamp`.
- Evidencia: `protected-ingest.mapper.ts:46-49`; regresión `be13-02-mapper.test.js:219-223`.

### H06 — Clasificación de fuente indefinida — BAJO

- Escenario: `sourceId:undefined` terminaba como `invalid-schema` en vez de `missing-source`.
- Impacto: diagnóstico controlado ambiguo, sin bypass de seguridad.
- Corrección: comprobación explícita de tipo y ausencia.
- Evidencia: `protected-ingest.mapper.ts:34`; regresión `be13-02-mapper.test.js:225-228`.

## Frontera de confianza resultante

La authority y sus capacidades se reconocen mediante registros privados `WeakSet/WeakMap`. Una capacidad copiada, serializada, emitida por otra instancia o usada para otra fuente, operación, evento o dispositivo no funciona. El verifier se captura al construir la authority y su resultado se snapshottea.

El límite es de proceso: un módulo con capacidad de ejecutar código arbitrario dentro del backend pertenece al mismo dominio de confianza y puede crear otra authority con un verifier permisivo. Esta API no reemplaza autenticación EMQX ni hardware. La composición productiva debe mantener el verifier fuera de requests y payloads y someterlo a revisión específica.

La capacidad exacta es reutilizable para la misma tupla y no vincula bytes del payload. Esto es deliberado porque digest, ACK y replay pertenecen a `iot-ingest`; la salida declara expresamente `payloadIntegrity:'not-attested'`. Un componente posterior no debe promover el payload a BE-12 sin otra autoridad.

## Inmutabilidad, sanitización y determinismo

La entrada no se modifica. Payloads anidados y arrays se copian y congelan. Las mutaciones posteriores del input no alteran la salida y las mutaciones de la salida fallan. Getters, proxies, claves de contaminación, NaN, Infinity, profundidad y presupuesto excesivos terminan en cuarentena.

La cuarentena contiene solo `status` y `reason`; no expone payload, stack, rutas, tokens ni URIs. El mapper no usa reloj, aleatoriedad, variables, red, MongoDB o filesystem. La misma entrada y capacidad producen el mismo resultado; el orden de propiedades no cambia la semántica.

## Identidad, operaciones y BE-12

No existe salida top-level `clientId`, `fieldId`, `areaId`, `sensorId`, `physicalDeviceId` ni `attributedAt`. Los nombres empresariales que aparezcan dentro del payload permanecen datos raw no autorizados. Topic, `clientid`, `device-id` y payload no seleccionan propietario.

Telemetría produce candidato medible; status, connected y disconnected producen candidatos técnicos no medibles. Operaciones cruzadas o desconocidas quedan en cuarentena. Timestamps declarados se conservan separados y no confiables; no se crea tiempo de atribución.

El candidate no satisface `trustedMeasurementEventSchema`. Magnitud, unidad, valor normalizado, ausencia, procedencia BE-12, metadata permitida y reloj autoritativo continúan bloqueados.

## Validaciones

Resultados finales de la regresión completa:

- `npm.cmd ci --offline`: aprobado; 120 paquetes restaurados desde lockfile y 0 vulnerabilidades informadas.
- Typecheck: aprobado.
- Build: aprobado.
- BE13-02 funcional: 37/37 casos aprobados.
- BE13-02A adversarial: 27/27 casos aprobados.
- Suite completa: 489/489 pruebas aprobadas.
- Regresión HTTP: 13/13 escenarios equivalentes a `d504c8e6c4df9417e35028726fce32f63150f01a`.
- `git diff --check`: aprobado.

## Estado y recomendación

- IMPLEMENTADO: correcciones H01-H06 y marcas explícitas de confianza.
- PROBADO: vectores focalizados, regresión completa y equivalencia HTTP.
- PENDIENTE: verifier productivo, lifecycle de capacidades y límite de bytes en la composición.
- BLOQUEADO: EMQX/hardware reales, catálogo, tiempo autoritativo, Atlas y promoción a `TrustedMeasurementEvent`.
- NO VERIFICABLE: autenticidad productiva, aislamiento de infraestructura y comportamiento real del broker.

La rama queda recomendada para commit local y revisión. No está lista para activar integraciones productivas ni para comenzar atribución BE-12 positiva.
