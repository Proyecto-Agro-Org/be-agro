# BE-07.2 — Infraestructura de validación de requests

**Fecha:** 17/11/2026, America/Buenos_Aires. **Estado:** implementada y auditada localmente; no Done. **73/73 pruebas** aprobadas tras BE-07.2A (69/69 iniciales). Sin commit, push, PR, despliegues, Atlas ni inicio de BE-08. Ver [auditoría BE-07.2A](INFORME_BE07_2_AUDITORIA.md).

## 1. Preparación y fuentes

Rama creada `feature/be-07-2-validacion-requests` desde `feature/be-07-mongoose-zod`, base **8399c75255616b6286035e1dd534fe52d725d18c**. Fetch origin completado; base local/remota y HEAD coincidían con ese SHA antes de crear la rama. Origin corresponde a Proyecto-Agro-Org/be-agro. Identidad Git Camila Gonzalez / camiiigonzalez1503@gmail.com; conector confirmó camiegonzalez. No se cambiaron configuración o credenciales.

No había cambios tracked/staged. La excepción local conocida INFORME_BE05_VERCEL_DEPLOYMENT.md se conserva intacta y sin seguimiento, fuera de BE-07.2: SHA-256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`. No se descartó trabajo ni se modificaron ramas anteriores.

Se revisaron AGENTS.md, plan, especificación, DoD, informes BE-05/06/07, código de composición, errores, configuración y testing. El PR #3 se consultó solo como referencia: permanece Draft; no se aprobaron sus rutas, schemas, parámetros o decisiones de negocio por implementar esta infraestructura. El pedido actual autoriza BE-07.2 pese a las exclusiones históricas de las tareas anteriores.

## 2. Arquitectura propuesta e implementada

```text
operación futura aprobada
  → parser aprobado de body, cuando corresponda
  → createRequestValidation(schemas, options).middleware
      → safeParseAsync de las partes configuradas
      → éxito total: WeakMap privado [Request → salidas Zod]
      → fallo: next(error interno sanitizado)
  → controller: mismoValidator.getValidatedData(request)
  → service: datos validados y DTOs acordados posteriormente
