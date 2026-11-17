# BE-07.2A — Auditoría de validación de requests

**Fecha:** 17/11/2026, America/Buenos_Aires. **Resultado:** dos defectos reproducidos y corregidos; **73/73 pruebas** aprobadas. Lista técnicamente para revisión de commit y futuro PR Draft encadenado. BE-07 sigue parcial; sin publicación ni inicio de BE-08.

## 1. Alcance y estado Git

Rama conservada `feature/be-07-2-validacion-requests`, HEAD/base BE-07.1 `8399c75255616b6286035e1dd534fe52d725d18c`. Origin corresponde a `Proyecto-Agro-Org/be-agro`. Identidad Git local Camila Gonzalez / camiiigonzalez1503@gmail.com; usuario HTTPS configurado camiegonzalez. No se cambiaron rama, configuración o credenciales.

Revisados diff tracked y todos los archivos nuevos del alcance, middleware, errores internos, tests, README, informe BE-07.2, documentación base y evidencia de BE-05/06/07. No se copiaron contratos Draft ni cambios de otras funcionalidades. Package/lock, tsconfig, configuración/conexión Mongoose, app/listener, middleware legacy, tests de etapas anteriores y vercel.json permanecen idénticos a BE-07.1.

El archivo local INFORME_BE05_VERCEL_DEPLOYMENT.md permanece intacto, sin seguimiento y fuera del alcance: SHA-256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`. No hay staging, commits, push ni PR de esta tarea. El árbol contiene el trabajo local BE-07.2 autorizado; no se declara limpio ni se ocultan untracked.

## 2. Arquitectura y verificación del accessor

La factory recibe schemas independientes para body/params/query y valida solo esas partes con safeParseAsync. Los resultados transformados se publican de forma conjunta, después del éxito total. No se sobrescriben propiedades Request, incluido el getter query de Express 5. Las pruebas hacen HTTP sobre una app Express aislada, además de probar el comportamiento unitario.

Un WeakMap por factory asocia Request a su resultado; el accessor solo puede leer ese Request validado por esa misma factory. Una ejecución nueva invalida el resultado anterior al comenzar. No hay setters públicos, datos por request globales ni un flag booleano compartido que pueda fingir validación. Se conservan z.output y el contenedor readonly/congelado, con prueba de compilación real que rechaza tipos del input donde la salida ya fue transformada.

La aserción interna del tipo genérico solo se usa tras parsear todas las partes; no valida nada por sí misma. No se afirma que TypeScript impida al controller leer req.body crudo, ni que congelar el contenedor haga profundamente inmutable cualquier salida Zod. Los controllers futuros deberán usar el accessor y schemas aprobados.

## 3. H01 — Resultado async obsoleto sobre el mismo Request

**Antes:** una validación A podía esperar un refinamiento mientras B empezaba sobre la misma instancia Request. B borraba resultados anteriores y fallaba; cuando A terminaba, guardaba su resultado antiguo. La reproducción mostró accessor no disponible tras B y disponible otra vez con el valor anterior tras A. También se podía sobrescribir el éxito nuevo con el viejo.

**Corrección:** una segunda WeakMap privada guarda un Symbol de generación por Request. Antes de publicar éxito o fallo esperado, la ejecución comprueba que sigue siendo la actual. Si fue reemplazada, propaga RequestValidationExecutionError seguro y no escribe datos. Las excepciones del parseo ya terminan con error seguro y tampoco escriben resultados. Requests diferentes no comparten generación.

La regresión controla el orden con una promesa, sin sleeps, y cubre tanto la nueva validación exitosa como la fallida. Falló antes del cambio porque la ejecución antigua notificaba éxito. Después prueba que el resultado más nuevo se conserva o que los datos continúan indisponibles.

**Límite:** esto protege los resultados, no cancela el refinamiento ni organiza varias cadenas next sobre un mismo request. La integración normal debe invocar el middleware una vez por operación; no se incorpora un motor de cancelación o coordinación HTTP paralelo.

## 4. H02 — Constructor del error copiaba propiedades extra

**Antes:** RequestValidationError usaba spread de la issue. Un objeto con los campos previstos más `input` o metadata anidada conservaba esas propiedades al serializar el error. Los tipos estructurales no impiden que un objeto más rico se pase como el tipo esperado. La factory existente ya proyectaba sus issues, por lo que no se observó una fuga desde las rutas de prueba; el defecto estaba en la representación reutilizable exportada, relevante para consumidores futuros.

**Corrección:** copiar únicamente part, path, code y el mensaje fijo seguro; clonar/congelar el path y las issues como antes. No se conserva metadata extra ni se acepta como mensaje un valor aportado por el caller. La regresión falló antes del cambio porque JSON del error incluía el secreto sintético; ahora comprueba las cuatro propiedades permitidas y ausencia de causa/input extra.

**Límite de confianza:** la proyección de nombres de paths y códigos se mantiene en el middleware. El constructor no puede adivinar si un nombre arbitrario contiene un secreto: debe recibir la representación ya proyectada. Las listas publicFields deben ser estáticas y confiables, nunca derivadas de los datos de entrada.

## 5. Ausencia, undefined, null y schemas

Se añadieron dos pruebas por una brecha concreta de cobertura; ambas aprobaron también antes de modificar código, por lo que no se presentan como defectos:

- Campo opcional ausente frente a propiedad explícita undefined: se comprueba Object.hasOwn en la salida Zod. null se admite únicamente en el campo nullable correspondiente; no se trata como ausencia universal.
- Salida transformada a undefined: el contenedor mantiene la parte configurada como propiedad propia. Una parte sin schema no aparece. El accessor comprueba el contenedor, no la truthiness de body/query/params.

El middleware lee valores, no inventa metadata del transporte. Un body inexistente y req.body explícitamente undefined llegan a Zod como undefined; JSON no representa ese valor. Dentro de objetos, defaults/coerciones/transforms pueden unificar casos según el schema. No se promete una distinción que ese schema decida eliminar.

## 6. Seguridad y manejo de errores

Comprobados errores de tipo/campos ausentes, campos desconocidos por strip/strict, params y query, refinamientos async, coerciones/transformaciones, fallos lanzados/rechazados, requests sucesivos y concurrentes. Una validación fallida no publica éxito parcial. Los mensajes originales Zod, valores de enum, claves dinámicas y paths personalizados no se copian al error; se usan códigos reconocidos, nombres permitidos y marcadores de campo/índice.

No se registran inputs ni excepciones originales. Los errores inesperados del parseo pierden cause y stack original. Next se ejecuta fuera del try de parseo para no capturar un fallo downstream y enviarlo dos veces. Se conserva la propagación async de Express 5. No se agregan statusCode ni respuestas HTTP desde el middleware.

Los tests usan datos sintéticos y servidores efímeros en loopback. Un hijo con hooks rechaza imports mongoose/mongodb y aun así importa/ejecuta la validación. No hay conexiones Atlas, writes, modelos o dependencia de Mongo para validar requests. El informe local BE-05, .env, dist, node_modules y documentación privada no se incluyen en el alcance.

La revisión acotada de patrones de tokens/claves y de valores/archivos del delta no encontró secretos reales; no certifica todo el historial ni reemplaza revisar staging en una futura publicación.

## 7. Pruebas y compatibilidad

| Validación posterior a las correcciones | Resultado |
| --- | --- |
| npm ci --no-audit --no-fund | Exit 0, 99 paquetes del lock existente; sin nuevas dependencias ni npm audit |
| npm run typecheck | Exit 0, strict/NodeNext |
| npm run build | Exit 0 |
| npm test | **73/73**, cero fallos/cancelaciones/skips |
| Casos conservados | 69 anteriores sin cambiar expectativas |
| Nuevos casos | Cuatro: H01, H02 y dos de presencia/undefined/null |
| git diff --check | Sin errores; revisión adicional de archivos nuevos |

El subconjunto previo al arreglo reportó dos fallos y dos éxitos, reproduciendo los defectos y diferenciándolos de las brechas de evidencia. La suite final incluye tests sobre Express 5 real y compilación TypeScript de un fixture en memoria; no se sustituyen por inspección de strings de implementación.

Las 46 pruebas de etapas anteriores y sus fuentes permanecen intactas: health 200/JSON exacto, CORS legacy, errores legacy, app/default export sin listener al importar, arranque local y conexión Mongoose aislada. No se cambió ninguna dependencia, package/lock, ESM NodeNext o configuración de despliegue. No se ejecutó un Preview ni se repitió el diferencial histórico externo 13/13.

## 8. Riesgos residuales y dependencias

- BE-02: IDs/BSON/relaciones físicas siguen pendientes; no se crearon modelos ni schemas definitivos.
- BE-03: aprobar schemas, DTOs, coerciones, campos extra, rangos y semántica de errores antes de conectar a negocio. Los ejemplos de prueba no constituyen acuerdos.
- BE-08: debe traducir la representación interna al status/DTO público, tratar parsers, límites y demás políticas. Con el handler legacy sin adaptar, estos errores se tratarían como 500; no se aplica el middleware a rutas reales en esta etapa ni se altera health.
- Los esquemas son código confiable; deben evitar efectos secundarios y salidas mutables compartidas. No se añade congelamiento profundo de Date/Map u otros tipos arbitrarios, ni validación de negocio en el accessor.
- Límites de payload/cardinalidad y timeouts/cancelación async deben acordarse en sus etapas; las pruebas locales no certifican rendimiento universal ni Vercel serverless.

## 9. Archivos y recomendación

Cambios de auditoría: src/middlewares/validate-request.middleware.ts, src/errors/request-validation.error.ts, test/request-validation.test.js, README.md e INFORME_BE07_2_VALIDACION_REQUESTS.md; nuevo INFORME_BE07_2_AUDITORIA.md. Delta completo BE-07.2: estos seis archivos, sin el informe local BE-05.

**Recomendación:** lista técnicamente para commit revisado y futuro PR Draft encadenado a feature/be-07-mongoose-zod, sujeto a autorización de publicación y revisión del equipo. No lista para declarar BE-07 Done o exponer contratos de negocio. Antes de publicar verificar la base y el posible autodeploy. Sin cambios de rama, commit, push, PR, deploy, Atlas, frontend/IoT ni inicio de BE-08.
