# BE-10A — Auditoría e integración deshabilitada

19/11/2026. Corte versionado de auditoría anterior a la publicación. **Aprobada para integrar
infraestructura aislada en dev; no aprobada para producción ni activación de rutas.**

## Referencias y ejecución

Implementación revisada: 5cdeeaa85c09f0de05f86c2162066d324cbd47f2.
Base dev local/remota: d504c8e6c4df9417e35028726fce32f63150f01a.
Main local/remota: 1bb20f76b7a739f42c75b37b9a64315276560ec1; no es destino de esta integración.
Worktree real: C:\Users\CamilaGonzález\be-agro\.local-consolidacion\dev.
La ruta be-agro.local-consolidacion indicada en la consigna no existe; se reutilizó el worktree existente.

Rama: feature/be10-clientes-campos-areas. Destino: dev.
[Registro del PR de esta rama](https://github.com/Proyecto-Agro-Org/be-agro/pulls?q=is%3Apr+head%3Afeature%2Fbe10-clientes-campos-areas+base%3Adev).
La URL numerada, SHA real de merge, HEAD final y resultado Preview se registran después de operar
en el recibo local .local-evidence/INFORME_BE10A_AUDITORIA_INTEGRACION.md y en el PR.
Este corte no inventa un SHA de merge futuro ni incluye su propio hash dentro del archivo versionado.

## Resultado de la auditoría

Se revisaron los tres documentos BE10, schemas Zod, DTOs/mappers, models, repositorio, services,
controller, router, composición pública y capacidades BE09. Se contrastaron con AGRO-DB-01/02,
la especificación y el frontend actual leído desde GitHub.
No se encontraron hallazgos altos/críticos nuevos en el código aislado ni se modificó código funcional.
Corrección documental: DELETE requiere ausencia de dependencias verificada; información desconocida
produce 503, no autorización. Se aclararon la tabla de contrato y M10 de la matriz.

- Las once operaciones no están montadas por app.ts/start.ts; se comprobaron 404 en la app pública.
- El router aislado exige autenticación y cliente antes del parser y del negocio. No hay selector fake
  por env, cookies, body o headers públicos. Los contextos usan la capacidad privada BE09.
- Realm/clientId se obtienen del contexto/catálogo; filtros dentro del repository. Área exige campo
  propio persistido. Ajeno/inexistente →404; propietario, identidad y metadata no son modificables.
- Configuración/inyección sintética solo en tests y harness Docker opt-in. Sin login productivo,
  conexión Mongo al importar módulos, URI Atlas ni secretos incorporados.
- Mapper explícito, formato seguro de errores y logger BE08 reutilizados. No eco de entradas/driver.
- Unique(realm,id), scopes de paginación y control por cliente revisados. Sin TTL o cascadas.
- CAS, merge parcial omitiendo undefined, null explícito, bajas lógicas y fechas monotónicas revisados.
- El control transaccional serializa escritores de campos/áreas; los futuros writers de sensores deben
  coordinarse con él. Falta de evidencia de dependencias bloquea las bajas.

## Pruebas de esta auditoría

Ejecutados npm ci, npm run typecheck, npm run build, npm test y git diff --check: aprobados.
Suite completa **374/374**, cero fallidas/omitidas; se conservan las 360 anteriores y 14 BE10.
Comparador scripts/verify-be10-http.mjs: **13/13** equivalentes a la base d504c8e.
Se revisó la evidencia MongoDB de BE10: **13/13**, 8.0.38, replica set de un nodo, dos conexiones,
run b69e5ad44ce24a5cb6405fe4, limpieza confirmada. No se reejecutó porque no hubo corrección
de persistencia ni brecha nueva que lo justificara. No se afirma nueva prueba multinodo/failover.
Evidencia de esta corrida: .local-evidence/be10a-npm-ci.log, be10a-offline.log y be10a-http.log.

## GitHub y despliegues

Cuenta verificada tanto en conector como en GCM: camiegonzalez. Permiso push confirmado por API.
El conector no puede leer administración; la consulta autenticada con esa cuenta confirmó:
dev protected=false, endpoint de protección sin configuración, rulesets incluidos padres vacíos,
reglas activas de dev vacías, 0 workflows y 0 webhooks del repositorio. No se eludirán reglas nuevas.
Antes del merge deben seguir correctos base/head, diff y checks del PR.

Para be-agro se conserva la confirmación previa del usuario de Production Branch=main. No se
traslada la configuración del proyecto iot-ingest a este backend ni se afirma haber leído Settings
Vercel en esta auditoría. Los metadatos GitHub muestran status Vercel exitoso de la base; no prueban
salud de una API. Se inspeccionarán los checks y comentarios del PR para el Preview automático.
No hay despliegue manual, cambios de configuración ni promoción autorizada a Production.
La app pública no cambia su composición ni dependencias. Main debe conservar el SHA inicial.

## Contratos, riesgos y dependencias BE11

FE mantiene cliente_id/campo_id/area_id/nombre, pero api/client.ts solo admite GET/POST,
lee JSON ante 204 y espera error:string. Debe incorporar PATCH/DELETE, 204 vacío, errores
code/message, versionado y cursor. AreaResumen requiere sensores/conectados/desconectados,
alertas_activas/ultima_actualizacion: BE10 devuelve Área base, sin inventar agregados.
No se cambiaron mocks, identidad, nomenclatura o GIS para simular compatibilidad. No hay
geometrías obligatorias ni mapeo GIS aprobado que migrar en las colecciones candidatas.

agro_business_<sufijo>_{fields,areas,controls} es mapeo local propuesto, no colección observada
en Atlas. El catálogo auth se reutiliza sin crear otro registro empresarial. Pendientes: aprobación
física, sesiones reales, reader/writers coordinados de dependencias, contrato FE y Preview autorizado.
Estos pendientes no bloquean integrar código deshabilitado; sí bloquean activarlo o declararlo Done.
BE11 no se inicia. Requiere acordar sensor lógico versus dispositivo físico, referencias persistidas,
alcance de consultas y protocolo de dependencias antes de habilitar endpoints de sensores.

Referencia: [informe BE10](INFORME_BE10_CLIENTES_CAMPOS_AREAS.md),
[contrato](CONTRATO_BE10_API_FRONTEND.md), [matriz](MATRIZ_BE10_PRUEBAS.md).
