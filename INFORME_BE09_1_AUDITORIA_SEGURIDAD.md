# BE-09.1 — Auditoría de infraestructura de autorización

Fecha: 17/11/2026. Resultado: **apta para revisión/auditoría del equipo y futuro PR
Draft de infraestructura**, con 160/160 pruebas locales. Sin publicación ni Done.
La autenticación real y BE-09.2 no están implementadas ni iniciadas.

Detalle de componentes y contratos:
[INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md](INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md).
Base preservada: `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc`.

## 1. Alcance revisado

Se inspeccionaron contratos de identidad/sesión, procedencia de capacidades,
validación runtime, servicio de autorización, middleware por request y reader de
propiedad scoped. Se revisaron los 30 escenarios BE-09.0 y las responsabilidades
de plan/especificación/AGENTS/DoD. La parte ejecutable se verificó contra apps
Express aisladas y puertos artificiales, no contra un proveedor ni datos reales.

Se conserva route → controller → service → repository/puerto. El servicio no usa
Express; el middleware no consulta MongoDB ni decide pertenencia desde HTTP. Los
readers no exponen modelos/documentos ni admiten un filtro Mongo público.

## 2. Frontera y garantías reales

El servicio solo emite identidad después de llamar al verificador, comprobar
sesión y resolver usuario activo. Solo emite contexto de cliente después de resolver
pertenencia activa. Las estructuras aceptadas son cerradas y las capacidades tienen
procedencia en WeakMaps privados por instancia. El middleware no ofrece un setter
para adjuntar un objeto arbitrario ni lee req.user/req.auth como autoridad.

La seguridad de un proveedor real **no puede demostrarse con la forma de un objeto**.
Los puertos son código de composición del servidor: status=verified procedente de
un fake sigue siendo una simulación. Su verificación criptográfica y relación con
la sesión deberán implementarse/auditarse antes de montar rutas productivas. No
hay adapter real ni fallback permissivo en src. Todos los fakes están en el test.

Las marcas TS no bastan: los tests intentan pasar objetos JSON, copias y referencias
de otra instancia. Se rechazan antes de resolver membresía o leer recursos. El
fixture de compilación comprueba además separación UserId/ClientId, construcción
de contextos y obligatoriedad de clientId en queries.

## 3. Defectos encontrados y corregidos durante la implementación

Los siguientes son defectos de la infraestructura nueva detectados por esta
auditoría local; no se atribuyen al backend publicado BE-08 ni a una explotación
real. No se ajustaron las expectativas para ocultarlos.

| ID | Severidad local | Evidencia anterior al fix | Causa y corrección | Evidencia posterior |
|---|---|---|---|---|
| A091-01 | Media | Test con clock que arroja diagnóstico privado recibió Error original | Evaluación del reloj antes de entrar al validador; ahora toda excepción/valor inválido pasa a INTERNAL_ERROR sin causa | Test de reloj y suite completa aprobados |
| A091-02 | Media | Contexto seguía disponible al cambiar writableEnded antes de finish; un reader capturado podía consultar sin pasar de nuevo por el accessor | Limpieza solo por eventos no cubría la ventana; se añadió validación de flags y lease privado de liveness ligado una sola vez a la identidad | Test fortalecido primero falló con reader directo; luego no llega al puerto y responde UNAUTHENTICATED |
| A091-03 | Media de disponibilidad | Primera suite completa ampliada dio 159/160: autorización obsoleta borraba el scope más reciente sobre la misma identidad | Una rama limpiaba el request al detectar ejecución distinta; ahora solo limpia si terminó la respuesta, y una generación obsoleta se descarta sin tocar la nueva | Test específico y suite final 160/160 |

A091-02 incluye una segunda revisión: inicialmente el accessor detectaba el cierre,
pero se comprobó el reader ya retenido sin invocar ese accessor. Ese camino exigió
vincular la validación al scope mismo. La regresión fue reforzada antes del fix,
no relajada. No se repitieron auditorías equivalentes sin evidencia nueva.

## 4. Concurrencia y ciclo de vida

- Se autenticaron 12 requests HTTP simultáneos de dos clientes con una barrera
  determinista. Sus resultados, IDs de request y filtros de puerto permanecen separados.
- Una autenticación vieja no sobrescribe una más reciente ni borra el estado nuevo
  si termina después. Reautenticación fallida invalida el scope anterior.
- Una resolución de pertenencia vieja no repuebla contexto después de otra identidad,
  ni elimina la autorización más nueva de la misma identidad.
- Terminar/cerrar A invalida sus readers, sin revocar ni invalidar B del mismo usuario.
- El cierre durante verificación descarta la identidad emitida tarde. Un lease muerto
  no revive aunque cambie la condición o retroceda el reloj después de expirar.
- El reader comprueba liveness/expiry antes y después de await; una consulta pendiente
  no devuelve el registro si el request se invalidó mientras esperaba.
- No se captura un error arrojado por next como si fuera un segundo fallo de auth;
  la propagación a Express ocurre una vez.

No hay timeout universal, cancelación de SDK o garantía de que un puerto arbitrario
termine. Los adapters futuros deberán acotar I/O. La seguridad aquí es descartar
estado/resultados obsoletos; no se afirma detener el trabajo externo ya iniciado.

## 5. Aislamiento y recursos

