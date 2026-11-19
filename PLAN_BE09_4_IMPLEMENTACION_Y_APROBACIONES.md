# BE-09.4 — Plan de implementación y aprobaciones

19/11/2026. Preparación documental sobre dev `07f15511f26d3fce664d892dba7c8ea7bf48cfe1`.
No asigna fechas, personas ni aprobaciones ficticias. Ninguna etapa autoriza por sí sola
un despliegue ni una modificación de Production.

## Estados

| Estado | Aplicación |
| --- | --- |
| Implementado y verificado | Infraestructura integrada PR #13 y validaciones locales históricas |
| Implementado sin prueba real | Adaptador Google/repositorio Mongoose/router aislado |
| Propuesto | Secuencia A–I y criterios de salida de este documento |
| Pendiente de aprobación | Todas las decisiones D01–D08 y actas A/B/C/G/I |
| Bloqueado | Habilitar autenticación sin catálogo, MongoDB/GIS, FE y controles operativos |
| No aplicable | BE-10, cambios de main, Atlas, nuevos endpoints de negocio en este plan |

## Registro de decisiones para aprobar

| ID | Decisión concreta recomendada | Alternativa / impacto | Aprobación necesaria / evidencia de cierre |
| --- | --- | --- | --- |
| D01 | Un cliente vigente por usuario, acorde al alcance actual | Multicliente exige membresías/UX/selección y contratos distintos | Producto + FE/BE: cardinalidad escrita y ejemplos A→B |
| D02 | IDs estables con mappers, principal único realm/issuer/sub, usuario/cliente únicos por realm | Reutilizar catálogo existente solo con inventario/tipos/BSON aprobados, no migración inferida | Datos/BE-02 + BE: schema, namespace, índices, collation, validadores y procedimiento de alta/baja |
| D03 | Versión CAS y revalidación; permitir touch contable en vuelo y capacidades ya admitidas con lease; definir SLA | Garantía cero actividad tras baja requiere coordinación/fence/transacciones y todos los writers | Seguridad + BE + Datos: semántica exacta y resultados E22/M11 |
| D04 | GIS callback JSON + Bearer Agro; memoria como fuente única, storage opcional; ratificar TTL5min/8h/30min y múltiples sesiones | Cookie HttpOnly cambia transporte/CSRF; límites de sesiones requieren nueva política | FE/BE + Seguridad/Producto: riesgo XSS aceptado y política sesión/logout por escrito |
| D05 | Cuatro rutas y DTO obligatorios; error anidado mediante adaptador explícito | FE password/MSW y legacy string requieren migración coordinada | FE/BE: ejemplos, OpenAPI y pruebas de contrato aprobados |
| D06 | MongoDB local descartable y luego replica set exclusivo para durabilidad/distribución | Sin instancia autorizada no ejecutar ni instalar automáticamente | Operador/Datos + QA: alcance/versión/topología, permisos DDL y limpieza, M01–M12 |
| D07 | Client ID web y namespace separados por entorno; Preview con origen estable exacto | No wildcard para URLs efímeras ni aceptación de audiencias ajenas | Admin Google + FE/BE + Operación: registro de configuración sin secretos y prueba GIS |
| D08 | Limiter compartido, deadlines, logging redactado, alertas y rollback antes de habilitar | Sin cuotas/clave confiable o cancelación, abuso/agotamiento de recursos sigue abierto | Seguridad + Operación + BE: presupuesto/SLA, pruebas429/503, runbook de cierre |

Firmar significa registrar rol/persona, referencia al acuerdo, versión de documentos y alcance;
un merge anterior o código disponible no completa ninguna fila. Plantilla al final.
En D05 el envelope code/message ya está acordado por especificación/BE-03 D03-04;
lo pendiente es la transición legacy, su aplicación al flujo nuevo y el resto de rutas/DTO/status.

## Etapas pequeñas con gates verificables

### A — Aprobar catálogo y unicidad

- Comenzar: revisión de D01/D02/D03 con Producto, Datos y BE. Se puede comenzar ahora como acuerdo,
  sin consultar Atlas ni crear colecciones.
- Dependencias: información BE-02 o evidencia sanitizada del responsable; si catálogo actual no
  está relevado, aprobar contrato lógico y dejar físico bloqueado. No hace falta resolver magnitudes
  IoT/Agronomía para definir identidad Google; sí identidad del cliente y su relación fiable.
- Archivos futuros: contrato usuario-cliente, informe BE-02/schema propuesto; modelos y writer
  de catálogo solo tras aprobación física. El puerto actual se mantiene hasta ratificar cambios.
- Pruebas: unicidad por principal, CAS doble writer, baja/alta y A→B→A; matriz de inconsistencias.
- Riesgos: doble identidad, reactivación de sesión vieja, asignación arbitraria de cliente.
- Aceptación: cardinalidad, IDs/BSON/índices, alta/baja/versionado y D03 explícitos; sin ambiguos.
- Aprueban: Producto (cardinalidad), Datos/BE (físico), Seguridad (consistencia). Salida: acta A.

### B — Aprobar contrato HTTP con frontend

