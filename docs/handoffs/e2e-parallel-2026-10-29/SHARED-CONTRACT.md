# Contrato compartido — E2E de MainSpot

Es una referencia de comportamiento entre SOL MAIN y Claude Design, **no** una API ya implementada. SOL MAIN concretará rutas, migraciones y DTO de acuerdo con convenciones actuales; publicará el shape final para Claude sin esperar aprobación. Claude usa fixtures equivalentes para avanzar sin depender del backend.

## A. Tres teléfonos de contacto INDEPENDIENTES por integración

**Regla expresa del propietario:** el «Otro número» de cada integración es individual, no uno global ni una misma alternativa reutilizada. Las tres integraciones deben poder utilizar **tres números distintos**, o cualquier combinación de número principal y otros números.

- Canales `website`, `google_business_profile`, `facebook`.
- El dueño del negocio tiene un `primary_phone` editable.
- **CADA integración almacena** `mode: 'own' | 'other'` **y su propio** `other_phone` (nullable). No introducir un único `alternate_phone` del usuario, empresa o sistema.
- `effective_phone(channel)` = `primary_phone` cuando `mode=own`, de lo contrario `integration[channel].other_phone`.
- Cambiar el teléfono principal cambia los canales `own` pero **NUNCA** modifica `other_phone` de los otros canales.
- Cambiar el número de Facebook **NO** afecta Página Web, Google Maps ni el teléfono principal. Igual para los otros canales. Las actualizaciones parciales no pisan configuraciones hermanas.
- Alternar temporalmente `other→own→other`: opción pragmática: **preservar el override anterior** para retomarlo si se elige `other` otra vez, sin mostrarlo como contacto activo cuando `own` está seleccionado. Si el cliente decide borrarlo explícitamente, sí eliminarlo.
- El contacto público es **distinto del chat de Telegram vinculado para alertas**. Asignar un número no equivale a habilitar WhatsApp, SMS ni Telegram a ese destino.

**Ejemplo con tres alternativas DISTINTAS** (valores de prueba ficticios; no usar en producción):
```json
{
 "primary_phone":{"country_iso2":"MX","calling_code":"+52","national_number":"9830000000","e164":"+529830000000"},
 "integration_phones":{
  "website":{"mode":"other","other_phone":{"country_iso2":"MX","calling_code":"+52","national_number":"9831111111","e164":"+529831111111"},"effective_phone":"+529831111111"},
  "google_business_profile":{"mode":"other","other_phone":{"country_iso2":"MX","calling_code":"+52","national_number":"9832222222","e164":"+529832222222"},"effective_phone":"+529832222222"},
  "facebook":{"mode":"other","other_phone":{"country_iso2":"MX","calling_code":"+52","national_number":"9833333333","e164":"+529833333333"},"effective_phone":"+529833333333"}
 }
}
```

**UI:** cada integración presenta `Usar mi número` o `Otro número`; solo con `Otro número` aparece selector **país/prefijo** + input de número; guardar/editar, validación útil, vista previa del número efectivo y estado real/simulado de sincronización con proveedor. `Usar mi número` apunta dinámicamente al primario, no copia valores que se vuelvan obsoletos.

**Validación:** E.164 usando librería mantenida, no reglas fijas de 10 dígitos; selección país + prefijo coherentes; errores de campo, sin exponer PII en logs/auditoría. Nunca asumir que un número alternativo de la ficha Google puede actualizarse externamente sin permisos/validaciones del proveedor.

## B. Agente de atención activo por políticas

### Fuentes
- `google_review`: reseña del perfil de negocio de Google.
- `facebook_comment`: comentario recibido en publicación de Facebook.
- Página Web es uno de los **canales con teléfono configurable**, pero no se inventa una fuente de comentarios del sitio si no existe.

### Flujo
```text
ingesta nueva → deduplicación → clasificación/contexto
                        ├─ política opt-in válida + acción segura → responder (simulado) → evidencia
                        └─ inseguro, ambiguo o sin política → caso humano → panel + Telegram
                                                              → hasta 3 alternativas
                                                              → editar/aprobar/rechazar → respuesta (simulada)
```

- El trabajador observa de forma recurrente **sin navegador abierto**, mediante adaptador de proveedor + contrato de polling/webhooks donde proceda; proveedor determinista en simulación. Reutilizar colas/timers/DB existentes, sin armar una infraestructura nueva.
- Dedupe `tenant_id + origin + external_ref` + idempotencia de publicación, estado persistente, cursor, reintentos con backoff, concurrencia protegida y capacidad de recuperar tras reinicio.
- `engagement_case`: referencia externa, autor de ejemplo, cuerpo, rating si aplica, origen, política/version, estado, motivo, borradores, actor/resolución, intento/resultado, enlace a recurso y auditoría. Evitar recolectar información personal innecesaria.
- Estado sugerido: `received → classified → responded` (solo autorizado) o `needs_human → drafted → approved/rejected → responded`, con `failed/retry_pending`.
- Bandeja unificada en plataforma y notificaciones Telegram por chat vinculado: mismo `case_id`, sin alertas duplicadas. Cuando Telegram esté ausente, el caso sigue visible y pendiente; notificar no depende del teléfono público.
- Hasta **3 respuestas editables** con información verificada, sin prometer descuento, reembolso ni decisiones comerciales no autorizadas.
- Políticas de la empresa por canal/categoría: `default=review_required` y opt-in humano explícito para `safe_auto_reply`, versionado y revocable. La puntuación o el sentimiento por sí solos **no** autorizan respuesta automática. Falla de política, confianza, proveedor, permisos, datos verificados o clasificación → revisión humana. Aun con política, limitar tasa y frecuencia, responder de forma trazable.
- Respuestas a reclamaciones graves, datos privados, emergencia, amenazas, riesgos legales, ofertas, compensaciones, acusaciones o contenido ambiguo → revisión humana. No ocultar ni manipular opiniones públicas.
- Las APIs reales de Google/Meta no están certificadas. El E2E de esta tanda funciona **en simulación** sin credenciales; interfaces de adaptador listas para conexión futura, sin afirmar llamadas externas.

## C. Contratos y pruebas mínimas

| Prueba | Resultado exigido |
|---|---|
| TEL-01 | Los tres canales seleccionan `other` con **tres valores distintos**, se guardan y se leen sin cruces. |
| TEL-02 | Modificar solo el `other` de Facebook no cambia `other` de Página Web ni Google. |
| TEL-03 | Configurar `website=own`, `google=other`, `facebook=other`: cambiar primario cambia solo el número efectivo de web. |
| TEL-04 | `other→own→other` recupera su valor independiente; formatos de varios países, datos inválidos y tenant cruzado fallan correctamente. |
| AG-01 | Google reseña simple + opt-in explícito → respuesta simulada única con auditoría y versión de política. |
| AG-02 | Reseña delicada → 3 alternativas, caso humano, aviso Telegram (simulado), aprobación/edit/rechazo. |
| AG-03 | Facebook comentario simple y delicado → ambos caminos, sin afectar publicaciones previas. |
| AG-04 | Duplicados/reintentos/carrera, timeout, caída del worker, sin chat Telegram, sin política → sin doble respuesta, sin casos perdidos. |
| FLOW-01 | Alta y login sin tenant_id → panel → web/Google/Facebook → agente y excepciones, datos por tenant. |
| FLOW-02 | Página Web cambio → preview/aprobación → publicación de desarrollo sin regresiones. |

**Prohibido llamar «PASS real Google/Meta» a los simuladores.** Tests y reporte deben indicar `simulated`, `real` o `not_verified` por escenario.
