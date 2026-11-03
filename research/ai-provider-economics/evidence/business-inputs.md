# Evidencia — Insumos NO-IA para el modelo de rentabilidad de MainSpot

Fecha de consulta de todas las fuentes: **2026-11-03** (salvo indicación explícita).
Alcance: investigación; los planes MXN 500 / 1,000 / 2,000 al mes son **hipotéticos y NO aprobados**; este documento no constituye decisión de pricing ni fiscal. ISR y seguridad social quedan fuera de alcance (nota en §2).

Etiquetas de evidencia: **HECHO VERIFICADO** (leído con `read`/navegador en la URL oficial), **SNIPPET** (visto solo en resultado de búsqueda o fuente secundaria), **MEDICIÓN PROPIA** (datos del laboratorio; no aplica aquí), **ESTIMACIÓN** (cálculo propio con fórmula y supuestos), **HIPÓTESIS**, **DESCONOCIDO**.

Nota metodológica: los sitios de Stripe, Mercado Pago, Conekta, Openpay, Wix, WhatsApp (rate card) y el sitio de Banxico se leyeron en fecha 2026-11-03; las páginas de AWS S3 se contrastaron contra la **lista de precios oficial en CSV/JSON de AWS** (`pricing.us-east-1.amazonaws.com`, oferta `AmazonS3`/`AWSDataTransfer`, publicación 2026-10-15/2026-06-01), que es fuente primaria machine-readable y resuelve el problema de tablas renderizadas en cliente.

---

## 1. Tipo de cambio USD/MXN

| Concepto | Valor | Unidad | Fuente | Fecha | Etiqueta |
|---|---|---|---|---|---|
| Tipo de cambio **FIX** de Banxico (más reciente disponible al momento de consultar) | **18.7962** | MXN por USD, fecha de determinación 30/10/2026 | Banco de México, página oficial de tipos de cambio (`banxico.org.mx/tipcamb/llenarTiposCambioAction.do`) | 2026-11-03 | HECHO VERIFICADO |
| Tipo de Cambio de Cierre de Jornada (30/10/2026) | 18.8037 | MXN por USD | Misma página oficial de Banxico | 2026-11-03 | HECHO VERIFICADO |
| Publicación en DOF del FIX 18.7962 | 3 nov 2026 | fecha | tipocambiodof.com (agregador que reproduce DOF/SIE) | 2026-11-03 | SNIPPET (agregador; DOF no leído directo) |
| FIX 5 días hábiles previos | 26/10: 18.5798 · 27/10: 18.6525 · 28/10: 18.6673 · 29/10: 18.8148 · 30/10: 18.7962 | MXN/USD | tipocambiodof.com/fix (reproduce SIE; incluye columna "publicación DOF") | 2026-11-03 | SNIPPET (fuente secundaria que cita SIE) |
| Rango histórico 3–6 meses (may–oct 2026) | **NO VERIFICADO** en esta sesión | MXN/USD | La serie SIE (`CF373` / API SIE) requiere token; la página HTML del cuadro no expone datos estáticos | — | DESCONOCIDO (ver Huecos) |

Notas:
- La página oficial de Banxico define el FIX como el tipo de cambio "para solventar obligaciones denominadas en dólares… pagaderas en la República Mexicana"; se publica diariamente desde las 12:00 h y entra al DOF un día hábil después (HECHO VERIFICADO, texto de la propia página).
- Para el modelo unitario: **usar FIX 18.7962 (2026-10-30)** como tipo de cambio base y **18.5–19.5** como banda de sensibilidad para costos facturados en USD (banda ±4 % alrededor del FIX; ESTIMACIÓN: la banda de 5 días observados es 18.58–18.81; la banda amplia es suposición conservadora para volatilidad multimensual, no medida).
- Conversión de referencia usada en todo el documento: USD 1 = MXN 18.7962.

Sensibilidad para los planes hipotéticos (ESTIMACIÓN: plan MXN ÷ FIX):

| Plan (MXN/mes) | USD equivalentes al FIX 18.7962 | A 18.0 | A 19.5 |
|---|---|---|---|
| MXN 500 | USD 26.60 | USD 27.78 | USD 25.64 |
| MXN 1,000 | USD 53.20 | USD 55.56 | USD 51.28 |
| MXN 2,000 | USD 106.41 | USD 111.11 | USD 102.56 |

Implicación: si el peso se aprecia (TC baja), el ingreso en USD por cliente sube; si se deprecia, baja. Los costos de IA/infra son ~100 % en USD (Anthropic/OpenAI/Cloudflare/AWS), así que el margen en MXN es directamente sensible al TC.

---

## 2. Impuestos (IVA y tratamientos aplicables)

### 2.1 IVA sobre la suscripción

- **Tasa general de IVA en México: 16 %.** Texto legal: Ley del IVA (LIVA), tasa general del 16 % (art. 1/2). No se leyó el PDF íntegro de la LIVA en esta sesión; la tasa 16 % también aparece operativamente en las fuentes fiscales consultadas (boletín del Colegio de Contaduría Pública de México sobre plataformas digitales, que menciona retención del "16 % que corresponda al IVA"). Etiqueta: HECHO VERIFICADO la operación al 16 % en fuentes fiscales secundarias; el texto literal de la ley queda como referencia normativa no leída (ver Huecos). Fuente: diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf (URL oficial); contadoresmexico.org.mx (leído).
- **Supuesto de precio:** MXN 500 / 1,000 / 2,000 son **precios al público con IVA incluido** (consistente con cómo se anuncian los servicios digitales B2C en México). Cálculo del neto (ESTIMACIÓN, fórmula: `neto = precio / 1.16`; `IVA = precio − neto`):

| Plan precio al público (con IVA) | Neto (ingreso gravado) | IVA trasladado (16 %) |
|---|---|---|
| MXN 500 | **MXN 431.03** | MXN 68.97 |
| MXN 1,000 | **MXN 862.07** | MXN 137.93 |
| MXN 2,000 | **MXN 1,724.14** | MXN 275.86 |

- El IVA cobrado al cliente es un pasivo (se entera al SAT); la base para costos y márgenes es el **neto**. Los proveedores extranjeros facturan sin IVA mexicano y sus cargos son **deducibles/acréditables** según el régimen del contribuyente; el efecto neto fiscal final corresponde al contador de MainSpot (fuera de alcance).

