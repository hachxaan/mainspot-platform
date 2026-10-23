# HDC-0001 — Servicio persistente con arranque automático

| Campo | Valor |
| --- | --- |
| Fecha | 2026-10-20 |
| Estado | `REQUIERE_DECISION` (aplicado en MainSpot) |
| Clase | Contradice `CANONFLOW_HDC_DEFINITION.md` §12 |
| Solicitud | Mantener HDC disponible de forma persistente para responder sesiones sin arrancarlo manualmente |

## Problema observado

HDC solo se ejecuta mientras vive el proceso lanzado por bootstrap o por el CLI
(`start`, `stop`, `status`, `restart`). No se reinicia tras un fallo ni arranca con
el equipo; tras cerrar sesión o reiniciar, las sesiones pendientes quedan
inaccesibles hasta relanzarlo.

## Causa raíz

Es comportamiento definido: §12 exige desacoplar el proceso «sin shell,
autoreloader, servicio de sistema ni supervisor residente». CanonFlow no ofrece
un modo de servicio.

## Cambio en MainSpot

Unidad systemd de usuario `mainspot-hdc.service`, versionada como
[`artifacts/mainspot-hdc.service`](artifacts/mainspot-hdc.service) e instalada en
`~/.config/systemd/user/`:

- Ejecuta en primer plano `python -B -m canonflow_hdc.cli serve --project <raíz>
  --port 8765 --no-browser`.
- Usa el intérprete privado de MainSpot y `PYTHONPATH` al checkout de CanonFlow.
  No usa bootstrap, wheel ni release instalada.
- `Restart=always`, `RestartSec=3s`, `StartLimitIntervalSec=0`; habilitada en
  `default.target`. `Linger=yes` permite arrancar sin una sesión abierta.
- Endurecimiento: `UnsetEnvironment` de claves TypeSafe/CJL/OpenRouter,
  `UMask=0077`, `NoNewPrivileges=yes`, `PrivateTmp=yes`,
  `PYTHONDONTWRITEBYTECODE=1`.
- La escucha permanece en `127.0.0.1:8765`.

Operación: `systemctl --user status|start|restart|stop mainspot-hdc.service`.

## Contrato afectado

- §12: prohíbe servicio de sistema o supervisor residente.
- §12 y §1.5: bootstrap instala la release y levanta la consola. El servicio de
  MainSpot ejecuta directamente el checkout fijado.

## Verificación ejecutada

Registrada en `.canonflow/cognitive/checkpoint.json` (`hdc.service`): unidad
habilitada, reinicio controlado verificado y workspace verificado en navegador.
El 2026-10-21 la unidad estaba `enabled` y `active`. **No se probó un reinicio de
la máquina.**

## Propuesta para CanonFlow

Requiere que el propietario enmiende §12. Diseño propuesto:

1. Comando opcional `canonflow-hdc service install|uninstall|status --project`.
   Nunca se activa por defecto.
2. La unidad ejecuta la release instalada por bootstrap, no un checkout.
3. Se mantienen la escucha exclusiva en loopback, el lock de instancia, la
   ausencia de secretos en el entorno y el canal `/_control/stop`.
4. `canonflow-hdc stop` detiene el servicio o lo rechaza con instrucciones.
   Con `Restart=always`, salir por `/_control/stop` provocaría un relanzamiento.
5. Linux: systemd de usuario. macOS y Windows requieren diseño propio con
   launchd y Programador de tareas.
6. Pruebas I5: reinicio tras fallo, arranque con linger, puerto ocupado,
   actualización con el servicio activo y desinstalación limpia.

## Riesgos y límites

- Con `StartLimitIntervalSec=0`, una configuración inválida reintenta
  indefinidamente cada 3 segundos y llena el journal.
- En MainSpot, detener HDC con `systemctl --user stop`, no con el CLI.
  `[INFERENCIA]` Por la semántica de `Restart=always`, systemd relanzaría el
  proceso tras un `stop` del CLI; no se ejecutó esa prueba.
