# BE-06.1 — Auditoría de arquitectura por capas

**Fecha:** 16/11/2026, America/Buenos_Aires. **Resultado:** apta técnicamente para preparar un commit del alcance BE-06 y un futuro PR encadenado. Sin publicación en esta tarea. BE-06 no está Done; Preview Vercel de BE-05, revisión e integración permanecen pendientes.

## 1. Alcance, Git y fuentes

- Rama conservada: `feature/be-06-arquitectura-capas`. Origin: `https://github.com/Proyecto-Agro-Org/be-agro.git`.
- Identidad local comprobada: Camila Gonzalez / `camiiigonzalez1503@gmail.com`; usuario HTTPS configurado `camiegonzalez`. El conector GitHub confirmó login `camiegonzalez`. No se cambió configuración ni se usaron credenciales laborales.
- `git fetch origin` satisfactorio. HEAD, rama local BE-05, `origin/feature/be-05-preparacion-typescript` y merge-base coinciden en `e2c19c38cf2ad8f40c98aaff5d8248a561ccb474`. No hay commits exclusivos de BE-06 todavía; su implementación está en el árbol de trabajo, sin staging.
- Comparación exclusivamente contra ese SHA BE-05, incluidos untracked. Los commits exclusivos de BE-02 (`28556ff…`), BE-03 (`c2a4b31…`) y BE-04 (`b2deb9b…`) no son ancestros de HEAD. No se copiaron sus documentos; schema y diagrama base permanecen intactos.
- Revisados AGENTS.md, IMPLEMENTATION_PLAN.md, ESPECIFICACION.md, DEFINITION_OF_DONE.md, README, informe BE-06, nueve fuentes TypeScript de src/scripts y los tres archivos de tests. Los estados JS/ramas del relevamiento BE-00/01 son históricos; no sustituyen la evidencia actual ni autorizan decisiones de negocio pendientes.
- Preexistía `INFORME_BE05_VERCEL_DEPLOYMENT.md` sin seguimiento, ajeno al delta BE-06. Se preservó sin editar; SHA-256 `6445DC2925627E49F9C8EEE03BAD3DF67362761DC155DD4E9DF422A6280A5E5D`, coincidente con el respaldo documentado en BE-06. Debe excluirse del futuro commit de arquitectura.

## 2. Arquitectura comprobada y proporcionalidad

```text
scripts/start.ts → app.ts (composición)
                    ├─ config/cors.ts → middleware CORS por instancia
                    ├─ health.routes.ts → health.controller.ts → health.service.ts
                    │                         └─ GetHealthResponse (tipo)
                    └─ legacy-error.middleware.ts (registrado al final)
```

| Responsabilidad | Evidencia y evaluación |
| --- | --- |
| Route | Factory de Router, solo declara GET /health y enlaza el controller; sin negocio ni persistencia |
| Controller | Obtiene el resultado del service, construye explícitamente GetHealthResponse y devuelve HTTP 200; no consulta datos |
| Service | Función de liveness sin imports, sin Express/HTTP, entorno, Atlas ni efectos externos; devuelve un resultado independiente por llamada |
| DTO | Contrato estático de presentación con `status: 'ok'`, separado del resultado interno del service; no se afirma validación runtime. Request no aplica porque no consume params/query/body |
| CORS | Parseo en config, política en middleware y Set recibido por cada factory. Sin nuevo caché global; se mantiene la lectura del entorno al crear la app |
| Errores | Handler Express de cuatro argumentos conserva statusCode, logging y cuerpos string legacy; ubicado después de rutas |
| Composición | App conserva x-powered-by deshabilitado, orden CORS → router → errores, factory y export default, sin listen |

La granularidad es mayor que la necesaria para un health aislado, pero es proporcionada al objetivo explícito de establecer las capas: siete módulos pequeños con funciones reales, sin interfaces de repositorio artificiales, contenedores DI, clases base ni archivos vacíos. No conviene añadir más capas a health. La duplicación mínima del literal `ok` entre el resultado interno y el DTO es intencional: mantiene el contrato HTTP fuera del service sin un mapper adicional innecesario.

No hay repository/model porque no hay persistencia; adapters y mappers de dominio se crearán al existir requisitos aprobados. El alcance incremental satisface la separación aplicable del plan; no acredita ya implementadas sus capas de negocio futuras.

## 3. Hallazgos, correcciones y límites heredados

**Defectos nuevos demostrados:** ninguno. No se modificaron fuentes, tests ni expectativas durante BE-06.1. No se detectó una brecha concreta que justificara agregar pruebas permanentes; se conservaron las 21 existentes. El único archivo creado por esta auditoría es este informe, además de referencias documentales BE-06 en README e informe de implementación.

Observaciones que no requieren alterar el comportamiento en esta etapa:

