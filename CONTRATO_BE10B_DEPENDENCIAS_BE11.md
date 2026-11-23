# BE-10B — Contrato de dependencias para BE-11

Este documento prepara BE-11; no implementa modelos, endpoints, migraciones ni acceso a Atlas.
Todo componente nuevo deberá permanecer en composición aislada hasta aprobar persistencia y sesión.

## 1. Modelo conceptual obligatorio

```text
Cliente → Campo → Área → Sensor lógico → Asociación temporal → Dispositivo físico → Mediciones
```

| Concepto | Identificador | Regla |
|---|---|---|
| Cliente empresarial | `clientId` / `cliente_id` | Surge de sesión y catálogo confiable; nunca de MQTT ni del request público. |
| Campo | `fieldId` / `campo_id` | Pertenece de forma inmutable a un cliente durante esta etapa. |
| Área | `areaId` / `area_id` | Pertenece de forma inmutable a un campo y, por derivación, al mismo cliente. |
| Sensor lógico | `sensorId` | Recurso de dominio estable mostrado por la API; no equivale necesariamente a hardware. |
| Dispositivo físico | clave tipada + ID persistido | Identidad técnica observada en ingesta; `mqtt-clientid` y `device-id` no son intercambiables. |
| `clientid` MQTT | `TechnicalDeviceKey{kind:'mqtt-clientid'}` | Identifica al cliente MQTT/dispositivo técnico; jamás al cliente empresarial. |
| Asociación | `associationId`, `revision`, `[validFrom,validTo)` | Vincula sensor y dispositivo en una ventana temporal, con fuente, reloj y prueba de atribución. |
| Medición | ID físico + `_receivedAt` y timestamp de origen si es válido | Se atribuye mediante la asociación válida para el instante y fuente aprobados, no por la relación actual. |

Los IDs de string y ObjectId deben conservar su tipo explícito. Texto idéntico no prueba
identidad. `lotes`, `campos` y `areas` no se equiparan sin inventario físico y decisión.

## 2. Contrato de asociación temporal

BE-11 debe reutilizar las garantías ya expresadas por `DeviceAssociation`:

- ámbito: `realm`, `clientId`, `fieldId`, `areaId`, `sensorId`;
- dispositivo: `sourceId`, clave técnica tipada y registro físico tipado;
- tiempo: `clockId`, `validFrom`, `validTo` exclusivo o abierto;
- seguridad: `attribution` verificada o cuarentena y `revision` para revalidación;
- páginas completas y acotadas; una respuesta truncada/duplicada falla cerrada;
- ninguna ventana solapada puede atribuir un dispositivo a dos linajes incompatibles;
- una reasignación futura no cambia retroactivamente el dueño de mediciones históricas.

El timestamp manipulable del payload no selecciona cliente. La consulta debe basarse en la
política de fuente aprobada y en `_receivedAt`/reloj verificado según el contrato de ingesta.

## 3. Puerto de dependencias de baja

BE-10 ya consume un puerto administrativo interno con tres resultados:

```ts
type DependencyState = 'clear' | 'blocked' | 'unknown'
```

BE-11 deberá implementar ese puerto con consultas filtradas dentro de MongoDB y ejecutadas
en la misma sesión/transacción y protocolo de control que la baja.

### Desactivar un área

| Evidencia | Resultado |
|---|---|
| Sensor lógico activo o no descomisionado en el área | `blocked` |
| Asociación física abierta para un sensor del área | `blocked` |
| Reasignación/migración concurrente sin CAS confirmado | `blocked` |
| Página truncada, índices no verificados, relación ambigua o dependencia inaccesible | `unknown` |
| Sin sensores ni asociaciones vigentes y linaje histórico preservable | `clear` |

Las asociaciones históricas cerradas no deben reescribirse ni trasladarse. Solo pueden permitir
`clear` si el sensor ya fue descomisionado y las mediciones conservan atribución temporal inmutable.
Esta política requiere aprobación de dominio antes de habilitar la baja.

### Desactivar un campo

BE-10 ya bloquea cualquier área persistida, incluso inactiva. BE-11 debe además impedir que
un writer externo cree sensores/asociaciones entre la inspección y el commit. Un campo solo puede
obtener `clear` cuando no existen áreas y el catálogo de sensores/asociaciones confirma ausencia
completa. Cualquier fuente no integrada devuelve `unknown`, nunca `clear` por defecto.

