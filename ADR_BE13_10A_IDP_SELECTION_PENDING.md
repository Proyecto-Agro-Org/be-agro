# ADR BE13-10A — Selección del proveedor de identidad (PENDIENTE)

## Estado

**Pendiente de decisión humana.** Este ADR fija el contrato y lo que cualquier proveedor deberá cumplir; no elige proveedor.

## Contexto

BE13-09 autoriza operaciones mediante un puerto. Sin un proveedor aprobado, solo existen el placeholder deny-all y autoridades sintéticas de prueba. BE13-10A separa identidad (quién es) de mapeo (qué puede) y de SoD (qué combinaciones se permiten).

## Decisión técnica tomada (no de negocio)

1. Contrato `OperatorIdentityProvider` con credencial opaca e identidad sin capacidades.
2. Placeholder bloqueante por defecto; readiness `BLOCKED`.
3. Ningún proveedor implementado (ni Auth0, Okta, Azure AD, Google, Cognito, Keycloak ni otro).

## Opciones a evaluar (sin preferencia)

| Opción | A considerar |
| --- | --- |
| IdP corporativo existente (OIDC/SAML) | integración con cuentas del equipo, MFA, offboarding |
| IdP gestionado (SaaS) | costo, residencia de datos, disponibilidad |
| IdP propio | costo operativo y de seguridad |
| Reutilizar la autenticación de la app actual (BE-09) | separación entre usuarios finales y operadores |

## Requisitos para cualquier adapter futuro

- Validar la credencial con el mecanismo del proveedor (firma, emisor, audiencia, expiración) usando su SDK o un estándar, no código criptográfico propio.
- Devolver `subject` opaco en el charset del audit (sin emails directos).
- Devolver atributos afirmados por el proveedor (grupos, roles), nunca copiados del request.
- No registrar tokens ni secretos; secretos de cliente gestionados fuera del repo.
- Campaña de pruebas propia con el proveedor real en un entorno autorizado.

## Consecuencias

Hasta decidir: ninguna operación de cuarentena es posible fuera de las pruebas.
