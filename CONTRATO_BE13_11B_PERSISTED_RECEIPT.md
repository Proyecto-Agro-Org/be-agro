# BE13-11B — Contrato del receipt de persistencia

```ts
interface PersistedBrokerDeliveryReceipt {
  inboxId: string;               // ^ib_[0-9a-f]{32}$ (generado por el store)
  realm: TrustGateRealm;
  rawPersistedAt: number;        // $$NOW del servidor (ms)
  rawPayloadSha256: string;      // sha256 de los bytes exactos
  rawPayloadBytes: number;
  provenanceFingerprint: string; // vínculo de la identidad verificada con el contexto y los bytes
}
```

## Reglas

- Lo emite **solo** el store, después de la escritura con majority + j y la relectura majority. No incluye el payload.
- La admisión valida el receipt con un esquema estricto y comprueba que coincida con lo que verificó: realm, sha, cantidad de bytes y `provenanceFingerprint` recomputado. Un receipt malformado, ajeno o hostil se trata como `broker-inbox-unavailable` (transitorio) y no hay procesamiento (D17/D18).
- **El receipt no autoriza nada.** El procesamiento usa solo su `inboxId` y relee el registro (majority, filtrando por realm), recomputando la integridad. Un receipt forjado no sirve: un id inexistente da `broker-inbox-not-found` (A01), y un `rawPersistedAt` falso nunca se lee del receipt.
- No se usó un registro WeakSet porque la relectura obligatoria del registro protege más. Esto protege frente a errores del proceso, no frente a código hostil con acceso directo a la base de datos o a los módulos internos (`INFORME_BE13_11B_AUDITORIA_SEGURIDAD.md`).

## Resultados de `admit`

| Modo | Resultado |
| --- | --- |
| `persist-only` | `{ status: 'persisted', receipt }` |
| `persist-and-process` | `{ status: 'ingested', …, receipt }`. Se procesa desde el registro persistido, igual que una recuperación |
| cualquier rechazo | `{ status: 'rejected', reasonCode, retryClass, retryable, payloadFingerprint }` |
| modo desconocido | `broker-context-malformed`, sin persistir |
