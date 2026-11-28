# BE-09.4 — Contrato propuesto de usuario, identidad y cliente

Fecha de revisión: 19/11/2026. Base: dev `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`.
**Propuesta para revisión; no aprueba un modelo físico ni autoriza DDL.**

## Estados y evidencia

| Estado | Aplicación en este documento |
| --- | --- |
| Implementado y verificado | Contratos lógicos, lector estricto y revalidaciones; evidencia local histórica BE-09.3A, 266/266, no reejecutada aquí |
| Implementado sin prueba real | Repositorio Mongoose de challenges/sesiones, sin servidor MongoDB real |
| Propuesto | Esquema de catálogo, índices y protocolo de escritura siguientes |
| Pendiente de aprobación | D01 cardinalidad, D02 mapeo físico, D03 consistencia; ver plan de aprobaciones |
| Bloqueado | Store físico de catálogo y pruebas distribuidas: falta esquema/instancia autorizados |
| No aplicable | Roles por endpoint, usuarios automáticos por email, modelos agronómicos y BE-10 |

Fuentes: [contratos del catálogo](src/auth/identity-catalogue.contracts.ts),
[lector](src/repositories/identity-catalogue.repository.ts),
[sesiones](src/services/session.service.ts), [BE-02](INFORME_BE02_MODELO_DATOS.md),
[instrucciones](AGENTS.md), [plan de aprobación](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).

## D01 — Cardinalidad que debe ratificar el equipo

Las instrucciones vigentes indican un cliente por usuario. El código también representa
una pertenencia nullable; no ofrece selección de cliente ni múltiples membresías.
Esto permite recomendar **un solo cliente vigente por usuario para esta etapa**, sin
convertir la recomendación en aprobación de un esquema definitivo.

| Alternativa | Modelo y consecuencias | Recomendación |
| --- | --- | --- |
| Un cliente vigente | Pertenencia embebida en usuario; sesión ligada al cliente y versión al login; cambio exige nueva sesión | Mantener el alcance actual, pendiente de ratificación de Producto/FE/BE |
| Varios clientes | Colección de membresías única por realm/usuario/cliente; selección explícita de contexto autorizada por servidor; UX/DTO y revocación por ámbito diferentes | Decisión de producto separada; no agregar array ni elegir el primer cliente como atajo |

Varias sesiones del mismo usuario sí son posibles hoy; eso no implica varios clientes.
No hay límite de sesiones activas implementado. D04 debe acordar esa política antes de habilitar.

## D02 — Propuesta física mínima y mapeo

Nombres lógicos `users` y `clients` **no son nombres de colecciones Atlas comprobados**.
El responsable BE-02 debe elegir nombres/namespace, BSON y relación con catálogos existentes.
Recomendación para un namespace nuevo aislado: IDs lógicos string estables, sin coerción,
sin derivarlos de email ni de IDs MQTT; BSON Date UTC para tiempos y entero seguro para versión.
Si el catálogo existente usa ObjectId, conservarlo y aprobar un mapper biyectivo explícito
a ID lógico; no convertir ni migrar históricos por inferencia. No equiparar lotes con áreas.

| Registro/campo | Tipo lógico actual | BSON propuesto | Restricción |
| --- | --- | --- | --- |
| Usuario: realm | Scope de consulta, no campo del DTO de usuario | string enum development/test/preview/production | Obligatorio en persistencia y en todas las claves |
| Usuario: id | string 1..256 sin espacios extremos ni controles | string | Inmutable, estable, único dentro de realm |
| issuer | string; adaptador Google devuelve https://accounts.google.com | string | Canonicalizar solo los dos issuer Google admitidos en el adaptador, no cualquier URL |
| subject | string 1..256 | string | `sub` verificado, opaco; no número ni email |
| name | string 1..256 | string | Dato de presentación del catálogo confiable |
| email | email string, máximo 320 | string | Contacto, mutable; no clave de identidad ni de autorización |
| active | boolean | bool | Baja lógica; jamás default permisivo si falta |
| securityVersion | entero seguro no negativo | entero BSON con mapper estricto a Number seguro | Monótono, incrementar en cambios de seguridad; no reutilizar ni reducir |
| updatedAt | epoch ms entero, 0..8640000000000000 | Date | Tiempo confiable del writer; el lector no corrige datos |
| membership | objeto o null | objeto o null | Una pertenencia actual si D01 se ratifica |
| membership.clientId | string 1..256 | string o mapeo aprobado | Referencia a cliente del mismo realm |
| membership.active | boolean | bool | Pertenencia deshabilitada no autoriza |
| membership.updatedAt | epoch ms válido | Date | No posterior a updatedAt del usuario |
| Cliente: realm, id | scope + string estable | string | Identidad de cliente, no identidad Google |
| Cliente: name, active, updatedAt | string, boolean, epoch ms | string, bool, Date | Cliente inactivo no autoriza |