## 4. Atomicidad y concurrencia

- Los writers de campos, áreas, sensores y asociaciones deben serializarse mediante el control
  por `(realm,clientId)` o un protocolo transaccional equivalente aprobado.
- Crear/mover/descomisionar sensores y abrir/cerrar asociaciones requiere CAS y transacción.
- El inspector no puede hacer una consulta previa fuera de la transacción y luego aceptar una
  baja sin barrera contra writers concurrentes.
- Una actualización no modifica propietario, padre, identidad técnica ni historial mediante PATCH
  genérico. Traslado/reasignación, si se aprueba, será una operación explícita.
- ACK perdido, error del driver, índice incompleto o conexión incierta no se interpreta como éxito.

## 5. Lecturas y agregados necesarios

Para soportar las vistas FE sin inventar datos, BE-11 debe ofrecer puertos internos acotados:

1. listar sensores lógicos por área y cliente;
2. resolver asociación física vigente con verificación temporal;
3. obtener última recepción atribuible por sensor;
4. contar sensores y estados bajo una política temporal aprobada;
5. contar alertas activas solo desde una fuente/ciclo de vida aprobado;
6. consultar históricos por ventanas temporales y asociaciones revalidadas.

`AreaResumen` solo podrá mapearse cuando los cinco agregados tengan fuentes confiables. Un sensor
sin mediciones conserva `ultima_actualizacion:null`; ausencia no se convierte en cero. La alerta
visual por falta de mediciones sigue siendo responsabilidad del frontend salvo cambio aprobado.

## 6. Persistencia a confirmar antes de un adapter real

| Verificación de solo lectura | Estado |
|---|---|
| Colecciones reales de campos, áreas, sensores, dispositivos, asociaciones y mediciones | BLOQUEADO |
| Tipos BSON de IDs y referencias | BLOQUEADO |
| Índices por cliente, jerarquía, dispositivo y tiempo | BLOQUEADO |
| Significado físico de `lotes` y compatibilidad con áreas | BLOQUEADO |
| Presencia/semántica de `device_id`, `_id` y `clientid` | BLOQUEADO |
| Timestamps de adquisición y recepción | BLOQUEADO |
| Autenticidad/procedencia de la ingesta | BLOQUEADO |

No crear colecciones ni migrar hasta resolver esta lista. La implementación puede comenzar con
puertos, schemas y repositorios simulados/aislados, pero no debe afirmar compatibilidad Atlas.

## 7. Contrato HTTP preparado, no implementado

BE-11 deberá definir DTORequest/DTOResponse y OpenAPI para sensores antes de montar rutas. Las
consultas deben exigir sesión, validar `campo_id`/`area_id`, filtrar por cliente dentro del repository
y devolver 404 ante linaje ajeno. No se acepta `clientId` público ni la identidad MQTT como tenant.

La ruta FE observada `/areas/:areaId/sensores?campo_id=...` es una propuesta verificable, pero no
queda aprobada por este documento. Tampoco queda decidida la forma final de `GET /areas` con resumen.

## 8. Criterios de entrada y salida de BE-11

### Entrada mínima

- [ ] aprobar `sensorId` y su colección/tipo BSON;
- [ ] aprobar fuente y clave del dispositivo físico;
- [ ] aprobar ventanas, reloj y reglas de atribución;
- [ ] aprobar estados/descomisionamiento del sensor;
- [ ] aprobar el protocolo transaccional compartido;
- [ ] aprobar qué dependencias bloquean una baja lógica;
- [ ] confirmar inventario físico de solo lectura o mantener adapter real bloqueado.

### Salida técnica antes de habilitar rutas

- [ ] modelos/puertos separados de DTOs;
- [ ] filtros multicliente dentro de todos los repositories;
- [ ] CAS, carreras y asociaciones temporales probadas;
- [ ] lector de dependencias `clear/blocked/unknown` integrado en la transacción;
- [ ] mappers que no exponen documentos Mongo;
- [ ] errores seguros y 404 uniforme;
- [ ] OpenAPI y tipos FE acordados;
- [ ] rutas todavía deshabilitadas hasta validar sesión, mapeo y Preview.

Estado final: contrato de preparación IMPLEMENTADO documentalmente; decisiones de dominio y
mapeo físico PENDIENTES/BLOQUEADAS. BE-11 no fue iniciado por BE-10B.