### 2.2 IVA/retenciones en servicios digitales extranjeros que MainSpot paga (Anthropic, OpenAI, Cloudflare, Meta, etc.)

- El **régimen de plataformas digitales extranjeras (art. 18-J LIVA, vigente desde 1 jun 2020)** obliga a plataformas extranjeras que venden **servicios digitales a usuarios finales en México** a registrarse ante el SAT, cobrar y enterar el IVA 16 %, designar representante legal en México, etc. (HECHO VERIFICADO en boletín del Colegio de Contaduría Pública de México, 22/09/2023, que describe el régimen y su catálogo de servicios digitales).
- **El catálogo del régimen es taxativo** (clubes en línea/citas, comercio de bienes, descarga o acceso a contenido digital, enseñanza a distancia, entrega de alimentos, entrega de bienes, hospedaje, transporte terrestre de pasajeros). Las **APIs de IA, object storage, pasarelas de pago o SaaS B2B NO aparecen en ese catálogo** (HECHO VERIFICADO del catálogo en el boletín citado). Hipótesis operativa: Anthropic/OpenAI/Cloudflare/Google Cloud **no cobran IVA mexicano** a MainSpot bajo ese régimen. Etiqueta: HIPÓTESIS (interpretación del catálogo; confirmar con el contador).
- Lo que sí aplica cuando una empresa mexicana **compra** servicios de residentes en el extranjero aprovechados en México (HECHO VERIFICADO como regla general en el mismo boletín): el IVA de la **importación de servicios** se paga "conforme a la propia ley" (autoliquidación por el adquirente). En la práctica: MainSpot autoliquida 16 % sobre pagos al extranjero y, si la actividad está gravada (sus suscripciones llevan IVA), ese IVA importado es **acréditable → neutro en P&L**, con efecto de **flujo de efectivo** (se paga antes de acreditarlo). Etiqueta de la mecánica de acreditamiento: HIPÓTESIS contable estándar (verificar con contador; no leído en LIVA art. 26 directamente).
- **Retención de ISR** sobre pagos de asistencia técnica al extranjero (arts. 153/154 LISR y reglas de exención por registro del proveedor): **no revisada en esta sesión** → DESCONOCIDO. Nota únicamente: puede haber retenciones de ISR o su exención si el proveedor extranjero está inscrito en el padrón correspondiente; decidir con asesor fiscal. Fuera de alcance por diseño del encargo.
- Implicación práctica para unit economics (ESTIMACIÓN): el costo en USD de IA/infra se convierte a MXN al FIX y se le agrega **16 % de IVA autoliquidado (neutro pero con efecto de caja)** si se modela a nivel de flujo; el modelo de margen bruto debe usar costos **sin IVA**.

---

## 3. Comisiones de cobro recurrente en México (pasarelas)

Todas las tarifas son **por transacción exitosa**, moneda MXN, consultadas el **2026-11-03** en la página oficial de cada proveedor.

### 3.1 Tarifario fuente primaria

| Proveedor | Tarjeta nacional | Tarjeta internacional | OXXO / efectivo | SPEI / transferencia | IVA sobre comisión | Fuente (URL oficial) | Etiqueta |
|---|---|---|---|---|---|---|---|
| **Stripe México** | **3.6 % + MXN 3.00** | **+0.5 %** adicional (3.6 %+0.5 % = 4.1 % + MXN 3.00); **+2 %** si hay conversión de moneda | **4 % + MXN 3.00** (vales OXXO) | MXN 7.00 por transacción + IVA | Sí: la página indica explícitamente "Todas las comisiones excluyen el IVA" | stripe.com/mx/pricing y stripe.com/mx/pricing/local-payment-methods | HECHO VERIFICADO |
| **Mercado Pago (Link de pago)** | **3.49 % + MXN 4.00** al instante; 3.19 % + 4.00 (7 días); 2.95 % + 4.00 (30 días) | No diferenciada en la página (mismas tarifas anunciadas para "tarjeta de crédito") | **3.79 % + MXN 4.00** en ~3 días (bloque FAQ); el bloque superior de la misma página muestra "Oxxo, transferencia y efectivo: 3.49 %" — **discrepancia interna detectada** | SPEI listado junto a tarjeta en FAQ (3.49 % + 4.00 al instante) | No declarado en la página para el porcentaje; la cuota fija de MSI se anuncia "+ IVA" → DESCONOCIDO | mercadopago.com.mx/herramientas-para-vender/link-de-pago | HECHO VERIFICADO (cifras); DESCONOCIDO (tratamiento de IVA del % y discrepancia OXXO) |
| **Conekta** | **3.4 % + MXN 3.00** (+ IVA); comisión mínima MXN 5.40 | No publicado en la página de precios (la calculadora menciona genérico "sobretasa") → DESCONOCIDO | **2.6 % + MXN 3.00** (+ IVA) **+ comisión del punto de pago MXN 10–13 con IVA** (en Practicajas BBVA sin comisión adicional) | **MXN 12.50 + IVA** (SPEI) | Sí: "Todos los planes y tarifas son + IVA" | conekta.com/pricing | HECHO VERIFICADO (nacional/efectivo/SPEI); DESCONOCIDO (internacional) |
| **Openpay** | **2.9 % + MXN 2.50 + IVA** (sin montos fijos extra; dinero disponible 1 día hábil) | **4.10 % + IVA** ("Comisión Base Internacional", sin MSI, sin monto fijo publicado) | **2.9 % + MXN 2.50 + IVA** + comisión del establecimiento Paynet (dinero en 3 días) | **MXN 8.00 + IVA** (SPEI, 1 día hábil) | Sí (+ IVA) | openpay.mx/comisiones (leído con navegador; la página de docs `documents.openpay.mx/comisiones` está renderizada en cliente y no contiene la tabla) | HECHO VERIFICADO |

Cifras adicionales verificadas (HECHO VERIFICADO, mismas fuentes): Stripe: cuotas MSI desde 5 % (3 meses) hasta 22.5 % (24 meses); contracargo MXN 150 por disputa. Openpay MSI: 3→7.7 %, 6→10.7 %, 9→13.7 %, 12→16.7 % (+ IVA), montos mínimos MXN 300–1,200. Conekta MSI: no listado en la página leída → DESCONOCIDO.

