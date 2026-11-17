# Recuperación selectiva BE-09 sobre dev consolidada

Fecha: 17/11/2026. Alcance: recuperar BE-09.0/09.1 y preparar su integración,
sin autenticación real, modelos definitivos, endpoints nuevos ni BE-09.2.
Este informe registra la preparación validada; el PR y la evidencia final de la
operación registran su publicación/merge. No se declara BE-09 Done.

## 1. Estado inicial y base

`origin/dev` comprobada tras fetch en
`636c71731ee100f78c76c78b46753ccf1223ac39`, merge del PR #10. BE-02…08 ya son
ancestros y su contenido está integrado; BE-02/03/04 siguen siendo propuestas.
`main` permanece en `1bb20f76b7a739f42c75b37b9a64315276560ec1`.

Dos worktrees iniciales:

- Original: `feature/be-09-autenticacion-analisis`, HEAD
  `63c7eb20882e1e63e9ed03e2b6afa0a91e124afc`; diez entregables BE-09 untracked y
  el informe BE-05 untracked. Sin cambios tracked ni staged.
- Consolidación: `.local-consolidacion/worktree`, rama `integration/be-02-a-be-08`,
  HEAD `b45a619906ce5f26a1301fd34c1eb0471154b283`, limpio e integrado vía #10.

Se creó un tercer worktree `.local-consolidacion/be09-sobre-dev`, rama
`feature/be-09-infraestructura-sobre-dev`, directamente desde `origin/dev`.
Se quitó el upstream heredado de dev; una publicación debe nombrar esta feature.
No se cambió de rama, rebaseó ni fusionó nada en el árbol original.

## 2. Protección y respaldo

Se verificaron por tamaño y SHA-256 los once originales y sus once copias en:

```text
C:\Users\CamilaGonzález\be-agro\.local-consolidacion\respaldos\20261117-be09\
```

Los bundles `historial.bundle` e `integracion-validada.bundle` aprobaron `git bundle
verify`; preservan las referencias previas y la consolidación. Se inventariaron
por hash los 19 archivos existentes bajo respaldos al iniciar esta recuperación.
No había cambios posteriores al respaldo, por lo que no fue necesario reemplazar
copias ni recrear los originales. La evidencia nueva se guarda por separado en
`.local-consolidacion/recuperacion-be09-evidencia/`.

El informe `INFORME_BE05_VERCEL_DEPLOYMENT.md` permanece exclusivamente local e
intacto, SHA-256 `6445dc2925627e49f9c8eee03bad3df67362761dc155dd4e9df422a6280a5e5d`.
No se borró archivo alguno, ni se usó reset hard, clean o force push.

## 3. Archivos recuperados y excluidos

Se copiaron exclusivamente estos diez archivos, verificando el hash de cada copia
contra el original. Ninguna ruta existía en dev: no se sobrescribió código previo.

| Archivo | Contenido |
|---|---|
| INFORME_BE09_ANALISIS_AUTENTICACION.md | Investigación BE-09.0, evidencia y actualización BE-09.1 |
| MATRIZ_BE09_AUTENTICACION_AUTORIZACION.md | 52 requisitos, 30 escenarios y cobertura real/parcial/pendiente |
| INFORME_BE09_1_INFRAESTRUCTURA_AUTORIZACION.md | Arquitectura y límites de la implementación original |
| INFORME_BE09_1_AUDITORIA_SEGURIDAD.md | Hallazgos originales, correcciones y riesgos residuales |
| src/auth/contracts.ts | Tipos nominales y puertos de proveedor/identidad/pertenencia/sesión/recursos |
| src/auth/validation.ts | Validación runtime de salidas y sanitización de fallos |
| src/services/authorization.service.ts | Emisión y comprobación privada de identidad y scope |
| src/middlewares/request-authorization.middleware.ts | Contexto por request, Bearer y control de vigencia/concurrencia |
| src/repositories/client-scoped.repository.ts | Lectura de referencias acotada al cliente y validación de jerarquía |
| test/authorization.test.js | 40 pruebas, adaptadores simulados confinados al test |

Se añade este informe. Se actualizan README y el estado del plan para distinguir
la consolidación ya integrada de su preparación histórica y explicar BE-09 actual.
Los diez recuperados se conservan byte a byte, incluyendo sus registros originales:
su base histórica BE-08 y frases «sin publicación» describen aquella ejecución;
no son el estado actualizado de esta recuperación.

Excluidos: informe BE-05 local, documentacion-referencia, .env, node_modules, dist,
backups, herramientas/evidencia de auditoría, versiones antiguas de archivos dev
y entregables ajenos. No cambian package/lock, tsconfig, Vercel ni configuración
remota o laboral. No se trasladan frontend/IoT ni datos reales.

## 4. Comparación y resolución semántica

No se hizo merge completo de la rama antigua. Esta no tenía commits BE-09 propios:
el trabajo era untracked sobre BE-08. Un merge de su HEAD no recuperaría esos archivos.
Se seleccionaron las diez rutas verificadas y se creó una rama desde dev consolidada.

El código y configuración runtime de dev son idénticos a la base BE-08 original;
se comprobó por Git antes de copiar. Por ello los seis archivos fuente/test nuevos
no exigieron ajustes. No hubo conflictos ni regresiones de código que corregir.
README/plan se actualizaron semánticamente, preservando el historial de consolidación
y sin sustituir documentos BE-02/03/04 por versiones antiguas.

No se pierden UUID, logging sanitizado, fronteras de error ni 404 no reflectante.
El perfil HTTP completo continúa optativo y los contratos propuestos BE-03 no se
activan automáticamente. Ningún DTO, normalizador o esquema físico pendiente se
convierte en aprobado por incorporar la infraestructura.

