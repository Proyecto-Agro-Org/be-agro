# BE-10 — Matriz de pruebas y límites de evidencia

Estado: probado localmente, deshabilitado en la app pública. Sin servicios externos.

| Control | Evidencia ejecutada | Resultado |
|---|---|---|
| Regresión previa completa | npm test antes de agregar tests BE10 | 360/360 |
| Suite final | npm test, todos los archivos descubiertos | 374/374; 360 anteriores +14 nuevos, sin fallos/omitidos |
| Instalación/compilación | npm ci; typecheck; build | Aprobados; package y lock sin cambios |
| Rutas públicas cerradas | Once métodos/rutas contra createApp default | 404; sin habilitación por env/headers |
| Router aislado sin identidad | Once métodos/rutas, credencial inválida y usuario sin cliente | 401/403 antes de negocio |
| Cliente actual | Catálogo, estado, campos públicos y tenant falso | DTO mínimo; sin selección por input |
| Campos | Crear, listar, cursor, detalle, PATCH parcial, CAS, baja | 201/200/204; estado persistido; stale409 |
| Áreas | Padre propio, listar/detalle, crear, PATCH, baja | Relaciones conservadas |
| Validación Zod | Campos faltantes, vacíos, tipos, owner, internos, límites, versión | 400; GET/DELETE con body rechazados |
| Aislamiento | Dos clientes, campos/áreas ajenos, padre incorrecto, paralelismo HTTP | 404 sin datos ajenos |
| Dependencias | Campo con áreas, área con sensores fixture | 409, sin cascadas |
| Errores y capacidad | Fallo de storage, contexto forjado, expirado | Error sanitizado; sin identidad inventada |
| Modelos/imports | Definiciones offline sin autoCreate/autoIndex | Sin conexión al importar/definir |
| HTTP default | scripts/verify-be10-http.mjs compara con base d504c8e | 13/13 equivalentes |
| MongoDB real | scripts/be10-local.ps1 -AuthorizeDisposable | 13/13, 8.0.38, replica set un nodo |

## Trece escenarios HTTP comparados

Health sin Origin; Origin permitido; denegado; coincidencia exacta con slash; HEAD; preflight permitido;
preflight denegado; ruta inexistente; POST health; wildcard; allowlist vacía sin Origin; allowlist vacía
con Origin; 500 sintético. Status, body y headers contractuales equivalentes a la base; no se comparan
IDs/fechas dinámicos. Se transpila app.ts de Git base y se comprueba que sus dependencias compartidas
no cambiaron. No es un deploy ni prueba remota. Se mantienen los cambios de seguridad ya presentes
en la base BE-08; no se vuelve a la respuesta antigua que reflejaba rutas en los dos 404.

## Casos MongoDB reales

| Caso | Verificación |
|---|---|
| M01 | Cliente público desde catálogo físico reutilizado |
| M02 | Índice único real y validación BSON estricta |
| M03 | Campo/área y mutaciones filtrados por cliente |
| M04 | Dos conexiones CAS, un ganador y un conflicto |
| M05 | Cursor estable, límite, sin filas de otro cliente |
| M06 | Relación área→campo, actualización parcial, scope |
| M07 | Bloqueo por dependencias; baja lógica sin destruir documentos |
| M08 | Evidencia desconocida impide bajas de campo y área |
| M09 | Cinco carreras crear área/desactivar padre, un ganador por carrera, sin huérfano |
| M10 | Campo sin dependencias verificadas se desactiva; baja ajena falla |
| M11 | Quitar índice bloquea factory nueva y repository existente; restauración explícita solo local |
| M12 | Conexión cerrada devuelve error sanitizado |
| M13 | Reloj regresivo impide corromper fechas de baja; registro/version intactos |

Topología comprobada: un nodo, dos conexiones en el mismo proceso. No se afirma multiproceso,
failover, durabilidad multinodo, recuperación de journal ni prueba de ACK perdido real. El cliente,
la identidad y el reader de dependencias son sintéticos; no prueban Google ni sensores físicos.
Guard/launcher/connectOwned reutilizados de DB02; base nueva, contenedor/red exclusivos, puerto
127.0.0.1:27049 y dos tmpfs. Sin Atlas ni credenciales del proyecto. Limpieza propia confirmada.
La campaña standalone y los 15 casos previos DB02 son evidencia histórica, no se repitieron en BE10.

Evidencia ignorada: .local-evidence/be10-mongodb.json (incluye índices y recurso Docker),
be10-http.json, be10-offline.log y ../integraciones/be10-20261119/resources-*.json.
JSON/referencias/enlaces y git diff --check comprobados estructuralmente; sin ejecutar validador OpenAPI
especializado ni instalar dependencias. Pendientes: contratos FE/BE, Atlas/mapeo aprobado, sesiones reales,
writer de sensores coordinado, Preview y revisión/integración. Ninguno se declara probado aquí.

Revisión FE adicional: api/client.ts leído en GitHub; requiere PATCH/DELETE, manejo de 204 y
lectura de error.code/error.message. Esa compatibilidad no se ejecutó en FE ni se declara resuelta.