### 3.2 Costo efectivo de cobrar la suscripción (ESTIMACIÓN)

Fórmula: `cobro = (%tarifa × monto + cuota_fija) × (1 + 0.16)` cuando la tarifa lleva IVA; para Mercado Pago se muestran ambos casos porque el IVA del porcentaje no está declarado. Ejemplo con **MXN 500** (con IVA incluido):

| Método | Cálculo | Cobro total | % sobre MXN 500 | % sobre neto (MXN 431.03) |
|---|---|---|---|---|
| Stripe tarjeta nacional | (18.00 + 3.00) × 1.16 | **MXN 24.36** | 4.87 % | 5.65 % |
| Stripe tarjeta internacional | (20.50 + 3.00) × 1.16 | MXN 27.26 | 5.45 % | 6.32 % |
| Stripe OXXO | (20.00 + 3.00) × 1.16 | MXN 26.68 | 5.34 % | 6.19 % |
| Mercado Pago al instante (sin IVA en la tarifa) | 17.45 + 4.00 | MXN 21.45 | 4.29 % | 4.98 % |
| Mercado Pago al instante (hipótesis con IVA) | 21.45 × 1.16 | MXN 24.88 | 4.98 % | 5.77 % |
| Conekta tarjeta nacional | (17.00 + 3.00) × 1.16 | MXN 23.20 | 4.64 % | 5.38 % |
| Conekta OXXO (con comisión de punto de pago $10–13) | (16.00 + 3.00) × 1.16 + 11.5 | MXN 33.54 | 6.71 % | 7.78 % |
| Openpay tarjeta nacional | (14.50 + 2.50) × 1.16 | **MXN 19.72** | 3.94 % | 4.57 % |
| Openpay tarjeta internacional | (20.50 + 0) × 1.16 | MXN 23.78 | 4.76 % | 5.52 % |
| Openpay SPEI | (8.00 + 0) × 1.16 | MXN 9.28 | 1.86 % | 2.15 % |

Para MXN 1,000 y MXN 2,000 la parte porcentual escala y la cuota fija se diluye (ej. Stripe nacional: MXN 39.72 y 70.44; Openpay: MXN 34.44 y 64.16; ESTIMACIÓN con la misma fórmula).

Lecturas para el modelo:
1. **Rango de comisión realista: 3.9 %–5.5 %** del precio al público con tarjeta nacional (ESTIMACIÓN a partir de tarifas verificadas). En MXN 500 eso es **MXN 19.7–27.3 por cliente/mes** (USD 1.05–1.45 al FIX).
2. OXXO cuesta ~1–2 puntos porcentuales más y tiene fricción de "pago en tienda"; para cobro recurrente de suscripciones conviene priorizar tarjeta guardada + SPEI como respaldo.
3. **Openpay es la más barata en tarjeta nacional** en tarifas publicadas; Stripe agrega ecosistema (Billing/suscripciones, Smart Retries, dunning) que reduce el churn involuntario — el comparativo de costo total debe incluir el valor del dunning (ver §7, Recurly: churn involuntario 1.30 % anual en el tramo USD 10–25 ARPC).
4. Cobros internacionales (tarjeta extranjera) pagan +0.5 % (Stripe) o 4.10 % flat (Openpay). Para clientes mexicanos, mezcla esperada de tarjetas nacionales dominante → modelar mix (HIPÓTESIS: 85 % nacional / 15 % internacional).
5. Ninguna tarifa publicada incluye cargo mensual de plataforma; Stripe Checkout/Payment Links y el "Billing" de suscripciones no publican cargo extra en estas páginas (DESCONOCIDO: posibles cargos de Facturas/Invoicing).

---

## 4. Infraestructura por cliente

### 4.1 Precios verificados por servicio (fuente oficial, 2026-11-03)

| Servicio | Precio verificado | Fuente | Etiqueta |
|---|---|---|---|
| **Cloudflare R2** (Standard) | Almacenamiento **USD 0.015/GB-mes**; Class A **USD 4.50/millón** de operaciones; Class B **USD 0.36/millón**; **egress a Internet: gratis**; free tier 10 GB-mes + 1M Class A + 10M Class B por mes; IA (Infrequent Access) USD 0.01/GB-mes con retrieval USD 0.01/GB y duración mínima 30 días | developers.cloudflare.com/r2/pricing/ (actualizada 2026-10-30) | HECHO VERIFICADO |
| **AWS S3 Standard** (us-east-1) | **USD 0.023/GB-mes** primeros 50 TB; 0.022 siguientes 450 TB; 0.021 >500 TB; PUT/COPY/POST/LIST **USD 0.005/1,000**; GET **USD 0.0004/1,000**; lista de precios oficial AWS (publicación 2026-10-15) | pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/.../us-east-1/index.csv | HECHO VERIFICADO |
| **Egress a Internet desde AWS** (us-east-1) | **100 GB/mes gratis** agregados globalmente por cuenta; después **USD 0.090/GB** primeros 10 TB, 0.085 siguientes 40 TB, 0.070 siguientes 100 TB, 0.050 >150 TB. AWS ofrece egress **totalmente gratis solo al migrar fuera de AWS** (programa con soporte, 180 días) | CSV AWSDataTransfer (SKU HQEH3ZWJVT46JHRG y PB257JUQ8U6E6UPM) + blog oficial aws.amazon.com/blogs/aws/free-data-transfer-out-to-internet-when-moving-out-of-aws/ | HECHO VERIFICADO |
| **Google Cloud Storage** (Standard, regional us-central1) | **USD 0.020/GB-mes** (0.000027397/GiB-h × 730 h); dual/multi-región US USD 0.026; Class A **USD 0.005/1,000**; Class B **USD 0.0004/1,000**; precios por SKUs en moneda local si la cuenta lo permite | cloud.google.com/storage/pricing | HECHO VERIFICADO |
| **Postgres gestionado — Neon** (Lakebase/Databricks) | Free: USD 0 (100 proyectos, 100 CU-h/proyecto, 1 GB/proyecto, egress 5 GB/proyecto). **Launch:** cómputo **USD 0.106/CU-h**, almacenamiento **USD 0.35/GB-mes**, egress 500 GB incluido luego USD 0.10/GB; sin mínimo mensual. Workloads típicos publicados: **carga intermitente USD 15/mes**, media USD 80/mes, alta USD 353/mes (Launch) / USD 701/mes (Scale). Patrón *database-per-tenant* con 100 tenants: **≈ USD 0.85/tenant/mes** (ejemplo oficial) | neon.com/pricing (actualizada 2026-10-31) | HECHO VERIFICADO |
| **Correo transaccional — Amazon SES** | Planes: Essentials **USD 0.16/1,000 emails** (0–10 M/mes); à la carte **USD 0.10/1,000 emails** sin mínimo; adjuntos USD 0.12/GB | aws.amazon.com/ses/pricing/ | HECHO VERIFICADO |
| **Dominio .mx** | Registro .mx **MXN 749/año**, renovación **MXN 799/año**; **.com.mx** registro MXN 299, renovación **MXN 499/año**; .com registro MXN 329, renovación MXN 343 (registrador mexicano MEXISERVER; NIC México es el registro oficial y no se consultó su tarifario directo) | clientes.mexiserver.com/domain/pricing | HECHO VERIFICADO en registrador secundario; SNIPPET respecto a tarifa oficial NIC México |
| **CDN / hosting de sitio estático** | No verificado directamente en esta sesión. R2 sirve buckets públicos con egress gratis (HECHO VERIFICADO en la página de R2); plan(es) de Cloudflare Pages/Workers para dominios personalizados no verificados → DESCONOCIDO | — | DESCONOCIDO (ver Huecos) |
| **Monitoreo** | No verificado (UptimeRobot/Grafana Cloud). Modelado como costo compartido de cuenta, no por cliente | — | DESCONOCIDO/ESTIMACIÓN |