```

La infraestructura acepta body, params y query de manera independiente; no ejecuta negocio ni consulta MongoDB. Construye una lista de partes/esquemas y copia las listas de campos públicos al crear la factory. Mutar después el objeto de configuración o sus arrays no sustituye el esquema o amplía la información de error expuesta. Configuraciones con partes desconocidas o valores que no son esquemas Zod fallan al crear el middleware.

No se registra ninguna ruta productiva ni se agrega parser global. Health no requiere validación nueva. Las rutas y el adaptador de errores usados en pruebas solo existen en aplicaciones Express aisladas del test.

## 3. Archivos y decisiones de diseño

| Archivo | Responsabilidad |
| --- | --- |
| src/middlewares/validate-request.middleware.ts | Factory, esquemas opcionales, inferencia de salidas, parseo async, proyección de errores y accessor por request |
| src/errors/request-validation.error.ts | Tipos internos de issue y errores seguros; sin status HTTP ni formato API definitivo |
| test/request-validation.test.js | 27 pruebas de comportamiento, HTTP, aislamiento, dependencia y tipado |
| README.md | Uso y límites de la nueva infraestructura |
| INFORME_BE07_2_VALIDACION_REQUESTS.md | Este informe |
| INFORME_BE07_2_AUDITORIA.md | Auditoría BE-07.2A, defectos, regresiones y límites |

Se usa safeParseAsync para soportar de forma uniforme schemas síncronos, refinamientos async y transformaciones async. No se intenta detectar internals Zod para elegir un parser diferente. Las partes se procesan en orden body → params → query y se agregan los fallos esperados; si una parte falla no se publica un resultado parcial de las otras. Un refinamiento que lanza/rechaza se distingue de una invalidación esperada y termina la ejecución con un error seguro.

Las propiedades de Request nunca se reasignan. Esto respeta el getter req.query de [Express 5](https://expressjs.com/en/guide/migrating-5/) y permite conservar la entrada cruda separada de la salida transformada. La [guía oficial Zod](https://zod.dev/basics) documenta el uso de parseo asíncrono para refinamientos/transformaciones async y la inferencia de salidas.

## 4. Consumo tipado y aislamiento

Cada instancia de createRequestValidation devuelve middleware y getValidatedData. La misma instancia debe utilizarse para registrar la operación y para leer en su controller. Un WeakMap privado asocia la identidad de Request con los datos validados; otro validator no puede leer esos resultados aunque tenga schemas iguales. No hay un objeto global de request actual, res.locals compartido ni augmentación global de Express que pudiera fingir que toda solicitud fue validada.

El accessor lanza ValidatedRequestUnavailableError si se llama antes del éxito, con otro request o tras una validación fallida. Cada nueva ejecución elimina un resultado anterior de ese request antes de parsear. Solo después del éxito de todas las partes guarda un contenedor nuevo, congelado, con las partes configuradas. El WeakMap permite liberar las referencias cuando Request deja de ser alcanzable.

BE-07.2A añadió una generación privada por ejecución: si otra invocación sobre
el mismo Request la reemplaza mientras espera un refinamiento, la antigua
rechaza con error interno y no publica datos, ni revive resultados tras el fallo
de la nueva. Las ejecuciones sobre requests distintos siguen independientes.
La generación no cancela trabajo async ni autoriza múltiples cadenas HTTP
paralelas; la integración ordinaria debe registrar una ejecución por operación.

Se comprobó la presencia mediante Object.hasOwn: un campo opcional ausente no
aparece, mientras que el explícitamente undefined sí aparece cuando el esquema
lo conserva. null requiere nullable. Una parte configurada cuya salida es
undefined sí existe en el contenedor; una parte no configurada no. No se afirma
que la lectura de request.body distinga por sí sola un body ausente de una
propiedad body con valor undefined: Zod recibe el valor de la propiedad. JSON
no codifica undefined y defaults/transforms pueden unificar casos por decisión
del esquema.

ValidatedRequest usa z.output para cada esquema literal: si una transformación cambia string a number, el controller recibe number. Las partes no configuradas no aparecen en ese tipo. Configuraciones tipadas de forma amplia/optional se tratan conservadoramente; no se afirma un tipo concreto que el esquema no declare. No hay any propios ni supresiones de tipos en las fuentes. Una única aserción en el límite de éxito relaciona el objeto construido en el loop con la salida genérica; está precedida por validación completa.

El contenedor es readonly; las salidas anidadas no se congelan profundamente ni se clonan de nuevo indiscriminadamente, para conservar tipos legítimos de Zod. Los esquemas y refinamientos son código confiable: no deben introducir efectos secundarios o devolver singletons mutables compartidos entre requests. La infraestructura no incorpora ese estado compartido.

## 5. Errores seguros e integración futura BE-08

- RequestValidationError: code REQUEST_VALIDATION_FAILED, message genérico y lista inmutable de issues.
- Su constructor copia explícitamente part/path/code y un mensaje fijo; descarta metadata adicional. No sustituye la proyección/allowlist de paths que realiza el middleware: no debe recibir paths arbitrarios sin sanear.
- Cada issue indica part (body/params/query), path, code Zod reconocido y mensaje fijo «Valor inválido.».
- publicFields permite nombres estáticos autorizados por parte. Sin configuración, los nombres se sustituyen por [field]; segmentos numéricos por [index]. Un path vacío refiere a la parte completa. No se copian valores, claves desconocidas, enum values, detalles de unión ni mensajes personalizados de Zod.
- RequestValidationExecutionError: code REQUEST_VALIDATION_EXECUTION_FAILED para excepciones/rechazos de schemas o lectura de input; no retiene la excepción, stack original o cause. Su propio stack solo describe el error seguro.
- ValidatedRequestUnavailableError detecta integración incorrecta o acceso prematuro, sin datos del request.

La proyección es necesaria porque los [errores Zod pueden personalizar mensajes y metadata](https://zod.dev/error-customization); incluso el path puede ser una clave dinámica proveniente del input. Una lista pública debe definirse a partir de nombres confiables, nunca de Object.keys(req.body) o valores recibidos.

El middleware no responde ni selecciona status. Solo llama una vez a next con éxito/error; las llamadas a next quedan fuera del try del parseo para no capturar un fallo downstream y propagarlo una segunda vez. No añade statusCode a estos errores ni cambia el contrato legacy.

**Antes de usar en endpoints reales**, BE-08 debe acordar/traducir esta representación al status y DTO de error público. Si se conectara sin adaptador al handler legacy actual, el error sería tratado como 500; esta entrega no implementa una transición global a 400 ni presenta la respuesta del adaptador de tests como contrato aprobado. Errores de parser JSON, límites y permisos también requieren su tratamiento acordado.

## 6. Pruebas y resultados

| Validación | Resultado |
| --- | --- |
| npm ci --no-audit --no-fund | Exit 0, 99 paquetes del lock existente; sin instalación de dependencias nuevas ni npm audit |
| npm run typecheck | Exit 0, strict/NodeNext |
| npm run build | Exit 0 |
| npm test | **73/73**, cero fallos/skips/cancelaciones; las 69 iniciales más cuatro casos BE-07.2A |
| git diff --check | Sin errores; revisión adicional de los archivos nuevos |
| Integridad | Package/lock, tsconfig, fuentes previas, tests previos y vercel.json sin cambios |

Las 23 pruebas iniciales de requests, conservadas sin cambiar expectativas, cubren:

- Body válido con trim/strip; body inválido, campos ausentes y tipos incorrectos.
- Params válidos/transformados e inválidos; query válida/inválida sin asignación a su getter.
- Múltiples partes con agregación de fallos y prohibición de éxito parcial; lectura únicamente de partes configuradas y configuración vacía.
- Refinamientos/transformaciones async: no se avanza antes de completarlos; errores lanzados o rechazados se sanitizan.
- Mensajes, enums, claves dinámicas y paths con secreto sintético no se filtran, ni por JSON ni por stack/cause.
- Requests concurrentes independientes, acceso desde otra factory rechazado e invalidación de resultados al repetir un request que falla.
- Snapshot de configuración y campos públicos; error downstream no reenviado dos veces.
- Express 5 real en loopback: body/params/query transformados, req.query conservado, controller omitido ante invalidación y éxito/fallo async.
- Proceso hijo con hooks de resolución que rechazan imports mongoose/mongodb: la validación se importa y ejecuta sin esas dependencias.
- Fixture TypeScript en memoria compilado con las opciones reales: acepta salidas inferidas y rechaza input crudo como salida, params no configurados y reasignación del contenedor. Las directivas de error esperado están solo en esa prueba, no en código productivo.

Las 46 pruebas anteriores permanecen sin editar e incluyen arranque real del listener compilado, health HTTP 200/JSON exacto, export default sin listener al importar, CORS/errores legacy e infraestructura Mongo aislada. No se detectaron regresiones. No se repitió el diferencial histórico externo 13/13 ni se validó Vercel remoto; esos resultados no se inventan ni se extrapolan de las pruebas locales.

La auditoría añadió cuatro casos: resultado async antiguo frente a una nueva
validación exitosa/fallida del mismo Request; descarte de metadata extra en el
constructor del error; ausencia/undefined/null en campos opcionales; salida
undefined validada frente a parte no configurada. Los dos primeros reprodujeron
defectos antes de corregir; los dos últimos cubrieron una brecha de evidencia y
aprobaron antes y después. Se repitieron todos los comandos obligatorios después
de las correcciones. No se modificó el contrato HTTP para hacer pasar pruebas.

## 7. Compatibilidad, límites y próximos pasos

Node local 24.19.0, Express 5.3.0, Zod 4.6.7, TypeScript 5.9.3; se mantienen Mongoose 9.12.2 y el módulo Mongo BE-07.1 intactos. Imports relativos .js e import type compatibles con el layout ESM compilado. No hay acceso Atlas ni validación nueva de health. La exportación default Express, app/listener y handler legacy siguen intactos.

Los esquemas deciden coerción, campos extra, rangos, límites y semántica; esta factory no los inventa. Los parsers se deben registrar antes del middleware donde corresponda. No se implementan timeouts/cancelación de refinamientos, límites de cardinalidad/payload globales, logging o un error API definitivo como parte de esta entrega. La política de profundidad/índices públicos y UX de errores deberá aprobarse con FE/BE antes de exponer detalle adicional.

BE-02 sigue condicionando IDs/BSON/relaciones reales. BE-03 debe aprobar DTOs y schemas de operaciones; no se copiaron propuestas Draft a rutas reales. BE-08 debe integrar errores y demás políticas transversales. No se empieza esa etapa ni se implementan dominios, CRUD, autenticación o modelos.

**Recomendación:** tras BE-07.2A, lista técnicamente para revisión del equipo y commit local autorizado. No declarar BE-07 Done, publicar o conectar esta infraestructura a endpoints pendientes por inferencia. Un push futuro podría activar autodeploy y requiere autorización específica. Se detiene aquí sin commit/push/PR, fusiones, despliegues ni cambios de frontend/IoT.
