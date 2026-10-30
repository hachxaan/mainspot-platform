# Evidence — INC-001

Esta carpeta contiene la **evidencia reproducible** del incremento (AC-009).

Regla canónica (`06-ACCEPTANCE-EVIDENCE.md`): no se acepta evidencia basada solo en afirmaciones; cada archivo aquí es salida real de un comando documentado en el README.

## Regenerar

```bash
npm run evidence    # scripts/capture-evidence.sh
```

## Contenido esperado tras una captura

| Archivo | Evidencia |
|---|---|
| `00-environment.txt` | entorno (node/npm/docker/git) |
| `01-typecheck.txt` | validación estática |
| `02-permission-matrix.txt` / `permission-matrix.md` | AC-001 (matriz de permisos) |
| `03-unit-tests.txt` | unit (RBAC, JWT, audit, logger) |
| `04-db-up.txt` | postgres up |
| `05-db-setup.txt` | migraciones + seed |
| `06-integration-tests.txt` | AC-001/002/003 + hooks (2 tenants) |
| `07-smoke.txt` | AC-009 + señales AC-008 |
| `08-denied-cross-tenant.log` | AC-002 (denegaciones auditadas) |
| `09-audit-export-client-a.json`, `10-audit-export-client-b.json` | AC-003 (eventos + correlación) |
| `11-rollback-simulate.txt` / `rollback-report.md` | AC-009 (rollback simulado) |
| `12-summary.txt` | resumen PASS/FAIL |

## Telegram — Starlink persistente

`telegram-webhook-starlink.txt` contiene salidas sanitizadas de servicios, rutas,
HTTP, recuperación y pruebas de esta instalación. Runbook y bloqueos:
[`docs/architecture/telegram-webhook-starlink.md`](../docs/architecture/telegram-webhook-starlink.md).
No acredita entrega KVM → Express ni Telegram real; ambos requieren la evidencia externa pendiente.
`e2e-dev-e2e-02.txt` registra el E2E simulado actualizado, incluida la reentrega tras reiniciar.
Nunca guardar tokens, encabezados secretos, cuerpos de mensajes o archivos WireGuard aquí.
Las pruebas usan `mainspot_test` en PostgreSQL de desarrollo (`127.0.0.1:55432`), no la BD activa `mainspot_dev`.