### 4.2 Estimación de costo de infraestructura por cliente/mes

**Supuestos explícitos (ESTIMACIÓN):**

| Supuesto | Valor | Justificación |
|---|---|---|
| Media almacenada por cliente (sitio, imágenes generadas, assets) | **0.2 GB el primer año**, creciendo ~0.1 GB/año (media de cartera ~0.3 GB) | Sitio de microempresa + ~30–60 imágenes generadas (2–5 MB c/u) + copys; HIPÓTESIS conservadora |
| Visitas al sitio | **5,000/mes** | Supuesto del encargo |
| Peso medio por visita servida | **1.5 MB** | Página con 5–8 imágenes optimizadas; el CDN sirve la mayor parte desde caché; ESTIMACIÓN |
| Egress de imágenes por cliente | 5,000 × 1.5 MB = **7.5 GB/mes** | Fórmula |
| Operaciones R2/S3 | 30 writes (Class A) + 75,000 reads (Class B) por cliente/mes | ~2,500 visitas/día × ~15 objetos |
| Correos transaccionales | **50/cliente/mes** (notificaciones, recibos, alertas de cobro) | HIPÓTESIS |
| Base de datos | **1 Postgres multi-tenant compartido** (no DB por cliente) | Arquitectura actual; patrón DB-per-tenant listado como alternativa |
| Dominio | **0** por defecto (el cliente aporta su dominio); +dominio gestionado por MainSpot como línea opcional | HIPÓTESIS de producto |
| Monitoreo/CDN plan-level | costo compartido de plataforma, distribuido en "overhead fijo" | HIPÓTESIS |

**Fórmulas:** `almacenamiento = GB × tarifa`; `Class B = lecturas/1M × 0.36`; `Class A = writes/1M × 4.50`; `egress_S3 = GB × 0.09` (tras los 100 GB gratis de la cuenta); `SES = correos/1,000 × 0.10 (à la carte)`; conversión MXN = USD × 18.7962.

**Resultado por cliente/mes (USD), escenario base:**

| Componente | 100 clientes | 1,000 clientes | 10,000 clientes | Nota |
|---|---|---|---|---|
| Storage R2 (0.3 GB) | USD 0.0045 | 0.0045 | 0.0045 | el free tier (10 GB) cubre la cartera completa a 100 clientes → 0 |
| Operaciones R2 (Class A+B) | 0.027 | 0.027 | 0.027 | Class B domina (75k lecturas × 0.36/M) |
| Egress R2 | **0** | 0 | 0 | egress gratis |
| Base de datos (Neon multi-tenant) | 0.15 (USD 15 total) | 0.08 (USD 80) | 0.035–0.07 (USD 353–701) | workload típico publicado por Neon |
| Email SES (50 correos) | 0.005 | 0.005 | 0.005 | à la carte; Essentials: 0.008 |
| Dominio gestionado (opcional) | 0 (o +2.21) | 0 (o +2.21) | 0 (o +2.21) | .com.mx MXN 499/año ÷ 12 ÷ 18.7962 |
| **Total base (sin dominio)** | **≈ USD 0.19** | **≈ USD 0.12** | **≈ USD 0.07–0.11** | ≈ MXN 3.6 / 2.3 / 1.3–2.0 al FIX |

**Sensibilidades clave:**
- **Escenario S3 en lugar de R2** (mismo uso): storage 0.0069 + GET 0.03 + PUT 0.0002 + **egress 7.5 × 0.09 = 0.675** ≈ **USD 0.71/cliente/mes** (~30× el costo R2). A 10,000 clientes: USD 7,100/mes vs USD ~1,000/mes. **El egress es el componente dominante si se sirve media directamente desde S3**; R2 (egress gratis) o servir todo vía CDN con caché agresiva es la decisión económica clara. ETIQUETA: ESTIMACIÓN con tarifas verificadas.
- **Escenario de tráfico alto** (20,000 visitas/mes, 3 MB/visita → 60 GB egress): R2 sigue en ~USD 0.03; S3 subiría a USD 5.4/cliente/mes. ESTIMACIÓN.
- **DB-per-tenant con Neon**: ejemplo oficial de 100 tenants = USD 0.85/tenant/mes — orden de magnitud mayor que multi-tenant; solo justificable por aislamiento/regulación. HECHO VERIFICADO el ejemplo; HIPÓTESIS la aplicabilidad.
- **Mix de churn**: asumiendo churn 3–4 % anual (§7), la media almacenada por cliente activo crece; a 5 años de cartera estable, media ~0.7 GB → storage R2 aún < USD 0.011/cliente. ESTIMACIÓN.
- Como fracción del plan: infra base ≈ **0.2–0.7 % del plan MXN 500** (USD 0.07–0.19 vs USD 26.6). Conclusión: **la infraestructura no-IA NO es el cuello de botella de margen; el costo IA y el cobro lo son** (ESTIMACIÓN).

