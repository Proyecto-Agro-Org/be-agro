# ADR BE13-09 — Autorización de operadores

## Estado

Aceptado para la implementación offline. El proveedor de identidad y el mapeo rol→capacidad quedan **pendientes de decisión humana**.

## Contexto

BE13-08 dejó `transition` y `replay` sin definir quién los autoriza. Sin endpoints ni IdP aprobado, la autorización no puede depender de un mecanismo concreto (JWT, OIDC, Firebase), pero sí debe impedir que cualquier código o dato del llamador se autoasigne permisos.

## Decisión

1. **Puerto `OperatorAuthorizationPort`** inyectado en el bootstrap; la credencial es opaca.
2. **Deny por defecto**: el placeholder `createDenyAllOperatorAuthorization` deniega todo y marca readiness `BLOCKED`.
3. **Capacidades explícitas** (8, vocabulario cerrado), una por operación; sin roles en el código.
4. **Realm scope**: el principal debe listar el realm del bootstrap; el servicio lo revalida aunque el puerto diga `allow`.
5. **Fail-closed**: excepción, timeout (5 s) o respuesta inválida → deny.
6. **Toda denegación se audita y se cuenta**, sin incluir la credencial.
7. **Evidencia estructurada declarada** (`DECLARED_UNVERIFIED`): tipo de un vocabulario cerrado y referencia segura; el tipo aceptado depende de la operación y de la clase de fallo.
8. **CAS por versión** y **lease `REPLAYING`** para que dos operadores no puedan producir estados imposibles.

## Alternativas descartadas

- Roles en el código (`admin`, `operator`): acopla la política de negocio al backend.
- Leer capacidades desde la credencial: autoasignación trivial (V1).
- `BLOCKED→RESOLVED`: permitiría resolver entradas bloqueadas por seguridad (H3).
- Locks pesimistas o TTL de lease: requieren reloj/scheduler y política de expiración no decidida.

## Consecuencias

- Ninguna operación es posible en runtime hasta inyectar un puerto real revisado.
- La verificación de la evidencia (tickets, aprobaciones) queda fuera del sistema.
- Un lease huérfano requiere `releaseLease` manual.

## Decisiones humanas pendientes

Proveedor de identidad; mapeo rol→capacidad y titulares; separación de funciones (p. ej., quien descarta ≠ quien resuelve); verificación de evidencia; política de expiración de leases; si una entrada bloqueada por seguridad puede resolverse alguna vez.