## 5. Validaciones ejecutadas sobre el nuevo worktree

| Control | Resultado |
|---|---|
| npm ci --no-audit --no-fund, timeout/reintentos acotados | Aprobado, 99 paquetes desde lock, sin nuevas dependencias |
| npm run typecheck | Aprobado |
| npm run build | Aprobado |
| npm test completo | **160/160**, 120 anteriores y 40 BE-09; cero fallos/canceladas/omitidas |
| git diff --check y revisión equivalente de archivos nuevos | Aprobado |
| Diferencial HTTP real contra dev 636c717 | **13/13 compatibles**, sin regresiones |
| Recuperación byte a byte | Diez archivos coinciden con originales y manifest |
| Grafo AST de src/scripts | 26 módulos, sin ciclos ni any explícito; sin import de test desde producción |
| Alcanzabilidad desde app default | Ningún módulo nuevo de autorización alcanzable |

El diferencial reconstruyó en memoria 13 módulos de dev y contrastó status/body/
headers contractuales con el compilado recuperado: GET/HEAD health, cinco variantes
de Origin/allowlist, sin Origin, OPTIONS, 404 y 500 sintético. Los dos 404 ya están
endurecidos en dev; ahora son equivalentes. No se introdujeron de nuevo los dos
cambios históricos ni se restauró la respuesta insegura. UUID dinámicos se excluyen
de igualdad de valores; su aislamiento y logging están cubiertos por la suite.

La herramienta local del diferencial necesitó conservar imports nativos `node:`
al reconstruir BE-08. Fue un ajuste del verificador aislado, no un defecto del
backend ni una modificación del contrato o de los tests del proyecto.

## 6. Seguridad y garantías

Las capacidades tienen procedencia en WeakMaps privados por instancia, además de
marcas TypeScript. Se rechazan objetos/copies arbitrarios, scopes de otra instancia,
headers de identidad públicos, credenciales malformadas y outputs extra de puertos.
La pertenencia se resuelve en un puerto confiable, no desde body/query/header.

Cada request mantiene identidad/contexto independiente y lease de vigencia; se
descartan resultados async obsoletos, expirados o terminados. Las lecturas incluyen
cliente/IDs/padres y verifican su resultado; no se implementan queries Mongo reales.
Los fakes y las rutas probe existen solo en tests. Health sigue público 200 con
JSON exacto y sin Mongo; login/demo/probe no aparecen en la app real.

La suite preserva CORS, sanitización de errores/logging BE-08 e independencia de
Atlas/imports/listener. No hay Google simulado, tokens propios ni bypass montado
en producción. No se usaron usuarios, credenciales, datos ni conexiones Atlas reales.

**BE-09.1 es infraestructura interna, no autenticación productiva completa.**
Los puertos todavía necesitan implementación/verificación real; validar la forma
de un output no prueba una firma, identidad o relación persistida. No se promete
cancelación/timeout universal ni revocación remota inmediata en un request en vuelo.

## 7. Integración propuesta y controles

Se propone commit de recuperación sobre dev, push de esta feature y PR hacia dev,
sin incorporar commits antiguos adicionales ni hacer squash del historial previo.
Antes de fusionar se deben comprobar base/head, diff exclusivamente BE-09 y sus
actualizaciones documentales, checks/revisiones/protecciones vigentes y permisos.
No usar un push directo a dev para eludir revisiones; detener si falta un control.

Production Branch=main procede de la confirmación del usuario en la integración
anterior. No se deduce solo del nombre de rama; la inspección disponible entonces
no encontró workflows/webhooks del repo que promocionaran dev. La configuración
interna de Vercel no fue inspeccionada directamente ni se certifican todos los
automatismos externos. No se cambia main ni se hacen deploys manuales o promociones.
Push/PR/merge pueden activar Preview de la integración Git ya conocida.

Tras merge: verificar SHA dev, padres del merge, igualdad del tree con el head
validado y ascendencia del commit de recuperación. Guardar evidencia final sin
modificar los originales ni descartar su respaldo. No se declara Done ni BE-09.2.

## 8. Inventario de retirada y preservación

El inventario definitivo se prepara después de integrar, con cada referencia local
y remota: SHA, ascendencia/conteo de commits únicos frente a dev, worktree/status,
respaldo y PR abierto que todavía necesite head/base. **No se elimina ninguna rama.**

Candidatas previsibles: feature BE-02…08 y la integración BE-02…08, siempre que
sus SHA sigan integrados. Las ramas locales asociadas a worktrees no deben retirarse
sin gestionar esos árboles en otra tarea. La antigua BE-09 debe conservarse mientras
mantenga los once untracked, aunque sus copias estén integradas; no borrar archivos
para «limpiarla». La feature recuperada debe conservarse mientras su worktree esté
en uso. main/dev nunca son candidatas. Las ramas backup históricas quedan fuera
del alcance de eliminación y se conservan.

## 9. Pendientes para una futura BE-09.2

Definir proveedor real, issuer/audience y verificación, transporte/ciclo de sesión,
revocación/logout/recuperación, catálogo confiable usuario-cliente y presupuesto
de I/O. Resolver BSON/correlación/propiedad histórica BE-02 con acceso autorizado,
contratos y errores BE-03/FE y problemas de sesión del frontend ya documentados.
Implementar/adaptar esos puertos y wiring solo en una tarea aprobada, con pruebas
de aislamiento real y Preview funcional identificado. No se inicia ese trabajo aquí.