---

## 5. APIs de terceros (costo y acceso)

| API | Costo de publicar/leer | Límites verificados | Acceso/aprobación | Fuente (2026-11-03) | Etiqueta |
|---|---|---|---|---|---|
| **Meta Graph API (Pages/Comments)** | **Gratis** (sin cobro por llamada; Meta no publica tarifa por publicar/leer comentarios) | Platform limits: **200 × usuarios activos por hora** (por app, token de app/usuario). Pages API con **page/system-user token**: **4800 × usuarios comprometidos por 24 h** (BUC). Conversaciones/Send de Messenger: 2 llamadas/s por página; Private replies: 750/h por página | Requiere App Review / permisos (pages_manage_engagement, pages_read_engagement, etc.); nivel de acceso estándar vs avanzado no verificado en detalle | developers.facebook.com/docs/graph-api/overview/rate-limiting/ (leído íntegro) | HECHO VERIFICADO (costo 0 y fórmulas de límites); DESCONOCIDO: cuotas exactas de advanced access |
| **Google Business Profile API** | **Gratis** (no se documenta cobro por llamada) | Quota por defecto: **300 QPM** por API; Business Information: Create Location 300 QPD, Update Location 10,000 QPD, **edits: 10/min por perfil (no ampliable)** | **Acceso NO público: hay que solicitarlo** (revisión ≤ 14 días); sin quota no se puede llamar (quota 0). Sin cuenta de prueba en producción (las listas falsas se suspenden) | developers.google.com/my-business/content/faq y /content/limits (leídos) | HECHO VERIFICADO |
| **Telegram Bot API** | **Gratis** | Broadcast: ~30 mensajes/s gratis por bot; por encima, "paid broadcasts" **0.1 Stars por mensaje** (se activa en @BotFather); 1 msg/s por chat; 20 msg/min por grupo | Token self-service vía BotFather | core.telegram.org/bots/faq (leído) | HECHO VERIFICADO |
| **WhatsApp Business Platform** (referencia futura, NO en alcance actual de producto) | Rate card **México, vigente 1 oct 2026**, por **mensaje entregado**: **Marketing USD 0.0397** (MXN 0.7298); **Utility USD 0.0085** (MXN 0.1565); **Authentication USD 0.0085** (MXN 0.1565); **Service USD 0.0085** (MXN 0.1565); Meta Business Agent: **USD 2.00 / 1 M tokens** (~USD 0.04–0.05 por mensaje típico de 20–25k tokens) | Free: **1,000 service messages/mes por número** (renovable, no acumulable); Free Entry Point window (72 h) gratis para anuncios click-to-WhatsApp (excluye Meta Business Agent); volume tiers para utility/authentication | Cuenta de Messaging con pago; facturación disponible en **MXN desde 1 ene 2026** | developers.facebook.com/documentation/business-messaging/whatsapp/pricing + **rate card oficial descargada (XLSX) "USD list rates" y "MXN list rates"** | HECHO VERIFICADO |

Notas para el modelo: el caso de uso actual de MainSpot (comentarios de Facebook y reseñas de Google) es **costo cero en la capa de API**; el costo se concentra en la IA que redacta (cubierto en los documentos de economía unitaria de IA). WhatsApp en México: una campaña proactiva de marketing a 1,000 destinatarios costaría USD 39.70 (MXN 729.80) solo en meta-fees — **más caro que todo el plan MXN 500 de un mes**; si se activa WhatsApp más adelante, exigiría opt-in explícito y cobro diferenciado (HIPÓTESIS de producto, no decisión).

---

## 6. Referencias de mercado (precios públicos en MXN cuando existen)

Objetivo: validar si MXN 500–2,000/mes es plausible contra alternativas del mercado mexicano.

| Categoría | Producto | Precio público verificado | Fuente (2026-11-03) | Etiqueta |
|---|---|---|---|---|
| Creador de sitios web | **Wix** (MXN, planes anuales pagados por adelantado, sin impuestos) | Light **MXN 125/mes** (regular sin promo no mostrado); Core **MXN 115/mes** (promo de MXN 230); Business **MXN 190/mes** (promo de 380); Business Elite **MXN 390/mes** (promo de 780) | es.wix.com/pricing (renderizado en navegador) | HECHO VERIFICADO (precios promo; el precio regular completo aparece tachado en la página) |
| Hosting + builder | **Hostinger** (MXN, promoción 48 meses; renovación indicada) | Single **MXN 24.99/mes** (renueva a 89.99); Premium 32.99 (149.99); Unlimited 49.99 (299.99); Cloud Startup 140.99 (455.99) | hostinger.com/mx/precios (markdown oficial) | HECHO VERIFICADO |
| Creador de sitios | **GoDaddy** / **Squarespace** | No leídos en esta sesión; GoDaddy MX ofrece creador de páginas (URL oficial localizada); Squarespace solo en USD | godaddy.com/es/paginas-web/creador-de-paginas-web | DESCONOCIDO (ver Huecos) |
| Gestión de redes | **Metricool** | Free (1 marca); Starter **USD 20/mes** (hasta 5 marcas; USD 36 hasta 10); Advanced **USD 53/mes** (hasta 15 marcas) | metricool.com/pricing | HECHO VERIFICADO |
| Gestión de redes | **Buffer** | Free (3 canales); Essentials **USD 6/canal/mes** (descuento por volumen hasta USD 1/canal con 51+); Team USD 12/canal | buffer.com/pricing (markdown oficial; última actualización nov 2025) | HECHO VERIFICADO |
| Gestión de redes | **Hootsuite** | No leído (pricing page localizada: hootsuite.com/pricing) | — | DESCONOCIDO (ver Huecos) |
| Gestión de redes | **Meta Business Suite** | Gratis (propiedad de Meta para administrar páginas de Facebook/Instagram) | — | SNIPPET (conocimiento general; página no leída) |
| Gestión de reseñas | **Birdeye** (referencia internacional) | **USD 299–449 por ubicación/mes** (reportes de terceros; Birdeye no publica lista) | theoryroad.com/insights/birdeye-pricing (secundario) | SNIPPET (fuente secundaria; confirmar con cotización) |
| Gestión de reseñas | **Podium** | No publicado en la sesión | — | DESCONOCIDO |
| Servicio humano equivalente | **Agencia/freelancer de redes sociales en México (pyme)** | **MXN 6,000–16,500/mes + IVA** (planes de un proveedor local con pauta Meta Ads de MXN 1,000–3,000 incluida; actualizado 29 oct 2026). Rango de mercado más amplio reportado por varias agencias mexicanas en contenido 2026 | soyroger.com (proveedor individual, leído); digiclic-marketing.com, sinjaula.com, shortway.com.mx (ubicados, no leídos) | HECHO VERIFICADO (caso individual); SNIPPET (rango ampliado) |

