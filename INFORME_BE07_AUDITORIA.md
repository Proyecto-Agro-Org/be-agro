# BE-07.1A — Auditoría técnica de Mongoose y Zod

**Fecha:** 17/11/2026, America/Buenos_Aires. **Resultado:** dos defectos demostrados corregidos; **45/45 pruebas** aprobadas. Lista técnicamente para revisión de commit y futuro PR Draft, sin autorización de publicación por esta auditoría. BE-07 continúa parcial; no se inició BE-07.2 ni BE-08.

## 1. Alcance y Git

Rama conservada `feature/be-07-mongoose-zod`; HEAD y rama base BE-06 permanecen en `f0c874bcfba3b5bc0d223baddfe4d29e8ac9f941`. Remoto `https://github.com/Proyecto-Agro-Org/be-agro.git`. Identidad local Camila Gonzalez / camiiigonzalez1503@gmail.com y usuario HTTPS configurado camiegonzalez. No se consultaron credenciales, no se crearon commits ni se tocaron ramas compartidas.

Revisados configuración Mongo, manager, tests, package/lock, tsconfig, app y listener, middleware/contratos HTTP, README, .env.example e informe de infraestructura. La comparación contra BE-06 no contiene otros cambios funcionales. El informe local BE-05 de Vercel sigue sin seguimiento, sin editar ni incluir: SHA-256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`. No se requiere un árbol vacío para auditar el trabajo local autorizado; la excepción anterior se conserva identificada.

## 2. Arquitectura comprobada

El consumidor futuro llama explícitamente a connect; Zod y el parser local del driver validan la configuración antes de crear una Connection. La promesa de apertura se comparte, la conexión activa se reutiliza y un cambio de URI/timeout en uso se rechaza. Cada manager mantiene estado independiente. Se exporta un manager por proceso caliente; importar ese objeto no crea conexiones.

El cierre se coordina con la apertura y con otras solicitudes de cierre. finally libera opening y closing al resolver/rechazar. La cuarentena tras limpieza fallida se representa con un booleano y errores seguros, no con una promesa rechazada retenida. Un fallo de apertura con limpieza satisfactoria permite reintento explícito, como comprueba la suite.

App, controller, service, rutas, DTOs y middleware HTTP no importan la infraestructura Mongo. Health sigue siendo liveness público del proceso; no hay readiness de DB, modelos de dominio, repositories ficticios ni operaciones de persistencia.

## 3. H01 — Base inválida aceptada después de decodificar la URI

**Reproducción anterior a la corrección:** loadMongoConfig aceptaba bases como `bad%20db`, `bad%2Fdb`, `bad%00db`, `%2E` y nombres de 64 bytes. La regex comprobaba el texto de la URI y MongoClient parseaba la sintaxis, pero su constructor no aplicaba todas las restricciones del nombre de base del servidor.

**Corrección mínima:** validar client.options.dbName, ya decodificado por el driver: string no vacío, longitud menor que 64 bytes UTF-8 y sin slash, backslash, punto, comillas, dólar, NUL o whitespace. No se decodifica dos veces ni se transforma la URI/contraseña. Las restricciones de nombre y longitud se contrastaron con [MongoDB: límites de nombres](https://www.mongodb.com/docs/v8.0/reference/limits/). La prohibición de whitespace mantiene una política local conservadora coherente con el rechazo de espacios crudos existente.

**Regresión:** rechazos de caracteres codificados y límites multibyte; aceptación de 63 bytes ASCII y 62 bytes multibyte. El nuevo test falló antes del cambio por ausencia de la excepción esperada. Se añadió además cobertura concreta de credenciales reservadas codificadas válidas y credenciales malformadas con error sanitizado.

## 4. H02 — Segundo cierre bloqueado tras fallo real de Mongoose

**Reproducción sin red:** instancia aislada new Mongoose(), Connection real, openUri sintético y cliente cuyo close rechaza. El primer disconnect dejaba readyState=3. El segundo quedaba pendiente más allá del límite de observación y no volvía a ejecutar el cierre del cliente. El doble EventEmitter anterior permitía un reintento que no representaba la semántica de Mongoose.

Se inspeccionó `node_modules/mongoose/lib/connection.js` de la versión instalada: _close en estado disconnecting espera un evento close. Si doClose rechazó después del cambio de estado, ese evento puede no ocurrir. El [API de Connection](https://mongoosejs.com/docs/api/connection.html) documenta el ciclo de conexión y cierre; la reproducción del comportamiento específico se hizo contra el código instalado 9.12.2, sin parchear la librería.

**Corrección mínima:** un manager con limpieza/cierre fallido queda en cuarentena permanente. Nuevos connect/disconnect rechazan de inmediato con errores tipados, sin reentrar al driver ni crear un pool. El cierre que estaba esperando una apertura también comprueba la cuarentena después de esa espera: no debe repetir la limpieza fallida ni declarar desconexión satisfactoria.

**Consecuencia operativa explícita:** ese caso requiere descarte/reinicio controlado del worker para liberar recursos. No se afirma que el recurso ya cerró, no se altera readyState artificialmente, no se elimina el error ni se crea otro manager/pool para sortearlo. No se implementó ningún reinicio automático o handler de señales. La política deberá revisarse con el equipo antes de integrar; es preferible a una recuperación aparente que puede bloquearse o duplicar recursos.

**Regresiones:** cierre real de Mongoose que debe rechazar rápidamente sin quedar pendiente; cierre en cola tras apertura/limpieza fallidas que no debe volver al driver. El primer test falló antes del cambio con resultado pending. Dos casos previos de limpieza fallida se actualizaron a la política de cuarentena, con assertions de error, estado, ausencia de nuevo pool y ausencia de segundo cierre. Esto corrige una expectativa sustentada en un doble irreal, no oculta un fallo del driver ni modifica expectativas HTTP.

## 5. Validación de entorno y seguridad

- MONGODB_URI ausente, vacía, no string, con protocolo/host/puerto/opciones inválidos o base inválida se rechaza sin necesidad de Atlas. La base explícita evita fallback silencioso a test.
- Timeout: string decimal entero de 100 a 30000 ms, default 5000; sin coerción de null, número, booleano, fracción o espera infinita. Configuración validada congelada; otras variables se ignoran.
- Errores de configuración, apertura y cierre tienen códigos distintos. No exponen Zod issues, URI, contraseña, payload del driver ni cause. La suite comprueba mensaje, stack, JSON y ausencia de logs del fallo simulado. Los nuevos módulos no imprimen URI completas.
- Credenciales sintéticas en tests, dominio reservado en .env.example; no se creó ni se leyó un .env con credenciales. El objeto config y el handle Connection sí contienen datos sensibles internamente: no registrarlos ni devolverlos por HTTP.
- Se revisaron 32 archivos tracked mediante patrones de tokens y claves privadas: cero coincidencias. También se revisó el alcance local nuevo. Es una comprobación acotada del árbol actual, no certificación de todo el historial ni auditoría criptográfica.
- autoCreate, autoIndex y buffering deshabilitados, sin modelos ni queries. No se crearon colecciones/índices ni se accedió a datos.
- Los tests pasan entornos explícitos y factories aisladas. El único caso con Connection real sustituye las fronteras de red por un cliente sintético. La prueba de import protege createConnection, MongoClient.connect, Socket.connect y resolución SRV en un hijo que termina correctamente.

La sintaxis de una URI no identifica un entorno autorizado ni verifica TLS, DNS, allowlist, usuario o rol. Esta auditoría no introduce una política ficticia basada solo en NODE_ENV. Antes de Atlas real, validar destino, TLS, mínimo privilegio y separación de credenciales por entorno. Nunca inferir permiso de escritura de una URI sintácticamente válida.

## 6. Compatibilidad y dependencias

Node 24.19.0, TypeScript 5.9.3 con strict y NodeNext/ESM; Mongoose 9.12.2, Zod 4.6.7 y Express 5.3.0. No se actualizaron versiones ni se añadieron paquetes durante la auditoría. Las 80 entradas del lock previas a BE-07 permanecen idénticas; se conservan las 19 entradas nuevas ya autorizadas de BE-07.1. npm ci instala 99 paquetes desde el lock.

App/listener, tres archivos de tests BE-05/06, middleware CORS/errores, DTOs, rutas, services, tsconfig y vercel.json siguen intactos contra BE-06. La suite conserva GET health 200 y JSON exacto, CORS exacto/sin Origin/wildcard, errores legacy, arranque y ausencia de listener al importar. Se verificó además HTTP local sobre la exportación default de Express.

El patrón de pool/promesa compartida es apropiado para reutilización por proceso caliente; no comparte conexiones entre workers ni certifica Vercel. El timeout de selección/conexión no impone un deadline total a DNS, TLS, consultas o a un close que nunca retorna. No se desconecta por request ni se simula coordinación de queries futuras en vuelo. El Preview funcional y el dimensionamiento/limpieza del worker siguen pendientes, sin ejecutar despliegues.

## 7. Validaciones finales

| Comprobación | Resultado |
| --- | --- |
| npm ci --no-audit --no-fund | Exit 0, 99 paquetes; sin npm audit |
| npm run typecheck | Exit 0 |
| npm run build | Exit 0 |
| npm test | **45/45**; cero fallos, cancelaciones o skips |
| Casos anteriores | 41 conservados; dos expectativas de limpieza corregidas con la justificación H02 |
| Nuevas regresiones | Cuatro: nombre UTF-8/decodificación, credenciales, cierre Mongoose real, cierre en cola tras limpieza fallida |
| git diff --check | Sin errores; también se comprueban archivos nuevos |
| Integridad y aislamiento | Imports sin ciclos, links locales y UTF-8 válidos, exclusiones mantenidas; informe local BE-05 intacto |

Antes del arreglo se ejecutó el subconjunto nuevo: dos fallos reprodujeron H01/H02 y el caso de credenciales aprobó. Tras las correcciones se repitieron todos los comandos obligatorios. Las pruebas HTTP existentes usan loopback y puertos efímeros propios; no hay tráfico Atlas, operaciones reales del driver o datos reales. No se volvió a ejecutar aquí el diferencial histórico 13/13; no se presenta como evidencia remota ni como una validación nueva.

## 8. Archivos y estado final

Cambios de esta auditoría: src/config/mongodb.ts, src/infrastructure/mongodb.ts, test/mongodb.test.js, README.md, .env.example e INFORME_BE07_INFRAESTRUCTURA_MONGOOSE_ZOD.md; nuevo INFORME_BE07_AUDITORIA.md. Package y lock conservan el cambio BE-07.1 previo, sin modificaciones adicionales en esta auditoría.

Delta total BE-07 frente a BE-06: nueve archivos (los anteriores más package.json/package-lock.json). Nada staged. La rama y HEAD se mantienen; no hay commit, push, PR, cambios de settings, otras ramas o credenciales laborales. INFORME_BE05_VERCEL_DEPLOYMENT.md sigue fuera de ese alcance y de cualquier commit futuro de BE-07.

## 9. Pendientes y recomendación

Faltan BE-02/Atlas: evidencia física autorizada, BSON, colecciones, IDs y relaciones aprobadas; no se inventaron modelos ni se asumió lotes=áreas. Siguen pendientes requests/contratos aprobados, integración de un consumidor Mongo autorizado, observabilidad sanitizada y operación real en entorno aislado. No iniciar BE-07.2/BE-08 desde esta auditoría.

**Recomendación:** lista técnicamente para un commit local revisado y preparación de PR Draft encadenado a BE-06. La publicación requiere autorización específica, confirmar la base remota y considerar autodeploy. Antes de integrar, revisar explícitamente la política de cuarentena por fallo de cierre y completar las validaciones externas aplicables. Ni BE-07 ni el Preview Vercel se declaran Done/aprobados. Se detiene al terminar esta auditoría, sin publicar.

## 10. Adenda BE-07.1B — verificación previa a publicación

El pedido BE-07.1B autoriza expresamente commit, push y PR Draft, incluyendo el
posible Preview automático. Al revisar otra rama del hallazgo H02 se reprodujo
un defecto adicional: un cierre previo a reabrir que rechazaba era seguido por
otro close en el catch general. Con Mongoose real, ese segundo cierre podía
resolverse sin volver al cliente, dejando permitido un nuevo openUri aunque el
cierre anterior hubiera fallado. No se utilizó red ni base real en la reproducción.

Se fija blocked al primer rechazo del cierre previo y el catch ya no reintenta
limpieza si está bloqueado. La regresión nueva conserva Connection.close real y
simula exclusivamente openUri y client.close: comprueba rechazo, estado error,
una sola apertura y un solo intento de cierre. Antes del arreglo falló por
ausencia del rechazo esperado. La validación completa posterior aprobó
**46/46** (las 45 anteriores más esta regresión), npm ci, typecheck y build.
README e informe de infraestructura reflejan el nuevo resultado y política.
La recuperación del manager bloqueado requiere descarte/reinicio controlado del
worker; no se añaden reintentos ni handlers automáticos. No cambian dependencias,
contratos HTTP, modelos o alcance de Atlas. La revisión de esa política y las
validaciones externas siguen pendientes antes de integrar.
