# BE-07.1 — Infraestructura Mongoose y validación Zod

**Fecha:** 16/11/2026, America/Buenos_Aires. **Estado:** infraestructura mínima implementada y validada localmente; BE-07 parcial, no Done. Sin conexión real a MongoDB, modelos, consultas, colecciones, índices, endpoints nuevos, commits, push, PR ni despliegues. No se inició BE-08.

**Actualización BE-07.1A:** 17/11/2026. [Auditoría técnica](INFORME_BE07_AUDITORIA.md)
con dos defectos corregidos y validación final **45/45**. El resultado inicial fue
41/41; la auditoría añade cuatro regresiones y corrige la política de limpieza fallida.

## 1. Git, fuentes y alcance

Rama `feature/be-07-mongoose-zod`, creada desde `feature/be-06-arquitectura-capas`, SHA base `f0c874bcfba3b5bc0d223baddfe4d29e8ac9f941`. Fetch origin y coincidencia de base local/remota comprobados antes de crearla. Identidad Camila Gonzalez / camiiigonzalez1503@gmail.com; conector GitHub confirmó `camiegonzalez`. No se cambió configuración Git ni credenciales.

El árbol tracked estaba limpio. La única excepción previa era `INFORME_BE05_VERCEL_DEPLOYMENT.md`, preservado local, sin editar ni incorporar. Su SHA-256 continúa `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`. El respaldo previo fuera del árbol está documentado en BE-06.

Se revisaron AGENTS, plan, especificación, DoD, informes BE-05/06 y configuración existente. Los PR #2/#3/#4 fueron consultados en lectura y siguen Draft: no constituyen aprobación del modelo físico, contratos o reglas agronómicas. BE-05/06 se mantienen como dependencias sin modificar sus PR. La autorización de BE-07.1 limita esta etapa a infraestructura, sin desbloquear recursos de negocio ni dar por aprobado Atlas/Vercel.

## 2. Arquitectura y archivos

```text
consumidor futuro autorizado
  → mongoConnection.connect(environment explícito o process.env)
      → loadMongoConfig: Zod + parser local MongoClient
      → conexión Mongoose lazy / promesa compartida
      → reutilización por proceso

app → CORS → health router → controller → service (sin dependencia MongoDB)
```

| Archivo | Cambio |
| --- | --- |
| src/config/mongodb.ts | Nuevo: configuración Mongo validada, tipo readonly y error de configuración seguro |
| src/infrastructure/mongodb.ts | Nuevo: manager con factory inyectable, estados, apertura/cierre serializados y errores seguros |
| test/mongodb.test.js | Nuevo: 25 pruebas sin transporte Mongo real, tras auditoría y comprobación BE-07.1B |
| package.json / package-lock.json | Dos dependencias directas runtime exactas y transitivas correspondientes |
| .env.example | Variables Mongo con placeholders seguros y timeout documentado |
| README.md | Estado actual, API de infraestructura, límites y evidencia |
| INFORME_BE07_INFRAESTRUCTURA_MONGOOSE_ZOD.md | Este informe |

No se tocaron app, routes, controllers, services, DTOs, middleware HTTP, listener, tsconfig, vercel.json ni los tres archivos de pruebas previos. No hay repositorios/modelos ficticios. El manager constituye infraestructura técnica, no lógica HTTP ni autorización de datos.

## 3. Dependencias verificadas

Consulta de versiones estables en el registry npm: Mongoose **9.12.2**, Zod **4.6.7**, fijadas sin rangos en dependencies. Mongoose declara Node >=20.19.0; el entorno comprobado es Node **24.19.0**, npm **11.17.0**, TypeScript **5.9.3**. Compilación strict/NodeNext aprobada con sus tipos incluidos, sin @types adicionales ni skipLibCheck.

Se incorporaron 19 entradas de lock (dos paquetes directos y sus transitivas). Las 80 entradas de paquetes anteriores al cambio se compararon objeto por objeto y permanecen idénticas. Express 5.3.0, cors 2.8.6 y las cuatro devDependencies se conservan. `npm ci --no-audit --no-fund` reinstaló 99 paquetes. No se ejecutó npm audit ni se certifica ausencia universal de vulnerabilidades.

La primera consulta de metadata npm sin permisos de red falló por EACCES del entorno; la consulta autorizada al registry público y la instalación posteriores finalizaron correctamente. No se confundió ese fallo del entorno con una incompatibilidad del proyecto.

## 4. Variables y validación

No se encontró un nombre MongoDB ya definido en los archivos/documentación textual revisados del backend ni en .env.example. Se adopta **MONGODB_URI** para este módulo, sin modificar ingesta ni imponer una equivalencia con sus variables.