- `ReadonlySet` es una garantía estática; el dueño de un Set compartido todavía podría mutarlo desde fuera. BE-05 ya tenía ese comportamiento. La prueba de instancias independientes utiliza configuraciones distintas, no certifica inmutabilidad profunda.
- El cast de `LegacyError` no valida objetos arbitrarios, códigos inválidos ni todos los casos posibles del error handler. El logging heredado registra el error completo; no se afirma sanitización universal de logs. El endurecimiento, headersSent, errores uniformes y 404 JSON requieren el trabajo y contrato de BE-08. No se cambian aquí para mejorar artificialmente los resultados.
- Importar app construye la instancia default y lee CORS_ORIGINS, como en BE-05. No es ausencia absoluta de efectos; lo comprobado es que no inicia listeners ni introduce conexiones externas. El listener sigue únicamente en scripts/start.ts.
- Las pruebas de service verifican resultado observable y ausencia de estado compartido entre resultados; las de router/errores hacen HTTP real. No se usan assertions del texto de los módulos o del número de llamadas entre capas para simular una garantía arquitectónica.

## 4. TypeScript, dependencias y despliegue

Node local `24.19.0`, npm `11.17.0`; strict, NodeNext/NodeNext, ESM, imports relativos `.js` e imports de tipos conservados. No se añadió `any`, suppressions ni dependencia circular. Análisis de imports mediante AST de TypeScript: nueve módulos de src/scripts, referencias locales resueltas, cero ciclos. También se verificaron las referencias del JS emitido.

Runtime externo de las fuentes: únicamente express y cors. `npm ls --omit=dev --depth=0` confirma Express `5.3.0` y cors `2.8.6`. Package, lock, tsconfig, scripts/start.ts, vercel.json y los dos archivos de tests BE-05 están sin cambios respecto del SHA base. No se instalaron nuevas dependencias; npm ci reinstaló las existentes del lock.

La exportación default sigue siendo una aplicación Express callable: se la importó y atendió GET /health en un listener local efímero, obteniendo 200, cuerpo exacto y sin x-powered-by. La suite también comprueba que un proceso hijo termina al importar la app sin iniciar servidor y verifica el arranque real del listener compilado. No hay duplicación de listen introducida por la modularización.

Compatibilidad técnica local con BE-05 demostrada; compatibilidad efectiva con Vercel **pendiente**. No se ejecutó vercel build ni Preview, no se inspeccionaron settings remotos ni se probó runtime Linux/serverless. Entrada prevista src/app.ts, export default, preset y scripts están preservados. Vercel no se supone equivalente a ejecutar npm start como servidor permanente: quedan por comprobar build efectivo, versión Node, empaquetado, HTTP y CORS en Preview autorizado. No se declara aprobado el Preview BE-05.

## 5. Validaciones repetidas

| Comando o comprobación | Resultado |
| --- | --- |
| `npm ci --no-audit --no-fund` | Exit 0, 80 paquetes; flags omiten audit/funding, no reproducibilidad. No se ejecutó npm audit |
| `npm run typecheck` | Exit 0, sin errores |
| `npm run build` | Exit 0 |
| `npm test` | Exit 0: **21/21**, cero fallos, cancelaciones o skips; descubrimiento de los tres archivos |
| Arranque compilado | Cubierto por tests: PORT=0, health 200, .env sintético/precedencia y PORT inválido |
| Exportación default | GET health local 200, JSON exacto, x-powered-by ausente |
| Diferenciales contra BE-05 | **13/13** equivalentes |
| `git diff --check` | Sin errores; revisión adicional del whitespace de archivos nuevos |
| Exclusiones y revisión acotada de secretos | dist, node_modules, .env y documentacion-referencia excluidos; sin patrones evidentes de tokens, claves privadas o URI Mongo con credenciales en el alcance revisado |

Las 18 pruebas BE-05 siguen intactas. Las tres añadidas en BE-06 comprueban service aislado/resultados independientes, router con montaje prefijado y límites GET/HEAD/métodos, y propagación de errores async Express 5 con respuesta legacy y diagnóstico interno. No hay consultas Atlas ni datos reales.

### Comparación HTTP

Se leyó la fuente BE-05 desde el SHA fijo con git show; se transpiló en memoria mediante TypeScript ya instalado y se resolvieron sus imports express/cors a las mismas dependencias. Se ejecutaron factories anterior y modular en listeners separados sobre loopback y puertos efímeros. No se editó el baseline ni se alteraron sus handlers.

Comparación exacta de status, texto de cuerpo y headers Content-Type, Access-Control-Allow-Origin/Methods/Headers/Credentials, Vary y x-powered-by. Date y otros headers volátiles no forman parte de esta comparación. Cada listener creado se cerró.