- Comenzar ahora en paralelo con A: revisar D04/D05 y los cuatro ejemplos del contrato FE/BE.
- Dependencias: D01 para respuesta/ámbito definitivo; D03 para promesas de logout/revocación.
- Archivos futuros: DTO/router/controller si hay cambios aprobados, docs/openapi.json y BE-03;
  FE types/auth.ts y API/login/client/session, en su repositorio y tarea propia.
- Pruebas: cuatro rutas, headers, status, strict DTO y ejemplos; 401 sesión vs400 logout,
  204 vacío, transición error string/anidado, generación de sesión, no credenciales en query.
- Riesgos: FE password/demo interpretado como contrato real, error de logout y sesiones tardías.
- Aceptación: paths/métodos/body/response/status, storage/TTL/multisesión y UX de fallo acordados;
  endpoints demo excluidos, OpenAPI alineado. Aprueban FE/BE/Seguridad; salida: acta B.

### C — Preparar y probar MongoDB autorizado

- Comenzar: autorización D06 y entorno exclusivo identificado; hasta entonces solo revisar plan/harness.
- Dependencias: operador, herramientas disponibles/aprobadas; namespace/índices de metadata propuestos.
- Archivos futuros: scripts/audit-auth-mongodb-local.ts ya existente; harness entre procesos y suites
  de integración nuevos solo cuando se autorice su implementación, no creados en BE-09.4.
- Pruebas: sonda acotada y M01–M09/M12; preparar M10/M11 cuando esté el writer D.
- Riesgos: host loopback redirigido, DDL en datos ajenos, ACK perdido, limpieza incompleta.
- Aceptación parcial C: sonda, índices/tipos y aislamiento documentados; aceptación distribuida
  exige el gate M01–M12 completo y replica set para lo que lo requiera, no solo sonda verde.
- Aprueban Operador/Datos/QA y Seguridad. No incluye Atlas ni despliegue. Salida: evidencia C.

### D — Implementar persistencia física de catálogo y coordinación

- Comenzar solo tras acta A física + C básico. D03 define si alcanza CAS/versionado o hace falta fence.
- Dependencias: namespace/ID de cliente confiable; preparación de índices fuera del request/runtime;
  no inferir clientes agronómicos del email ni de payload MQTT.
- Archivos futuros propuestos, todavía inexistentes: src/models/identity-catalogue.models.ts,
  src/repositories/mongoose-identity-catalogue.store.ts y writer de catálogo acotado, tests.
  Revisar mapper/repo de sesiones existente solo si el protocolo aprobado lo exige.
- Pruebas: M01/M10/M11, validación BSON, salida segura, duplicados y CAS, versiones monótonas,
  baja/alta de cliente y usuario, reintento/fallo parcial. Completar todos M01–M12 antes de G.
- Riesgos: escritor externo que no versione, snapshot inconsistente, revocación aparente.
- Aceptación: store físico real conforme, índices y writer verificados, sin fallback in-memory/JIT,
  D03 satisfecho con evidencia entre procesos. Aprueban BE/Datos/Seguridad/QA. Salida: evidencia D.

### E — Configurar Google por entorno

- Comenzar inventario público/config deseada ahora en paralelo; cambios reales requieren D07 y permiso propio.
- Dependencias: admin del proyecto Google, origen Preview estable, client ID web y catálogo de test.
- Archivos futuros: FE env/example y carga GIS; BE config existente, documentación operativa.
  No registrar IDs reales de usuario, secretos ni ID tokens. No editar Vercel en BE-09.4.
- Pruebas: aud/iss/nonce/firma/exp/iat, rechazo de entorno ajeno, callback/popup/FedCM/CSP,
  certificados/red proveedor. Google real solo con cuentas de prueba autorizadas, fuera de esta tarea.
- Riesgos: audience cruzada, origen efímero no autorizado, popup bloqueado, rotación inconsistente.
- Aceptación: manifest de entorno sin secretos y evidencia Google real, no solo deployment Success.
- Aprueban Admin Google + FE/BE + Operación/Seguridad. Salida: evidencia E, aún sin habilitar Production.

### F — Corregir frontend e integrar flujo aprobado

- Comenzar implementación en otra tarea tras B; tests F01–F04 pueden diseñarse ahora.
- Dependencias: B; mocks contractuales para trabajar sin E/D. Integración real espera E/D.
- Archivos FE: src/api/client.ts, src/api/sesion.ts, src/api/login.ts, src/types/auth.ts,
  src/app/AuthContext.tsx, src/app/RutasProtegidas.tsx, src/pages/LoginPage/LoginPage.tsx,
  MSW y tests relacionados. Ninguno se modifica en esta tarea.
- Pruebas: 401 antiguo tras login nuevo, storage que lanza, error anidado, 204 sin JSON,
  restore con gate, logout remoto fallido, callback obsoleto, doble click, mock/real separados.
- Riesgos: token obsoleto, UX que anuncia revocación no confirmada, XSS, demo en modo real.
- Aceptación: fuente única del Bearer, DTO runtime, nuevo flujo sin password inventado,
  tests FE/contratos y no regresión de otras pantallas. Aprueban FE/BE/QA/Seguridad.

