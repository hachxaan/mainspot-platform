# AI Core — propuesta de canon 0.2.0 para aprobación (QS-0016)

Fecha: 2026-10-30. Autor: SOL MAIN (sesión OMP; el runtime reporta el modelo `anthropic/claude-opus-5-5`).
Fuente: issue #9 y `MAINSPOT-AI-CORE-E2E-HANDOFF.md` (commit `ad7287c`).

Esta propuesta agrupa los ítems redactados en estado `PROPOSED`. Aprobarla los convierte en base canónica del AI
Core; **no** autoriza enviar datos reales a proveedores, gastar en anuncios ni publicar en cuentas de terceros: eso lo
fijan las preguntas separadas de la misma sesión y BR-0007.

## Ítems ligados (bytes exactos)

| Ítem | sha256 |
|---|---|
| `.canonflow/canon/functional/items/FR-0012.md` | `2ecfc3b1f55af6bf4649300d4167b5bc62f0300949da7528e8e286a3cb8fb86c` |
| `.canonflow/canon/functional/items/FR-0013.md` | `e506963c9cc6354caa834ccf5c581611a5bbc7bc797ece556634629b8b9392a5` |
| `.canonflow/canon/functional/items/FR-0014.md` | `ac6abcf35d7c1d07e027a3bc0790c661300ad1d91779bf8265979f6566c75c9e` |
| `.canonflow/canon/functional/items/FR-0015.md` | `8e71a05602a855dfd7727120c354d03d63070a5c399f26e7903def5b12ee9d20` |
| `.canonflow/canon/functional/items/FR-0016.md` | `694fca629c54f961795fcfa7831c4af4fe46c5fd64311c2e0123908c9bafdec0` |
| `.canonflow/canon/functional/items/FR-0017.md` | `f21cb367f48357804d74b28fdb39e681192cdda952bf0fd85473fbf6853de1d6` |
| `.canonflow/canon/functional/items/FR-0018.md` | `af2d347d913a825cb18e03583d15ed610606f320f34d4a2c9e2b404fe6f30882` |
| `.canonflow/canon/functional/items/FR-0019.md` | `a839356ee00ff699509246bbff98be79ccc1025e41cc689abc0f2ea0bafa5e56` |
| `.canonflow/canon/functional/items/NFR-0006.md` | `d4caaa2b53ab896df96897398ea5944728a29038f544d9e7fd27d0a69ea89071` |
| `.canonflow/canon/functional/items/NFR-0007.md` | `0b08e882fcb40ed959f542fd6d4c99d0e77377a90005222083a8b6ab41f1b545` |
| `.canonflow/canon/functional/items/NFR-0008.md` | `cbd6817bfcc64c88ef15a35037ae03247d259470c7208015ce4da0908da426cb` |
| `.canonflow/canon/functional/items/BR-0007.md` | `9aeceef9157be904e36ff2f3f1d33a8d59fd83ea8cc13278200aa8f4a462b2da` |
| `.canonflow/canon/technical/items/ARC-0001.md` | `79b6d3974a754031b85a7076dd2bec5364edc81e07fa9916047244a6fa981122` |
| `.canonflow/canon/technical/items/DAT-0001.md` | `b6fc4467a668478203ee07bf377f80a51c2723448795fcea650d345e2f443234` |
| `.canonflow/canon/technical/items/SEC-0001.md` | `a2e637d1d92439e8ff619d437716d6e88621dddedd332ebebe4859236e4555f0` |
| `.canonflow/canon/technical/items/OPS-0001.md` | `a4bff4a5517ad19b09dbe9326270dde20bd4b699ffb6151f6a229bd05a4cfc30` |

## Resumen de lo que cambia

- Un asistente; catálogo de casos de uso con prompt y ruta de modelo versionados, evaluados y desplegados desde una
  consola de ingeniería sin código; rollback inmediato.
- Jev como clasificador semántico primario (intención **y** sentimiento/riesgo de comentarios y reseñas), sin
  autoridad de ejecución; con tenants sin autorización de datos, la clasificación queda `BLOCKED_EXTERNAL`.
- Brand Studio con hechos confirmados; web generativa en DSL seguro (sin JS); publicaciones con imagen; respuestas
  generadas con ledger único; asistente con herramientas de lectura; campañas solo propuestas; insights con evidencia.
- Consolas centrales con identidad propia, MFA TOTP y step-up; clasificación de datos `synthetic`/`real` por negocio.
- Costos con reserva y techo duro; metas provisionales por caso de uso (NFR-0008).

## Lo que esta propuesta NO decide

- Envío de mensajes reales de clientes a TypeSafe u otro proveedor (pregunta Q-JEV-REAL-DATA).
- Presupuesto de IA generativa fuera del laboratorio sintético (pregunta Q-AI-BUDGET).
- Gasto en anuncios, conexión de cuentas publicitarias o publicación en cuentas reales de clientes.
- Modelo jurídico de distribución SaaS frente a la política de acceso indirecto de Google Business Profile.