Implicación de plausibilidad (ESTIMACIÓN):
- MXN 500/mes está **por debajo** de cualquier herramienta individual de este mercado (Wix Core regular MXN 230 solo por el sitio; Metricool Starter USD 20 ≈ MXN 376 solo por redes). Un plan de MXN 500 que incluya sitio + publicaciones + atención de comentarios es agresivo pero plausible como **entrada** solo si la IA mantiene el costo marginal muy bajo.
- MXN 1,000–2,000 cae dentro del rango de herramientas combinadas (sitio + redes ≈ MXN 400–800 en herramientas sin servicio) y **muy por debajo** del costo de una agencia (MXN 6,000+). El posicionamiento "herramienta-asistida" con IA cabe en MXN 1,000–2,000 con margen; el valor a demostrar es la sustitución parcial de la agencia.
- Birdeye a USD 299+/ubicación confirma que la gestión de reseñas profesional es carísima en referencia internacional; un componente de reseñas dentro de un plan MXN 1,000–2,000 es un argumento de diferenciación fuerte (HIPÓTESIS de posicionamiento).

---

## 7. Costos operativos de soporte y churn (solo referencia)

| Referencia | Valor | Fuente (2026-11-03) | Etiqueta |
|---|---|---|---|
| Salario de **agente de contact center** en México | **MXN 10,255/mes** (media, 171 salarios reportados; rango observado MXN 3,800–17,680; actualizado 29 oct 2026) | mx.computrabajo.com/salarios/agente-de-contact-center | HECHO VERIFICADO (estadística de plataforma laboral) |
| Referencia alternativa | Agente bilingüe: MXN 12,982/mes (media); ejecutivo telemarketing: MXN 8,144/mes | Misma página | HECHO VERIFICADO |
| Conversión a costo por hora (ESTIMACIÓN) | Salario mensual ÷ ~173 h laborables efectivas ≈ **MXN 59/h**; costo empleador total (IMSS + prestaciones ~30–40 %) ≈ MXN 77–83/h ≈ **USD 4.1–4.4/h** (FIX 18.7962). Fórmula: 10,255×1.35 ÷ 173 ÷ 18.7962 | Cálculo propio sobre dato Computrabajo; factor de cargas sociales HIPÓTESIS estándar | ESTIMACIÓN (cargas sociales no verificadas) |
| Costo por ticket (ESTIMACIÓN) | 8 tickets/h de agente → **MXN 9.6–10.4/ticket** (~USD 0.51–0.55); 160 tickets/mes por cliente activo sería USD 82/mes — **inviable** a MXN 500; el soporte humano debe apalancarse en IA (asistente del dueño, respuestas sugeridas) y self-service | Fórmula propia; throughput de 8/h HIPÓTESIS (no medido) | ESTIMACIÓN |
| **Churn SaaS** (red Recurly, datos jul 2026) | Mediana anual: **SaaS 3.22 %** (voluntario 2.16 %, involuntario 1.06 %); por ARPC: **USD 10–25: 4.29 % total** (involuntario 1.30 %); USD 25–50: 3.84 % total (involuntario 1.11 %); USD 50–100: 3.15 % | recurly.com/research/churn-rate-benchmarks/ | HECHO VERIFICADO |
| Churn SMB (agregador de terceros) | "~4.5 % churn mensual promedio en SaaS SMB" | retentioncheck.com/churn-benchmarks/smb-saas | SNIPPET (fuente secundaria no leída; usar con cautela) |

Lecturas: los planes MXN 500–2,000 (USD 26.6–106.4) caen en los tramos ARPC USD 25–50 y 50–100 de Recurly → churn anual esperado **~3.8 %–3.2 %** si MainSpot se comporta como SaaS B2B promedio; el churn **involuntario** (1.1–1.3 % anual) es directamente reducible con dunning/retries del PSP — arguye por Stripe Billing o Conekta/Openpay con motor de reintentos, no por "cobro manual" (HIPÓTESIS de diseño). El churn reportado por Recurly es **anual** sobre su red (mezcla de planes); para planes mensuales de microempresa el churn mensual efectivo puede ser mayor (SNIPPET de terceros sugiere 4–5 %/mes); verificar con cohortes propias una vez en operación (NO MEDIDO).

---

## Fuentes