La representación física de `securityVersion` debe elegirse expresamente: Int64/Long con
comprobación de rango es una opción; no aceptar truncamientos al mapear a Number. Los tipos
anteriores son propuesta; el puerto vigente solo promete valores lógicos. `_id` se elimina
en el mapper y su convención física queda por aprobar. No duplicar `id` y `_id` sin invariante.

La identidad externa y la autorización son conceptos separados aunque se almacenen juntos
en el registro mínimo: `(issuer, subject)` prueba quién es; `active`, `membership`, cliente y
versión deciden qué ámbito puede usar. No provisionar al primer login ni vincular por email,
dominio, header, body o cliente seleccionado por el navegador. Un cambio de principal requiere
procedimiento administrativo auditado; no es una actualización común de perfil.

### Índices propuestos y unicidad

| Colección lógica | Índice | Finalidad |
| --- | --- | --- |
| users | unique `(realm, id)` | Un usuario lógico por scope |
| users | unique `(realm, issuer, subject)` | Un principal Google por scope; todos los registros, incluso inactivos |
| clients | unique `(realm, id)` | Un cliente por scope |
| users | `(realm, membership.clientId, id)` no único | Enumerar usuarios de cliente para invalidación administrativa |

Requerir collation simple, sin índice único parcial/sparse que deje duplicados ocultos,
validación de tipos escalares y campos obligatorios. Índice único multikey no reemplaza esa
validación. Rechazar duplicados antes del alta; no fusionarlos ni escoger findOne arbitrario.
No exigir email único: cuentas distintas podrían compartir contacto y el email puede cambiar.
No TTL en usuarios/clientes: la baja y trazabilidad requieren una política de retención propia.
Índices de sesiones/challenges ya declarados son otro contrato: `_id` único, `(realm,digest)`
único de sesión y TTL Date de expiración; DDL todavía manual/aprobado, sin autoIndex/autoCreate.

### Consultas y writer propuestos

1. Identidad: consulta exacta `(realm, issuer, subject)`; luego cliente exacto `(realm, id)`
   solo si usuario y pertenencia están activos. Sin búsquedas por email o fallback al primer cliente.
2. Sesión: consulta exacta de usuario por `(realm, id)` y nueva lectura del cliente; comparar
   cliente y versión con la sesión persistida antes de dar acceso. El lector actual hace lecturas
   separadas; no son un snapshot transaccional conjunto.
3. Alta: validar tipos, cliente existente/activo y unicidad. Resolver carreras con índice,
   no con un `find` previo como única protección. Conflicto debe abortar, sin alta automática.
4. Cambio de pertenencia, baja/alta de usuario, desvinculación o cambio de principal:
   CAS por realm/id/versión esperada; cambiar estado y pertenencia e incrementar versión
   en **una escritura del usuario**. Cero coincidencias = conflicto; releer, no overwrite ciego.
5. Invalidar versión/estado primero; después revocar sesiones del usuario como limpieza
   idempotente y auditable. La versión ya impide reutilizarlas cuando se observe el cambio.
   El puerto actual solo revoca un digest: revocación masiva/writer son trabajo nuevo, no implementado.
6. Baja de cliente: active=false debe negar nuevas revalidaciones que la observen. Antes de
   reactivarlo, invalidar versiones de todos sus usuarios/sesiones con protocolo controlado y
   verificar finalización; si no, podrían revivir sesiones anteriores. No hay epoch de cliente hoy.
   No prometer baja atómica de todos los usuarios con un recorrido de varios documentos.

| Inconsistencia | Comportamiento esperado |
| --- | --- |
| Usuario desconocido en login | 403 FORBIDDEN genérico; sin provisión |
| Usuario/pertenencia/cliente inactivo o ausente | Login 403; sesión anterior inválida 401; no acceso a negocio |
| Más de un principal/ID coincidente | Store debe rechazar ambigüedad; no conceder sesión; diagnóstico interno sin PII |
| BSON/campos/ID discordantes | Fail closed; error seguro, nunca intentar reparar en lectura |
| Store no disponible | 503 DEPENDENCY_UNAVAILABLE sanitizado |
| Recurso de otro cliente | 404 sin revelar existencia, mediante filtro en repository |