| Escenario | Resultado en ambas versiones |
| --- | --- |
| GET health sin Origin | 200, `{"status":"ok"}` |
| HEAD health | 200, cuerpo vacío |
| Origin permitido | 200, allow-origin idéntico |
| Origin ajeno | 403 legacy, sin allow-origin |
| Origin con barra final | 403 legacy |
| Origin con puerto explícito | 403 legacy |
| Origin con sufijo de dominio | 403 legacy |
| Wildcard | 200, Origin reflejado, sin credentials |
| Allowlist vacía con Origin | 403 legacy |
| Preflight | 204, headers equivalentes |
| Ruta desconocida | 404 HTML |
| POST health | 404 HTML |
| Error sintético interno | 500 legacy; un diagnóstico por app |

Es una comparación de la superficie documentada, no una garantía universal de equivalencia. El error se provocó con un Set sintético que lanza al consultarlo, sin añadir endpoints a la implementación.

## 6. Inventario final frente a BE-05

**Modificados:** README.md y src/app.ts. **Nuevos BE-06:** INFORME_BE06_ARQUITECTURA_CAPAS.md, INFORME_BE06_AUDITORIA.md, src/config/cors.ts, src/controllers/health.controller.ts, src/dto/health.dto.ts, src/middlewares/cors.middleware.ts, src/middlewares/legacy-error.middleware.ts, src/routes/health.routes.ts, src/services/health.service.ts y test/health-layers.test.js. **Eliminados/renombrados:** ninguno. Total previsto para el futuro commit BE-06: 12 archivos.

**Fuera del commit BE-06:** INFORME_BE05_VERCEL_DEPLOYMENT.md, untracked previo preservado. No usar git add indiscriminado. El análisis acotado de secretos no certifica todo el historial ni sustituye revisar nuevamente el staging antes de publicar.

## 7. Preparación del PR encadenado

Origen previsto: `feature/be-06-arquitectura-capas`. Destino previsto: `feature/be-05-preparacion-typescript`, que existe en origin y mantiene el SHA esperado tras fetch.

Hoy las dos referencias apuntan al mismo commit: una comparación entre ramas sería vacía, porque BE-06 no tiene commit. Una vez revisados y guardados exclusivamente los 12 archivos del alcance, el PR encadenado podrá mostrar el delta BE-06 sin volver a incluir el cambio JavaScript → TypeScript. No se creó el commit ni el PR en esta tarea.

Antes de publicar: revisar staging explícito y autor/committer, volver a comprobar SHA de la base y condiciones de Vercel. Un push o abrir el PR puede activar autodeploy, como ocurrió en BE-05. Una confirmación verbal del bloqueo no reemplaza evidencia del ajuste efectivo. La publicación y cualquier deployment requieren su autorización correspondiente.

Integrar posteriormente BE-06 en la rama BE-05 actualizaría también el contenido revisado por el PR #5; debe coordinarse con el equipo. Si BE-05 se integra primero, revisar el destino adecuado y el diff resultante antes de retargetear. No se propone reescribir ni forzar historial automáticamente.

### Título recomendado

`BE-06 — Arquitectura por capas y health modular (encadenado a BE-05)`

### Descripción recomendada para futuro PR Draft

> Base: feature/be-05-preparacion-typescript. Este PR contiene únicamente el delta BE-06; depende del PR #5 todavía sin integrar.
>
> Se separa la composición Express en configuración CORS, middleware CORS y handler legacy, y GET /health en router → controller → service con GetHealthResponse. No hay entrada consumida para health, ni repository/model porque no utiliza persistencia. Factory/default export y listener local se conservan.
>
> Validación local: npm ci desde lock, typecheck/build correctos, 21/21 pruebas, 13/13 escenarios HTTP equivalentes contra e2c19c38cf2ad8f40c98aaff5d8248a561ccb474 y git diff --check sin errores. Health sigue público con 200 y JSON exacto; CORS, errores 403/500, HEAD, 404 y headers contractuales se preservan. Auditoría BE-06.1 sin defectos funcionales demostrados.
>
> Sin nuevas dependencias, modelos, Atlas, autenticación, Zod ni endpoints de negocio. No se incorporan cambios exclusivos de BE-02/03/04 ni el informe local de deployment BE-05.
>
> Preview Vercel, revisión e integración pendientes; no declarar BE-05/BE-06 Done ni fusionar automáticamente. Publicar puede activar autodeploy: verificar y autorizar previamente el alcance de despliegue. Las limitaciones heredadas del handler legacy y la validación runtime se resolverán en sus etapas.

## 8. Criterios pendientes y recomendación

Lista técnicamente para commit revisado y preparación de PR Draft encadenado, **no para publicación automática ni cierre Done**. No hay bloqueantes locales demostrados dentro de BE-06. Falta autorización de publicación con riesgo de autodeploy controlado, revisión del equipo, validación Preview de BE-05 e integración coordinada. Las decisiones Atlas/contratos/unidades permanecen en BE-02/03/04; no bloquean health modular y sí condicionan recursos futuros.

Se detiene esta auditoría sin cambiar de rama, crear commits, hacer push/PR/merge, desplegar, modificar settings, acceder a Atlas, instalar paquetes nuevos ni iniciar BE-07.