1. Banco de México — Tipos de cambio Peso/Dólar (FIX y Cierre de Jornada). https://www.banxico.org.mx/tipcamb/llenarTiposCambioAction.do — consultado 2026-11-03. Extraído: FIX 18.7962 del 30/10/2026, Cierre de Jornada 18.8037, definiciones oficiales del FIX y su publicación en DOF.
2. TipoCambioDOF — FIX de los últimos cinco días hábiles y fecha de publicación en DOF. https://tipocambiodof.com/fix — 2026-11-03. Extraído: serie 26–30 oct 2026 (18.5798–18.8148); DOF publica el FIX 18.7962 el 3 nov 2026. (Fuente secundaria que reproduce SIE/DOF.)
3. Stripe México — Tarifas y comisiones. https://stripe.com/mx/pricing — 2026-11-03. Extraído: 3.6 % + MXN 3.00 tarjeta nacional; +0.5 % internacional; +2 % conversión; MSI 5–22.5 %; disputa MXN 150; exclusiones de IVA.
4. Stripe México — Tarifas para métodos de pago locales. https://stripe.com/mx/pricing/local-payment-methods — 2026-11-03. Extraído: OXXO 4 % + MXN 3.00; transferencias bancarias MXN 7.00 + IVA.
5. Mercado Pago México — Link de pago. https://www.mercadopago.com.mx/herramientas-para-vender/link-de-pago — 2026-11-03. Extraído: 3.49 % + $4.00 al instante (tarjeta/débito/Wallet/SPEI); 3.19 % (7 d); 2.95 % (30 d); OXXO 3.79 % + $4.00 (FAQ) vs 3.49 % (bloque superior, discrepancia); MSI 4.69–27.29 %.
6. Conekta — Planes y calculadora de comisiones. https://www.conekta.com/pricing — 2026-11-03. Extraído: tarjeta 3.4 % + $3.00 + IVA (mín. $5.40); efectivo 2.6 % + $3.00 + IVA + $10–13 del punto de pago; SPEI $12.50 + IVA; "todos los planes y tarifas son + IVA".
7. Openpay — Comisiones. https://www.openpay.mx/comisiones (renderizado con navegador; la URL de docs https://documents.openpay.mx/comisiones es una SPA sin contenido SSR) — 2026-11-03. Extraído: tarjeta nacional 2.9 % + $2.50 + IVA; internacional 4.10 % + IVA; SPEI $8.00 + IVA; efectivo 2.9 % + $2.50 + IVA + comisión Paynet; MSI 7.7–16.7 %; nota de "sujetas a análisis y aprobación".
8. Cloudflare — R2 Pricing. https://developers.cloudflare.com/r2/pricing/ — 2026-11-03 (página actualizada 2026-10-30). Extraído: $0.015/GB-mes; Class A $4.50/M; Class B $0.36/M; egress gratis; free tier; IA con duración mínima 30 días.
9. AWS — Lista de precios oficial AmazonS3, región us-east-1 (CSV). https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/20261015173540/us-east-1/index.csv — 2026-11-03 (publicación 2026-10-15). Extraído: S3 Standard $0.023/GB-mes primeros 50 TB (SKU WP9ANXZGBYYSGJEA, TimedStorage-ByteHrs), 0.022/0.021 siguientes tramos; PUT $0.005/1k; GET $0.0004/1k.
10. AWS — Lista de precios oficial AWSDataTransfer, us-east-1 (CSV). https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.csv — 2026-11-03. Extraído: free tier "100 GB de data transfer out agregados globalmente por mes" ($0.000); DTO tiers $0.090/$0.085/$0.070/$0.050 por GB (SKU HQEH3ZWJVT46JHRG).
11. AWS News Blog — "Free data transfer out to internet when moving out of AWS". https://aws.amazon.com/blogs/aws/free-data-transfer-out-to-internet-when-moving-out-of-aws/ — 2026-11-03 (publicado 2024-03-05, actualizado 2026-10-09). Extraído: 100 GB/mes gratis de DTO; egress gratis solo bajo el programa de migración fuera de AWS.
12. Google Cloud — Cloud Storage pricing. https://cloud.google.com/storage/pricing — 2026-11-03. Extraído: Standard regional us-central1 $0.000027397/GiB-h (≈$0.020/GB-mes); multi-región US $0.026; operaciones Class A $0.005/1k y Class B $0.0004/1k.
13. Neon — Pricing Plans. https://neon.com/pricing (markdown oficial) — 2026-11-03 (actualizada 2026-10-31). Extraído: Free/Launch/Scale; Launch $0.106/CU-h y $0.35/GB-mes; workloads típicos $15/$80/$353 (Launch) y $701 (Scale); ejemplo DB-per-tenant 100 tenants ≈ $85/mes; egress 500 GB incluido.
14. AWS — Amazon SES Pricing. https://aws.amazon.com/ses/pricing/ — 2026-11-03. Extraído: Essentials $0.16/1,000 (0–10M), à la carte $0.10/1,000, planes Pro/Enterprise con fee fijo.
15. MEXISERVER — Precios de dominios (registrador mexicano). https://clientes.mexiserver.com/domain/pricing — 2026-11-03. Extraído: .mx $749 nuevo / $799 renovación; .com.mx $299/$499; .com $329/$343 (MXN, 1 año).
16. Meta for Developers — Rate Limits (Graph API). https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ — 2026-11-03. Extraído: Platform limits 200 × usuarios/hora; Pages API con page token 4800 × usuarios comprometidos/24 h; límites de Messenger/Instagram (2 calls/s conversaciones; 750/h private replies).
17. Google — Google Business Profile APIs: FAQ y Quota limits. https://developers.google.com/my-business/content/faq y https://developers.google.com/my-business/content/limits — 2026-11-03. Extraído: acceso por solicitud (revisión ≤14 días); 300 QPM por defecto; edits 10/min por perfil no ampliable; sin cobro documentado.
18. Telegram — Bots FAQ. https://core.telegram.org/bots/faq — 2026-11-03. Extraído: límites de broadcast (30 msg/s gratis; paid broadcasts 0.1 Stars/mensaje vía BotFather; 1 msg/s por chat; 20 msg/min por grupo).
19. Meta — Pricing on the WhatsApp Business Platform (docs) + rate cards oficiales USD/MXN (XLSX descargados de los enlaces del propio docs; vigentes desde 1 oct 2026). https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — 2026-11-03. Extraído: cobro por mensaje entregado por categoría; México: marketing $0.0397/0.7298, utility/auth/service $0.0085/0.1565; Meta Business Agent $2.00/1M tokens; 1,000 service messages/mes gratis por número; FEP 72 h; facturación en MXN desde ene 2026; calendarización trimestral de cambios de precio.
20. Wix — Información de precios (es.wix.com/pricing, renderizado con navegador) — 2026-11-03. Extraído: planes anuales en MXN: Light 125, Core 115 (promo de 230), Business 190 (de 380), Business Elite 390 (de 780); nota de impuestos según dirección de facturación.
21. Hostinger — Planes y precios (hostinger.com/mx/precios, markdown oficial) — 2026-11-03. Extraído: Single 24.99 (renueva 89.99); Premium 32.99 (149.99); Unlimited 49.99 (299.99); Cloud Startup 140.99 (455.99) MXN/mes en compromiso de 48 meses.
22. Metricool — Pricing. https://metricool.com/pricing/ — 2026-11-03. Extraído: Free; Starter USD 20 (5 marcas)/36 (10); Advanced USD 53 (15)/69 (25)/130 (50) por mes.
23. Buffer — Pricing (buffer.com/pricing, markdown oficial; precios actualizados nov 2025) — 2026-11-03. Extraído: Free 3 canales; Essentials desde $6/canal/mes; Team $12/canal; descuentos por volumen (hasta $1/canal con 51+); nota fiscal (VAT solo UK).
24. Recurly Research — Churn rate benchmarks (datos de la red Recurly, jul 2026). https://recurly.com/research/churn-rate-benchmarks/ — 2026-11-03. Extraído: churn anual mediano SaaS 3.22 % (vol 2.16/inv 1.06); por ARPC $10–25: 4.29 % (inv 1.30 %); $25–50: 3.84 %; $50–100: 3.15 %.
25. Computrabajo México — Salario de Agente de contact center. https://mx.computrabajo.com/salarios/agente-de-contact-center — 2026-11-03 (actualizado 29 oct 2026). Extraído: media MXN 10,255/mes (171 salarios); agente bilingüe 12,982; ejecutivo telemarketing 8,144.
26. Soy Roger (agencia/freelancer, CDMX) — "¿Cuánto cuesta el manejo de redes sociales en México? 2026". https://www.soyroger.com/guias/cuanto-cuesta-el-manejo-de-redes-sociales.php — 2026-11-03 (actualizado 29 oct 2026). Extraído: planes MXN 6,000 / 9,500 / 16,500 + IVA al mes con pauta Meta Ads MXN 1,000–3,000 incluida.
27. Colegio de Contaduría Pública de México — Boletín "IVA de plataformas digitales en operaciones con residentes en el extranjero" (22 sep 2023). https://www.contadoresmexico.org.mx/Boletin/IVA-plataformas-digitales-operaciones-residentes-extranjero — 2026-11-03. Extraído: catálogo de servicios digitales del régimen 18-J; obligaciones del proveedor extranjero; IVA de importación de servicios pagado por el adquirente mexicano.
28. Cámara de Diputados — Ley del Impuesto al Valor Agregado (texto vigente). http://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf — URL verificada como referencia normativa; PDF no leído íntegro en esta sesión (ver Huecos).