- MONGODB_URI: string no vacío, sin espacios crudos, esquema mongodb:// o mongodb+srv://, autoridad y base explícita, sin fragmento. Se valida además con el parser del MongoClient incluido en Mongoose: hosts/puertos/opciones malformados son rechazados localmente. La base decodificada se comprueba por separado: no vacía, menos de 64 bytes UTF-8 y sin slash, backslash, punto, comillas, dólar, NUL o whitespace. El constructor del driver no rechazaba todos esos nombres. La base explícita evita caer silenciosamente en la base default test. No se normaliza ni imprime la URI; credenciales codificadas válidas se preservan.
- MONGODB_SERVER_SELECTION_TIMEOUT_MS: string decimal entero entre **100 y 30000**, default **5000** ms. Se rechazan vacío, null, booleanos/números de entrada, notación exponencial, fracciones, negativos y esperas sin límite. El objeto de configuración validado se congela.
- Otras variables de process.env se ignoran; no se valida PORT/CORS ni se cambia su comportamiento en esta etapa.
- Configuración ausente/inválida produce MongoConfigurationError, code MONGODB_CONFIG_INVALID. No se propagan Zod issues, input, valores recibidos o causa del driver.

El constructor MongoClient solo parsea; nunca se llama a su connect durante validación. Sintaxis válida **no** prueba que exista el host, resuelva DNS, haya acceso de red, la base sea la correcta o las credenciales funcionen. La validación no determina si una URI pertenece a producción; su autorización debe resolverse antes de cualquier uso real.

La carga es explícita y diferida. Ni importar los módulos ni arrancar Express exige URI o abre sockets. Health funciona sin MongoDB. No se creó ni modificó un .env real; .env.example utiliza `mongodb.example.invalid`, sin usuario ni contraseña. Los errores son seguros, pero el objeto config y el handle Mongoose contienen información sensible: los consumidores no deben registrarlos ni retornarlos como DTO.

Zod se utiliza aquí para configuración real de infraestructura. No se implementaron schemas de requests/endpoints de los contratos Draft; esa parte del alcance general BE-07 continúa pendiente.

## 5. Estrategia de conexión y cierre

Se exportan createMongoConnectionManager(factory) para aislamiento y tests, y mongoConnection como manager reutilizable por proceso caliente. La factory default crea una Connection sin URI únicamente cuando se llama explícitamente a connect. No se altera la conexión global de Mongoose mediante mongoose.connect/disconnect ni sus settings globales.

Una promesa opening compartida evita pools duplicados por llamadas simultáneas. Mientras está conectando/conectado se rechaza cambiar URI o timeout, sin revelar diferencias ni valores. El handle activo se devuelve a consumidores internos futuros, nunca como respuesta HTTP. La infraestructura actual no registra modelos ni realiza consultas.

Opciones efectivas: serverSelectionTimeoutMS y connectTimeoutMS con el valor validado; maxPoolSize 5, minPoolSize 0, autoCreate false, autoIndex false y bufferCommands false. El timeout de selección no es una garantía de deadline extremo a extremo para DNS/TLS/limpieza ni sustituye límites de consultas futuras. Cinco conexiones es un límite inicial conservador por pool; deberá evaluarse con concurrencia y límites reales del clúster, no presupone dimensionamiento Atlas.

Estados observables: disconnected, connecting, connected, disconnecting y error, según promesas y readyState. Son estados de transporte, no readiness ni garantía de autorización/consultas. Los eventos error se observan sin imprimir payloads del driver; los fallos de apertura/cierre se devuelven con errores tipados seguros. No se conserva causa original que podría contener URI o credenciales. Observabilidad sanitizada más detallada queda pendiente, sin implementar logging BE-08.

Un fallo de apertura intenta cerrar el recurso y permite reintento explícito tras limpieza satisfactoria. Si falla la limpieza/cierre, el manager queda bloqueado de forma permanente: posteriores connect/disconnect rechazan de inmediato sin tocar el driver. Mongoose puede quedar en readyState=3 tras rechazar close; volver a llamar a close puede esperar indefinidamente un evento que no llegará. La recuperación de ese caso exige descarte/reinicio controlado del worker, sin abrir un pool alternativo para eludir el bloqueo. El cierre concurrente comparte una promesa y espera la apertura en curso; si esa apertura falla y también su limpieza, el cierre pendiente respeta el bloqueo y no intenta limpiar por segunda vez. En el caso satisfactorio, nuevas conexiones durante el cierre esperan su finalización. Tras una desconexión inesperada, una reapertura explícita cierra primero el cliente anterior para no dejar su pool recuperándose en paralelo.

