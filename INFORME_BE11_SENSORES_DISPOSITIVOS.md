# BE-11 — Sensores lógicos y dispositivos físicos

## Resumen ejecutivo

BE-11 incorpora un núcleo aislado y reutilizable para sensores lógicos, identidades técnicas de dispositivos y relaciones temporales. No se agregaron rutas a `src/app.ts`, no se habilitó autenticación productiva y no existe conexión automática a MongoDB, Atlas o EMQX.

El diseño conserva la jerarquía `cliente → campo → área → sensor lógico` y separa expresamente el dispositivo físico. `clientid` MQTT es una clave técnica; nunca representa al cliente empresarial. El cliente se deriva exclusivamente del `AuthorizationContext` emitido por el servicio de autorización.

## IMPLEMENTADO

### Arquitectura

- Contratos y esquemas Zod en `src/sensors/`.
- Servicio de aplicación en `src/services/sensor.service.ts`.
- Repositorio Mongoose en `src/repositories/sensor.repository.ts`.
- Modelos y provisionamiento explícito en `src/models/sensor.models.ts`.
- DTOResponse y mappers explícitos en `src/dto/sensor.dto.ts`.
- Ningún controller o router público: no hay operación HTTP aprobada para montar.

### Catálogo lógico

- `sensorId` es un UUID opaco generado por el servidor, provisional hasta aprobar el mapeo físico definitivo.
- Nombre y descripción admiten actualización parcial con CAS.
- `clientId`, `fieldId`, `areaId`, identidad y fechas no pueden cambiarse mediante PATCH genérico.
- Estados: `active`, `inactive`, `decommissioned`.
- Un sensor descomisionado no se reactiva y conserva identidad e historial.

### Identidad física

- ID interno opaco separado de `TechnicalDeviceKey`.
- Clave compuesta única: `realm + sourceId + key.kind + key.value`.
- `mqtt-clientid` y `device-id` permanecen tipos diferentes.
- Estado de verificación `unverified | verified` obtenido mediante `DeviceIdentityVerifier` confiable.
- Un dispositivo no verificado no puede atribuirse a un sensor.
- La verificación puede refrescarse contra la identidad técnica persistida; no se acepta una identidad alternativa provista por el consumidor.

### Temporalidad y ciclo de vida

- Ventanas semiabiertas `[validFrom, validTo)`.
- Historial separado de asignaciones sensor-área y asociaciones sensor-dispositivo.
- Apertura, cierre, reasignación y descomisionamiento son operaciones explícitas.
- La reasignación cierra una versión y abre otra dentro de una transacción.
- Se impide solapar un dispositivo físico con otra asociación. No se impone un máximo de dispositivos diferentes por sensor porque esa cardinalidad no fue aprobada.
- Un movimiento de área se bloquea mientras el sensor tenga una asociación de dispositivo abierta; primero debe cerrarse o reasignarse explícitamente.

### Integridad con BE-10

El repositorio BE-11 usa la misma fila de coordinación `realm + clientId` en `agro_business_*_controls` que BE-10. La baja de área/campo y las escrituras BE-11 quedan serializadas dentro de transacciones `snapshot` con escritura `majority` y journal.

El inspector real devuelve:

- `blocked`: sensor no descomisionado, asignación abierta o asociación abierta.
- `clear`: no existe dependencia vigente.
- `unknown`: faltan índices, la evidencia es inválida o MongoDB no puede verificarse. BE-10 transforma este estado en bloqueo fail-closed.

### Colecciones candidatas locales

- `agro_sensors_*_logical`
- `agro_sensors_*_physical`
- `agro_sensors_*_area_history`
- `agro_sensors_*_device_history`

Son namespaces candidatos para pruebas locales. No declaran nombres existentes en Atlas. El provisionamiento es explícito, incorpora validadores BSON estrictos e índices, y los modelos tienen `autoCreate`, `autoIndex` y buffering deshabilitados.

## PROBADO