---

## Huecos (lo no verificado y cómo verificarlo)

1. **Rango del FIX 3–6 meses (may–oct 2026).** La serie diaria SIE (`CF373`) y la API de Banxico requieren token gratuito; en esta sesión solo se verificaron 5 días hábiles vía agregador. Cómo verificarlo: solicitar/almacenar un token de la API SIE de Banxico y descargar la serie, o consultar el cuadro `CA91` en el sitio SIE con JavaScript habilitado, o el DOF (dof.gob.mx/indicadores.php). Etiqueta actual: DESCONOCIDO.
2. **IVA sobre las tarifas de Mercado Pago** (y la discrepancia interna de su página: 3.49 % vs 3.79 % en OXXO/efectivo). Verificar: sección "Comisiones" de la cuenta (mercadopago.com.mx/costs-section) o ticket a soporte; consultar la tabla oficial de comisiones vigente del portfolio. Etiqueta: DESCONOCIDO.
3. **Tarifas internacionales de Conekta** (sobretasa por tarjeta extranjera) y tarifas de MSI de Conekta. Verificar: cotización de ventas de Conekta o dashboard tras activar cuenta (las tarifas publicadas solo cubren nacional/efectivo/SPEI/BNPL). DESCONOCIDO.
4. **CDN/hosting del sitio estático**: si el dominio personalizado sobre buckets R2 requiere plan de pago de Cloudflare (Workers/Pages) y su costo. Verificar: docs de R2 "public buckets" + pricing de Workers (developers.cloudflare.com). DESCONOCIDO. Impacto: es costo de plataforma (no por cliente), pero debe entrar al overhead fijo.
5. **Tarifa oficial de NIC México** (registro .mx directo, vs registrador). Verificar: nic.mx / sección de costos del registro. SNIPPET vs oficial.
6. **Monitoreo** (Grafana Cloud / UptimeRobot) y su costo a escala. Verificar: páginas de pricing de ambos. DESCONOCIDO. Impacto pequeño (costo compartido).
7. **GoDaddy Website Builder y Squarespace en MXN/USD actuales.** Verificar: godaddy.com/es/paginas-web/creador-de-paginas-web (precios) y squarespace.com/pricing con navegador. DESCONOCIDO.
8. **Hootsuite y precios 2026** (y si publican); Meta Business Suite "gratis" (confirmar que no cobre por funciones clave hoy). Verificar: hootsuite.com/pricing y business.facebook.com. DESCONOCIDO/SNIPPET.
9. **Podium (precio público)**. Verificar: cotización directa (no publican lista). DESCONOCIDO.
10. **Texto literal de la LIVA** (tasa 16 %, arts. 18-D/18-J, art. 26 importación de servicios) y **tratamiento de ISR/retenciones** para pagos de MainSpot a proveedores extranjeros. Verificar: lectura del PDF oficial de LIVA/LISR y consulta al contador fiscal de MainSpot. Etiqueta actual: normativa citada pero no leída íntegra; ISR DESCONOCIDO.
11. **Cargos por factura/invoicing en Stripe** (si MainSpot emite facturas con CFDI, el CFDI lo genera MainSpot con su PAC mexicano, no Stripe — confirmar stack de facturación: costo de PAC/CFDI por timbre, típicamente MXN 1–3/timbre; no verificado en esta sesión). Verificar: cotizaciones de PACs mexicanos. DESCONOCIDO — relevante porque facturar CFDI a clientes pymes es práctica esperada y añade costo por transacción.
12. **Mix de métodos de pago de microempresas mexicanas en suscripciones** (nacional vs internacional vs OXXO vs SPEI). No existe fuente pública confiable; construir con datos propios tras operación (NO MEDIDO).