Se comprobaron cliente A/B, IDs lógicos coincidentes entre ambos, recursos ajenos,
padres incoherentes, IDs vacíos/objetos con operadores, y un puerto que devuelve
deliberadamente un propietario equivocado. Un padre inválido corta consultas a
descendientes. Todos los argumentos del puerto incluyen el scope congelado.

Las pruebas verifican el argumento de consulta, además de la respuesta 404. El
fake filtra por cliente/ID/ancestros antes de devolver. El guard también verifica
la referencia retornada, pero esto es defensa adicional: **no autoriza a recuperar
todo MongoDB y filtrar después**. No se implementaron consultas Mongo, count,
aggregates, joins o populate. La implementación real deberá probar ese filtro y
su correlación física con BE-02; ningún schema/índice/colección se declara existente.

bindClientScopedRepository es helper interno con callback servidor de scope; no
debe usarse como constructor de identidad ni cablearse desde un ID público. La
composición actual lo invoca únicamente desde AuthorizationService después de
validar una capacidad. No se pretende impedir que código servidor malicioso omita
deliberadamente las capas o configure puertos mentirosos.

## 6. Errores, datos sensibles y BE-08

Los tests HTTP observaron 400/401/403/404/500/503 con mensajes fijos del catálogo
BE-08, IDs correlacionados y logs sin credenciales artificiales/cookies/diagnósticos.
No se registran outputs, sujeto del proveedor, referencias de sesión, Zod issues,
errores originales o tokens. El único puerto que recibe la credencial es verifier;
los demás reciben las claves mínimas definidas por contrato.

Los esquemas strict rechazan roles/token/password extra en resultados de puertos.
Las excepciones de esos puertos se reemplazan sin cause; resultados malformados son
500 de contrato interno, no identidad aceptada. La sintaxis de Bearer y longitud
no verifican un token: esa tarea sigue siendo del adaptador servidor futuro.

No se cambió el catálogo BE-08 ni el envelope público; las rutas de prueba son
sintéticas. Identidad autenticada sin asignación no consigue un tenant default.
Recursos ajenos e inexistentes tienen la misma categoría 404. La política final
de login/usuario desconocido todavía necesita aprobación BE-03.

## 7. Ausencia de bypass de producción

Se revisó el grafo de imports y el diff: app.ts/default/listener/router permanecen
byte a byte como en BE-08. Ningún módulo nuevo es alcanzable desde esa entrada.
No hay variables de entorno, credenciales mágicas o switches para activar mocks.
El compilador no incluye test. La app real devuelve 200/JSON health incluso sin
sesión y 404 a los paths sintéticos/demo/login: no se montó un endpoint nuevo.

Esto no es un sistema de login listo para producción, sino una infraestructura
que exige configuración explícita de puertos reales. Que health sea público es
el contrato acordado, no una omisión de autenticación de recursos de negocio.

## 8. Validaciones

| Comprobación | Resultado |
|---|---|
| npm ci desde lock existente, sin audit/fund y con red acotada | Aprobado, 99 paquetes; sin nuevas dependencias |
| Línea base | 120/120 |
| Pruebas nuevas | 40, ninguna previa eliminada/modificada |
| npm run typecheck | Aprobado |
| npm run build | Aprobado |
| npm test completo al cierre | **160/160**, cero fallos/omitidas |
| Diferencial HTTP contra BE-08 | **13/13 equivalentes** en status/body/headers seleccionados |
| git diff --check + whitespace de archivos nuevos | Aprobado |
| Revisión de imports/tipos y alcance | Sin ciclos ni any explícito en src/scripts; sin acceso Atlas ni SDK de identidad |

Los 30 escenarios diseñados en BE-09.0 se revisaron con estados actuales en su
matriz: firma/JWKS reales, cookies/CSRF, UI/recarga/logout, persistencia física y
los defectos FE no se presentan como resueltos por estos 40 tests internos.

## 9. Riesgos residuales y salida

No quedan defectos altos/críticos conocidos abiertos en el alcance interno probado.
No se certifica ausencia universal de vulnerabilidades ni autenticación real:

- Proveedor/credenciales/issuer/audience y sesión productiva pendientes.
- Source/subject y referencia de sesión deben provenir de un adapter confiable;
  los schemas no prueban semánticamente que un identificador sea verdadero/no secreto.
- Identidad/tenant reales, BSON y propiedad temporal requieren BE-02/Atlas autorizado.
- Los puertos reales y sus queries son una frontera a auditar, no se pueden validar
  criptográficamente o por filtro Mongo mediante doubles solamente.
- Revocación/desactivación durante un request ya autorizado requiere política real;
  la implementación comprueba estado en cada autenticación y limita el lease al request.
- Transporte actual del middleware es Bearer, no decisión de cookies ni refresh.
- Cambios de FE F09-01/02/03, DTOs y composición pública requieren BE-03/FE.
- Preview Vercel real sigue pendiente; no hubo consultas a la API desplegada.

La recomendación es revisión del equipo/auditoría y preparación futura de Draft
**solo de infraestructura**. Cerrar esos puntos antes de implementar una integración
real BE-09.2; esta tarea no la inició. No marcar BE-09 Done ni publicar sin instrucción.

Sin commit/push/PR/merge/deploy, Atlas, usuarios reales, contraseñas/JWT propios,
modelos/CRUD ni modificaciones de frontend/IoT/producción. El informe BE-05 sigue
local/intacto/excluido. HEAD, main/dev y ramas anteriores permanecen preservadas.