- TypeScript estricto y ESM NodeNext: aprobado.
- Regresión offline: 391/391 pruebas, incluidas las 374 previas, 8 del núcleo BE-11 y 9 regresiones del launcher/guard.
- Equivalencia HTTP: 13/13 escenarios.
- `GET /health` sigue público.
- Las rutas BE-10/BE-11 permanecen ausentes en la composición por defecto.
- No se agregaron dependencias.
- La campaña MongoDB real quedó implementada en `scripts/audit-be11-mongodb-local.ts`, `scripts/be11-worker.ts` y `scripts/be11-local.ps1`.

## DEFECTOS CORREGIDOS EN LA AUDITORÍA

1. Se agregó cierre explícito y versionado de asociación; sin esa operación un dispositivo previamente asociado no podía descomisionarse.
2. La detección de solapamiento ahora considera también intervalos históricos cerrados, no solo la asociación abierta.
3. Una asociación no puede comenzar antes de la asignación sensor-área vigente.
4. El inspector no bloquea por historia cerrada de un sensor ya descomisionado, pero sí por toda dependencia vigente.
5. El refresco de verificación usa la identidad persistida y no una clave alternativa suministrada por el llamador.
6. El fixture MongoDB intentaba abrir M06 antes de la vigencia sensor-área (`clock - 10`) y repetía el defecto en M15 (`clock - 1`). Ambos inicios ahora coinciden con la vigencia creada.
7. El runner ocultaba el error original mostrando solo `Error`; ahora registra etapa y categoría sanitizadas, crea `.local-evidence` y conserva un log por ejecución.
8. El reloj de los dos procesos de M15 se alinea de forma determinista con el comando de carrera.
9. El readiness ya no permite que el `stderr` transitorio de `mongosh` termine Windows PowerShell antes de evaluar el código de salida. Cada intento verifica además que el contenedor propio continúe ejecutándose.
10. Ante un fallo definitivo o deadline, el launcher preserva estado, red, puertos, tmpfs y logs del contenedor antes de retirarlo.
11. La ejecución `03d27dac3746472481c4f941` confirmó una incompatibilidad interna de nombres: el launcher creaba `agro-be11-<runId>` y el guard compartido exigía `agro-db02-<runId>`. El launcher quedó alineado con el contrato estricto del guard, sin relajar propiedad, red, loopback, mounts, tmpfs, imagen ni topología.
12. Los rechazos de `validate-owned-docker` ahora se registran mediante categorías controladas por condición; mensajes arbitrarios, URI y objetos Docker completos continúan excluidos de la evidencia de fallo.
13. La ejecución `96c95b43e997486ea5a74424` expuso que el guard exigía `gateway_mode_ipv4=nat`, pero el launcher dependía del valor predeterminado de Docker. El launcher ahora declara explícitamente las tres opciones verificadas de la red; el guard conserva el rechazo fail-closed y distingue cuál política falta.

## PENDIENTE

- Aprobar nombres físicos y tipos BSON reales de Atlas.
- Aprobar contratos HTTP/OpenAPI antes de crear controllers y routes.
- Aprobar reloj autoritativo operativo; la implementación aislada usa una marca temporal explícita validada contra el reloj de control inyectado.
- Aprobar la cardinalidad máxima de dispositivos diferentes simultáneos por sensor.
- Aprobar autoridad y proceso real de verificación de hardware/EMQX.
- Ejecutar la campaña MongoDB real en Docker Desktop. En esta sesión `docker` no está instalado ni disponible, por lo que no se ejecutaron ni se inventaron resultados.

## BLOQUEADO

- Adapter Atlas definitivo.
- Integración real con EMQX/iot-ingest.
- Exposición HTTP pública.
- Atribución comercial de telemetría sin procedencia autenticada y resolución temporal inequívoca.
- Afirmaciones de tolerancia a fallos: el arnés preparado usa un replica set descartable de un nodo y no prueba failover.

## Riesgos residuales

- La restricción temporal se controla transaccionalmente porque MongoDB no ofrece una restricción nativa general contra intervalos solapados.
- Un único nodo replica set demuestra atomicidad local, no alta disponibilidad.
- El contrato físico de Atlas puede requerir un adapter/migración posterior; no debe reemplazarse este namespace candidato sin relevamiento aprobado.

## Recomendación

El código está listo para revisión local y commit. La integración en `dev` debe exigir ejecución satisfactoria de la campaña MongoDB 8.0.38 y aprobación de que los contratos siguen aislados de la composición pública.