El lector no puede detectar duplicados ocultos si un store retorna solo el primero.
Una validación de salida errónea produce INTERNAL_ERROR en su capa; un fallo de puerto anidado
puede normalizarse a 503 por `callPort`. No se promete un código 500 para toda inconsistencia.

## D03 — Consistencia mínima y alternativa fuerte

Hallazgo reproducido históricamente en A10 de BE-09.3A: una petición lee usuario activo,
entra en `touchSession`, se deshabilita/versiona el usuario y luego el touch actualiza idle.
La posterior inspección/pertenencia deniega. No hay transacción entre los stores actuales.

| Mecanismo | Garantía y límite |
| --- | --- |
| Revalidar usuario/cliente al admitir y al responder sesión | Reduce ventana; cualquier última lectura puede quedar obsoleta inmediatamente después |
| Versión en usuario y sesión | Sesión vieja deja de coincidir al observar nueva versión; no depende de barrer todos los tokens; exige writer confiable |
| Revocar sesiones | Niega admisiones posteriores que observan revocación; no cancela una operación ya admitida ni sustituye versión |
| Orden invalidación → barrido | Evita que la autorización dependa de completar el barrido; fallo parcial deja trabajo de limpieza, no debe reactivar identidad |
| Touch condicional y max atómico | No revive sesión revocada/expirada ni reduce idle; su filtro no consulta catálogo de otro documento/store |
| Mayoría/primary | Reduce riesgo de rollback/lecturas de réplicas atrasadas; no es prueba de linealizabilidad conjunta ni atomicidad de catálogo+sesión |
| Consistencia eventual | Solo aceptable para limpieza/actividad sin otorgar permisos; documentar ventanas, no usar caché permisiva para identidad |
| Transacción con protocolo de conflicto | Puede coordinar documentos en Mongo compatible si todos los writers participan y provocan conflicto sobre autoridad compartida; requiere diseño y prueba real |

**Recomendación mínima pendiente de Seguridad/BE/Datos:** aceptar un touch contable iniciado
antes de una baja; exigir rechazo en la revalidación que observe el nuevo estado/versión y no
entregar nueva capacidad cuando falle. Sesiones quedan ligadas al cliente/versión originales;
no se transfieren a otro cliente. Aceptar también que una capacidad ya admitida pueda completar
su trabajo dentro de su lease. No afirmar revocación instantánea global al ACK de una baja.
Definir y probar SLA de propagación antes de Preview; este documento no inventa su valor.

Si se requiere **cero escrituras de actividad/admisiones después del ACK de baja**, el mínimo
anterior no alcanza. Aprobar protocolo fuerte: autoridad y sesión en mismo sistema, fence/CAS
de autoridad en admisión/touch y baja, o transacción que escriba una guardia común, con reintentos
acotados y rechazo de resultados obsoletos. Una transacción que solo lee usuario y escribe
otra sesión puede sufrir write skew; añadir snapshot por sí solo no prueba la garantía.
No introducir transacciones entre dos stores arbitrarios ni invocar majority como solución.
Cancelar side effects de trabajo ya admitido exigiría además diseño por operación, fuera de BE-09.4.

La base técnica es la [atomicidad MongoDB por documento](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)
y las condiciones de [transacciones](https://www.mongodb.com/docs/manual/core/transactions/);
son referencias de diseño, no evidencia de ejecución en Agro.

### Pruebas deterministas propuestas

- Barrera tras lectura de usuario, antes de touch; confirmar baja+incremento, liberar touch:
  en política mínima puede actualizar idle pero la autorización final debe rechazar, sin DTO/datos privados.
- Barrera tras admisión completa; baja; completar trabajo: registrar límite de lease aceptado,
  no confundirlo con una admisión posterior. En política fuerte probar fence de cada operación protegida.
- Dos writers con misma versión: exactamente uno cambia pertenencia; otro conflicto, sin mezcla de campos.
- Cambio A→B y B→A incrementando siempre versión: ninguna sesión anterior revive.
- Baja/alta de usuario y de cliente, con barrido fallido: no reaparece una sesión anterior;
  bloquear reactivación de cliente hasta completar invalidación aprobada.
- Logout confirmado antes de touch: cero renovaciones; touch primero y logout después:
  revocación persiste. Dos procesos, no solo dos promesas del mismo proceso.

Usar barreras explícitas/promesas/IPC y snapshots de IDs sintéticos, no sleeps para decidir
el orden. Matriz de ejecución y dependencias en [plan E2E/MongoDB](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md).