No se añaden reintentos infinitos, señales globales ni cierre por request. El manager puede reutilizarse entre invocaciones calientes, pero no comparte memoria entre workers. El patrón de reutilización está documentado por [Mongoose para entornos serverless](https://mongoosejs.com/docs/lambda.html); su adecuación real a este Vercel sigue pendiente. Opciones, buffering y timeouts se contrastaron con la [documentación de conexiones Mongoose](https://mongoosejs.com/docs/connections.html) y el [API de Connection](https://mongoosejs.com/docs/api/connection.html). Los esquemas se basan en la [API oficial Zod](https://zod.dev/api).

## 6. Pruebas y validaciones

| Validación final | Resultado |
| --- | --- |
| npm ci --no-audit --no-fund | Exit 0, 99 paquetes desde lock |
| npm run typecheck | Exit 0 |
| npm run build | Exit 0 |
| npm test | **46/46** aprobadas, cero fallos/skips/cancelaciones; incluye las 45 anteriores |
| Regresión BE-05/06 | Las **21 pruebas** originales conservadas byte a byte y aprobadas |
| git diff --check | Sin errores; revisión adicional de nuevos archivos |
| Arranque local y health | Listener compilado real en hijo con PORT=0: 200 y JSON exacto; mismos tests de .env sintético, prioridad y PORT inválido |
| Integridad de exclusiones | dist, node_modules, .env y documentación de referencia permanecen excluidos |

Las **24 pruebas Mongo** cubren los 20 escenarios iniciales y cuatro adicionales de BE-07.1A: base decodificada/límite UTF-8; credenciales codificadas o malformadas; fallo de close con Connection real de Mongoose y cliente sintético; cierre en cola tras apertura y limpieza fallidas. Dos pruebas previas de limpieza fallida se ajustaron expresamente a la política de cuarentena: el doble permitía un reintento de cierre que no representa la semántica real comprobada de Mongoose. No se eliminaron casos ni se alteraron expectativas HTTP.

Todas las aperturas de esos tests usan factories inyectadas sin transporte real. La mayoría usa EventEmitter; una regresión utiliza Connection real de una instancia aislada de Mongoose y sustituye openUri y el cliente por operaciones sintéticas para conservar únicamente la semántica real de close. No hay sockets Mongo, credenciales reales ni modelos. La prueba de import usa un proceso hijo con URI deliberadamente inválida y guardas que fallarían si se llamara a createConnection, MongoClient.connect, Socket.connect o resolución SRV; el proceso termina correctamente. Los tests HTTP solo abren servidores locales efímeros propios y los cierran.

Los errores se prueban con una contraseña sintética construida en memoria: no aparece en mensaje, stack, JSON o cause. Se comprueba ausencia de console.error/warn durante fallo de apertura. Los tests JS prueban comportamiento; no se presentan como verificación estática de dobles que implementen toda la clase Connection.

En la revisión se reforzó el cierre del cliente anterior antes de reabrir tras readyState=0 y se añadió la comprobación al escenario de reconexión. Todas las validaciones se repitieron después. No se detectaron regresiones de HTTP; no se repitió aquí la comparación diferencial externa 13/13 de BE-06, cuyo resultado histórico no se extrapola a Vercel.

## 7. Riesgos, límites y decisiones pendientes

- Atlas sin acceso autorizado: no se verifican DNS, TLS, IP allowlist, roles, autenticación, topología, base real ni comportamiento de fallos reales del driver.
- BE-02: siguen pendientes colecciones, BSON, IDs, relaciones y significado de lotes. No se crean schemas ni se asumen sus propuestas como modelo físico.
- Antes de usar modelos/repositories, aprobar datos y aislamiento por entidad. Las opciones anti autoCreate/autoIndex no sustituyen permisos de mínimo privilegio y revisión de operaciones futuras.
- El manager permite cerrar/reabrir de forma explícita; en serverless debe coordinarse shutdown con operaciones futuras. Esta etapa no implementa seguimiento de queries en vuelo ni adquisición/liberación por consumidor.
- Requests Zod, integración de un consumidor autorizado, observabilidad sanitizada y política de conexión de arranque/readiness requieren acuerdos posteriores. Si se necesita readiness, definir su contrato aparte; no agregar DB a /health.
- BE-05/06 siguen Draft. El alcance local BE-07.1 no valida Vercel ni autoriza publicar: el autodeploy sigue siendo un riesgo para un push futuro.

**Pendientes para completar BE-07:** revisión e integración del alcance, modelo mínimo y contratos aprobados según plan, conexión real únicamente en entorno aislado/autorizado, credenciales de mínimo privilegio gestionadas fuera de Git, validación de entradas de operaciones aprobadas y comprobación posterior del runtime previsto. No se declara satisfecho todo el DoD por pasar mocks.

**Recomendación:** auditar esta infraestructura local antes de publicar y acordar con los responsables de datos el siguiente alcance. Detener aquí: no conectar a Atlas para demostrar el módulo, no comenzar BE-08 ni implementar recursos de negocio.

## 8. Comprobación de publicación BE-07.1B — 17/11/2026

La revisión adicional detectó un caso del cierre previo a la reapertura: si fallaba,
el catch general volvía a cerrar. Mongoose puede omitir ese segundo cierre en
readyState=0 por su marca interna de close ya solicitado, aunque el cliente no haya
cerrado. Se reproducía una apertura posterior permitida sin limpieza confirmada.
Se bloquea ahora el manager en el primer rechazo de ese cierre y no se vuelve al
driver desde el catch. Se añadió una regresión con Connection real y fronteras
de red sintéticas: falló antes de corregir por ausencia del rechazo esperado.
Resultado final de validación: **46/46**, manteniendo las 45 anteriores, typecheck,
build y npm ci aprobados. No se actualizó ninguna dependencia ni se contactó Atlas.
La política de cierre fallido queda documentada para revisión del equipo; no se
implementa descarte/reinicio automático del worker.