### G — Habilitar controladamente en Preview

- Comenzar solo con A/B, M01–M12 y D/E/F aprobados, D08 resuelto y autorización explícita
  para un Preview identificado. La autorización de esta tarea no cumple ese gate.
- Archivos futuros: composición runtime separada/opt-in, app/config si se aprueba, runbook y
  manifest Preview. Hoy app.ts sigue sin montar router. Proteger health público.
- Pruebas: smoke con cuenta de prueba, entorno/commit/URL identificados, CORS exacto, no mock,
  no conexión al importar, límites429/deadline503, logging sin tokens y rollback ensayado.
- Riesgos: autodeploy, compartir DB/audiencia con Production, activar default por error.
- Aceptación: separación real de entornos comprobada, limiter compartido operativo, alertas,
  botón de deshabilitación y responsable de incidentes. Aprueban Operación/Seguridad/FE/BE/QA.
- Rollback propuesto: cerrar admisión/composición en Preview, invalidar sesiones del scope según
  procedimiento probado y restaurar versión/config Preview aprobada; un redeploy manual requiere
  autorización específica. No tocar main ni prometer que apagar UI revoca tokens.

### H — Auditar y ejecutar E2E

- Comenzar con gate G y permiso explícito de pruebas de lectura/login/logout sobre fixtures.
- Dependencias: scripts QA y cuentas de prueba, relojes/barriers controlados donde corresponde.
- Archivos futuros: suites QA/E2E y actas, no secretos ni dumps de DB en Git.
- Pruebas: E01–E22, límites de cobertura E15, MongoDB distribuido y regresiones /health/CORS/HTTP;
  correr npm ci/typecheck/build/test de BE y la suite FE antes de publicar código futuro.
- Riesgos: falsos positivos por mocks, pruebas de carrera no deterministas, token en capturas.
- Aceptación: todos los escenarios aplicables aprobados con evidencia, restricciones de negocio
  futuro explícitas; cero hallazgos altos/críticos; revisión cruzada Seguridad/FE/BE/QA.
  No declarar validado lo bloqueado por Google/infraestructura.

### I — Evaluación separada de Production

- Comenzar solo después de H y de decisión explícita de Producto/Seguridad/Operación.
- Dependencias: monitoreo/alertas, soporte, retención/privacidad, capacidad, riesgo de Bearer,
  gestión de usuarios/bajas, secretos operativos fuera de Git, rollback y recuperación ensayados.
- Archivos futuros: acta de habilitación y runbook; cambios main/config/Production requieren otra autorización.
- Pruebas: revisión de evidencia y checklist por entorno; no ejecutar pruebas en Production por defecto.
- Riesgos: promoción automática, datos reales, revocación/operación sin responsable.
- Aceptación: aprobación independiente, responsables y permisos verificables. **BE-09.4 no aprueba I**.

## Paralelismo y orden recomendado

Ahora: revisión A + B, inventario de configuración E y diseño de harness/pruebas C/F en paralelo,
sin ejecución remota ni código. A y B convergen en D01/D03/D04. Con autorización de instancia,
C puede probar metadata de sesiones sin esperar el catálogo físico; M10/M11 esperan D.
D depende de A físico + C básico. F puede avanzar con mocks del contrato B sin Google real.
E requiere administrador y entornos aprobados. G espera D/E/F, distribución y controles D08;
H espera G; I es otra decisión. Ninguna urgencia ni test local aprobado salta un gate.

La **siguiente implementación del catálogo** se destraba con D01/D02/D03 y acta A más C básico.
La **siguiente implementación FE** se destraba con B (D04/D05); no requiere Atlas para corregir
F01–F04 con fixtures. La **siguiente ejecución MongoDB** requiere D06; escribir la palabra
AUTHORIZED en una variable no sustituye permiso sobre una instancia.

## Registro de aprobación vacío

| Etapa/decisión | Acuerdo y versión revisada | Rol/persona aprobadora | Evidencia | Estado |
| --- | --- | --- | --- | --- |
| A / D01–D03 | Por completar | Por designar | Pendiente | Pendiente de aprobación |
| B / D04–D05 | Por completar | Por designar | Pendiente | Pendiente de aprobación |
| C / D06 | Instancia/alcance por identificar | Por designar | Pendiente | Bloqueado para ejecución |
| E / D07 | Entornos/client ID/orígenes por acordar | Por designar | Pendiente | Pendiente de aprobación |
| G / D08 | Operación/Preview por autorizar | Por designar | Pendiente | Bloqueado |
| H | E2E/auditoría por ejecutar | Por designar | Pendiente | Bloqueado |
| I | Aprobación independiente | Por designar | Pendiente | No autorizado |

Paquete: [informe rector](INFORME_BE09_4_PREPARACION_INTEGRACION_REAL.md),
[catálogo](CONTRATO_PROPUESTO_USUARIO_CLIENTE.md),
[HTTP](CONTRATO_PROPUESTO_AUTENTICACION_FE_BE.md),
[pruebas](MATRIZ_BE09_4_E2E_Y_DEPENDENCIAS.md).
