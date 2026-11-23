# BE-11 — Validación final

## Resultado

BE-11 superó la validación local offline, HTTP y MongoDB real necesaria para su integración controlada en `dev`. La validación corresponde al código en `8bbd890b28ab5dee5b35cf88e24dee05836f98f7`, previo a este informe documental.

La evidencia real se mantiene fuera de Git mediante `.gitignore`. No contiene credenciales, datos productivos ni conexiones a Atlas. El archivo `be11-mongodb.json` no incorpora el SHA como campo: la trazabilidad disponible combina el HEAD y árbol limpios informados, el commit a las 15:44:33 -03:00, la evidencia a las 15:47:49 -03:00 y la ausencia de commits posteriores durante la ejecución.

## MongoDB real

- MongoDB: 8.0.38.
- Topología: replica set local descartable de un nodo.
- RunId: `3369faf5f1f94f7ca1b2be55`.
- Casos: exactamente M01–M15, sin duplicados.
- Resultado: 15 aprobados, 0 fallidos, 0 omitidos.
- M08: CAS con un único ganador.
- M09: cierre y apertura de reasignación dentro de una transacción.
- M10 y M12: historial y registros preservados.
- M13 y M14: dependencias BE-10 verificadas y ausencia de evidencia tratada de forma fail-closed.
- M15: dos procesos del sistema operativo compitieron y produjeron un único ganador.
- Recursos descartables: limpieza confirmada por el launcher.

## Índices inspeccionados

Se observaron los índices `_id_` de MongoDB y los índices previstos: `sensor_id_unique`, `sensor_scope_page`, `device_id_unique`, `device_technical_identity_unique`, `assignment_id_unique`, `assignment_timeline_unique`, `assignment_dependencies`, `device_timeline_unique`, `sensor_association_history`, `association_dependencies`, `association_id_unique` y `business_control_unique`.

Los namespaces usados fueron exclusivamente locales y descartables: sensores lógicos, dispositivos físicos, historial de áreas, historial de dispositivos y controles de negocio de BE-11.

## Regresión

- TypeScript estricto: aprobado.
- Build: aprobado.
- Suite offline: 391/391.
- Equivalencia HTTP: 13/13.
- `GET /health`: público y sin dependencia de MongoDB.
- Rutas BE-10 y BE-11: no montadas en la aplicación pública.
- Conexiones automáticas a Atlas: ausentes.

## Alcance y limitaciones

La campaña demuestra comportamiento funcional, atomicidad local y concurrencia multiproceso contra MongoDB real. No valida:

- nombres, tipos BSON ni mapeo físico definitivo de Atlas;
- failover, alta disponibilidad o tolerancia a fallos distribuida;
- dispositivos, hardware o verificación real de identidad;
- EMQX, MQTT o `iot-ingest` real;
- reloj autoritativo de telemetría;
- cardinalidad máxima no aprobada;
- contratos HTTP productivos, porque las rutas permanecen deshabilitadas;
- Preview o Production.

## Decisiones pendientes

Antes de activar BE-11 se requieren acuerdos sobre mapeo Atlas, autoridad de hardware/EMQX, cardinalidad, reloj de telemetría y contratos HTTP/OpenAPI. Integrar en `dev` no constituye aprobación ni activación de esas decisiones.

## Recomendación

La implementación puede integrarse en `dev` conservando las rutas públicas deshabilitadas y todas las integraciones reales bloqueadas. BE-12 solo debe comenzar como tarea separada después de confirmar la integración y su alcance aprobado.
