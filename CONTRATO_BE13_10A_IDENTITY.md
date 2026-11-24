# BE13-10A — Contrato de identidad de operadores

Fuente: `src/iot/operations-security-policy.contracts.ts`, `src/services/operations-security-policy.service.ts`.

## Puerto

```ts
interface OperatorIdentityProvider {
  identify(request: { credential: unknown; realm: TrustGateRealm }): Promise<
    | { status: 'authenticated'; identity: AuthenticatedOperatorIdentity }
    | { status: 'denied'; reason: 'unauthenticated' | 'realm-out-of-scope' }>;
}
interface AuthenticatedOperatorIdentity {
  realm: TrustGateRealm; subject: string; issuer: string; authenticationReference: string;
  attributes: { name: string; value: string }[];   // afirmados POR EL PROVEEDOR
}
```

## Reglas

1. La credencial es **opaca** y solo la lee el proveedor. El bundle nunca toma roles, capacidades, realm, subject ni atributos de la credencial o del request (I03, I04, X1).
2. La identidad **no contiene capacidades**: un proveedor que devuelva `capabilities`, `roles` u otro campo no previsto es una respuesta malformada (esquema estricto) → `unauthenticated` (I04).
3. `subject`, `issuer` y `authenticationReference`: `[A-Za-z0-9:_./-]{1,128}` (charset del audit). Atributos: nombre `^[a-z][a-z0-9_.:-]{0,63}$`, valor 1–256, máximo 32.
4. Realm: la identidad debe declarar el realm del bundle; si no, `realm-out-of-scope` (I05).
5. Excepción, timeout (5 s), respuesta malformada o getter hostil → `unauthenticated` (I07, I08, X10). Las respuestas se copian (Zod): mutarlas después no cambia el principal.
6. Default: placeholder `identityProvider` de `createBlockingSecurityPolicies()` → siempre `unauthenticated`.

## Principal resultante

`{ operatorId: subject, realms: [realm del bundle], capabilities: (del mapeo), authenticationReference }`, congelado.

## Fuera de alcance (decisión humana)

Selección del IdP (Auth0, Okta, Azure AD, Google, Cognito, Keycloak u otro), protocolo (OIDC/SAML), validación de tokens y firmas, gestión de claves, MFA, sesión y revocación. No se implementa ninguno. Ver `ADR_BE13_10A_IDP_SELECTION_PENDING.md`.
