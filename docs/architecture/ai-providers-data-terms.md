# Proveedores de IA — verificación única de términos y tratamiento de datos (DEC-0067 / DEC-0071)

Fecha de acceso a todas las fuentes: **2026-11-03**. Autor: agente `ProviderTermsResearch` (investigación; no
decide). Este documento es la verificación «una sola vez» que piden DEC-0067 (TypeSafe/Jev) y DEC-0071
(Anthropic texto, OpenAI imágenes) antes de enviar datos de negocios reales. No sustituye asesoría legal.

Leyenda:

- **VERIFICADO**: leído hoy en una fuente primaria del proveedor (términos, DPA, política, docs, trust center);
  se cita textualmente (cita corta, en inglés tal como aparece) con URL.
- **NO VERIFICABLE PÚBLICAMENTE**: depende de un contrato, orden o configuración de cuenta que solo el
  propietario posee; se indica qué debe confirmar él.
- **[INFERENCE]**: lectura/interpretación del agente, no afirmación del proveedor.

## 0. Qué datos saldrían y hacia qué proveedor

Según el código y el canon vigentes (README §5.1, `src/ai/catalog.ts`, DEC-0069, DEC-0072):

| Proveedor | Uso en MainSpot | Datos que salen (reales, tras DEC-0067/0071) | Modelo previsto |
|---|---|---|---|
| TypeSafe (Jev, `api.typesafe.ai/v1/systemone`) | Clasificación semántica: intención, sentimiento, categoría, urgencia, riesgo, reseñas/comentarios, comprensión de peticiones de edición | Texto del mensaje/reseña/comentario + preguntas fijas, sin metadata de tenant/actor/cuenta ni credenciales. El intake limita a 8 KiB; atención sustituye contactos reconocibles por marcadores. No equivale a anonimización de todo el texto libre | `jev-1.14.0` fijado (`ts:jev-1.14.0`) |
| Anthropic (Messages API) | Texto generativo: conversación con el dueño, diseño/edición web, publicaciones, respuestas a reseñas/comentarios, campañas, insights | Marca, instrucciones del dueño, texto de comentarios/reseñas de clientes del negocio, contenido del sitio | Claude Haiku 5.5 / Sonnet 5.5 (catálogo actual). **No** son «Covered Models» (ver §2.4) |
| OpenAI (Images API) | Imágenes para web y redes | Prompt de texto (`ImageRequest.prompt`): descripción de marca/producto. No se envían fotos ni archivos (el contrato `ImageRequest` no los admite) | `gpt-image-2` |

Jurisdicción de MainSpot: SaaS operado desde México para pymes mexicanas; los titulares de datos son los clientes
de esos negocios. Los tres proveedores contratan desde EE. UU. (TypeSafe AI, Inc.; Anthropic, PBC; OpenAI OpCo,
LLC) y sus servicios se alojan en EE. UU. → toda llamada es una **transferencia internacional México → EE. UU.**
MainSpot actúa como encargado de los negocios (responsables), de modo que el proveedor es **subencargado**
[INFERENCE: calificación bajo la ley mexicana, a confirmar por el asesor legal del propietario; los tres DPA
prevén ese escenario con el Módulo 3 de las SCC]. México figura en las listas de países soportados de OpenAI
(`developers.openai.com/api/docs/supported-countries`, «Mexico») y de Anthropic
(`anthropic.com/supported-countries`, «Mexico») — VERIFICADO.

---

## 1. TypeSafe (Jev)

Fuentes primarias leídas: `https://docs.typesafe.ai/legal` (índice legal), `https://typesafe.ai/legal/mca`
(Master Customer Agreement, «Last updated Sep 23, 2026»), `https://typesafe.ai/legal/data-processing` (DPA,
«Last updated Apr 24, 2026»), `https://typesafe.ai/legal/privacy-policy` («Last updated Nov 19, 2025»),
`https://typesafe.ai/legal/acceptable-use-policy` («Sep 23, 2026»), `https://typesafe.ai/legal/terms` (Terms of
Use del sitio, «Sep 19, 2026»), `https://docs.typesafe.ai/models`, `https://trust.typesafe.ai/` y
`https://trust.typesafe.ai/subprocessors` (Trust Center en Vanta; contenido renderizado con navegador).

### 1.1 DPA: aplicación y forma de aceptación — VERIFICADO

- El MCA es un contrato de aceptación por clic/uso que cubre la API: «BY ACCEPTING THE AGREEMENT, EITHER BY
  CLICKING A BOX INDICATING YOUR ACCEPTANCE, EXECUTING AN ORDER THAT REFERENCES THIS MASTER CUSTOMER AGREEMENT,
  USING (OR MAKING ANY PAYMENT FOR) ANY SERVICES … YOU: (A) AGREE TO THE AGREEMENT» (MCA, preámbulo). Los
  «Services» son la consola y «the TypeSafe-hosted application programming interface» (MCA §1).
- El DPA se incorpora automáticamente, sin firma: «The terms of the Data Processing Agreement currently
  available at https://typesafe.ai/data-processing are incorporated herein by reference» (MCA §4.4). El DPA
  prevalece en caso de conflicto (DPA §1.3).
- Si el propietario firmó un acuerdo separado, ese manda: «IF … AN AUTHORIZED REPRESENTATIVE OF THE ENTITY HAS
  … ENTERED INTO A SEPARATE WRITTEN AGREEMENT … THEN (I) THIS AGREEMENT WILL NOT APPLY» (MCA, preámbulo).
- **NO VERIFICABLE PÚBLICAMENTE**: bajo qué instrumento está la cuenta de MainSpot (MCA por clic, una Order, o
  el «contrato de privacidad» que el propietario menciona en DEC-0072) y su versión/fecha. El MCA puede
  actualizarse con 60 días de aviso (MCA §16.7).

### 1.2 Rol sobre el contenido — VERIFICADO

«Customer is the “controller” and “business” …, and Typesafe is the “processor” and “service provider”» (DPA
§1.1). Procesa solo para prestar el servicio y bajo instrucciones documentadas (DPA §2.1); no vende ni comparte,
ni combina con datos de terceros (DPA §2.2). Schedule I: exportador = Customer (Controller); importador = Typesafe
(«Processor on behalf of Customer»); categorías de titulares «Customer and Customer’s users»; datos «the content
of which is determined and controlled by Customer»; datos sensibles «N/A».

### 1.3 Entrenamiento con entradas/salidas — VERIFICADO (no se entrena; no hay opt-in por defecto)

- Privacy Policy: «We (1) will not train or fine tune any artificial intelligence or machine learning models on
  Input, and (2) will not disclose any Input to a third party other than our service providers.»
- MCA §4.1: «TypeSafe will not, include Customer Data in a dataset used to train (i.e., to modify the model
  weights of) any artificial intelligence or machine learning models without Customer’s prior consent.»
- Docs de modelos: «Jev is not trained on customer requests or responses.»
- **Matiz a vigilar**: la «Telemetry» («technical logs, hashes, summary statistics and classifications, metrics,
  and learnings related to Customer’s use») puede procesarse «without restriction, including to improve the
  Services» y la licencia sobre Customer Data para derivar Telemetry es «in perpetuity» (MCA §4.1(c), §4.3).
  [INFERENCE] Telemetry no es contenido, pero sí puede incluir estadísticas/clasificaciones derivadas de los
  mensajes; refuerza la condición de no enviar identificadores en el `state`.

### 1.4 Retención — VERIFICADO parcialmente; sin plazo numérico público

- DPA Schedule I §8: «Customer Personal Data will be retained for as long as necessary taking into account the
  purpose of the Processing, and in compliance with applicable laws».
- MCA §10.3: «TypeSafe will be under no obligation to store or retain Customer Data and may delete Customer Data
  at any time in its sole discretion»; backups: «Customer Confidential Information may be retained in TypeSafe’s
  standard backups».
- MCA §4.1(c): licencia **a perpetuidad** sobre Customer Data «to monitor for fraud and abuse of the Services» y
  para cumplir la ley → no hay plazo máximo publicado para registros de abuso.
- Subencargados (Trust Center): «Customer AI prompts are processed, but not stored, on compute nodes managed by
  Modal» (ídem Nebius y CoreWeave); pero «Customer information for live requests is stored and processed on
  databases, caches and compute nodes within AWS» → [INFERENCE] los prompts no persisten en los nodos de
  inferencia, pero sí puede haber almacenamiento de la petición en AWS; el plazo no está publicado.
- **ZDR**: «We also offer zero data retention (ZDR) for enterprise customers. To learn more, fill out the support
  request form» (`docs.typesafe.ai/legal`; formulario `https://support.typesafe.ai/forms/support-request`).
  **NO VERIFICABLE PÚBLICAMENTE** si la cuenta de MainSpot tiene ZDR; el canon actual dice «No se asume ZDR»
  (README §5.1, COGNITIVE-JEV.md).
- Trust Center → controles «Data retention procedures established», «Customer data deleted upon leaving».

### 1.5 Subencargados y transferencias — VERIFICADO

- Lista (14, `trust.typesafe.ai/subprocessors`, última actualización publicada «Nebius and CoreWeave — Published
  October 2, 2026»): AWS (USA, almacenamiento/proceso de peticiones), Modal, Nebius, CoreWeave (USA, inferencia
  sin almacenamiento), Microsoft Azure, Google Cloud Platform, Cloudflare, Stytch, WorkOS, Loops, ClickHouse
  («Data warehousing»), Slack, Google Workspace, Pylon (soporte). Los de colaboración/soporte solo ven datos que el
  cliente les envíe por esos canales.
- Autorización general + aviso previo + objeción en 15 días (DPA §3.1–3.2).
- Transferencias: SCC de la UE (Módulo 2 y, si el cliente es encargado, Módulo 3) y UK Addendum (DPA §6);
  «The Services are hosted in the United States» (Privacy Policy, International Visitors). No hay mecanismo
  específico para México: [INFERENCE] la base para la remisión México → EE. UU. es el propio DPA/contrato de
  encargo y la ley mexicana (a confirmar por el asesor legal).

### 1.6 Seguridad — VERIFICADO

- DPA §5.1 medidas «reasonable and appropriate»; §5.2 aviso de incidente «without undue delay and in any case
  within 72 hours»; §5.3 auditoría del cliente una vez cada 12 meses a su costo.
- Trust Center: «SOC 2 Type II - 2026» (informe disponible bajo «Request access»), controles «Data encryption
  utilized», «Encryption key access restricted», «Unique account authentication enforced», planes de continuidad
  probados. Privacy Policy: «we can make no guarantees as to the security or privacy of your data».

### 1.7 Restricciones relevantes — VERIFICADO

- Obligaciones del cliente: «Customer … has obtained (and will maintain) all rights, consents, and permissions
  necessary for TypeSafe to exercise the rights granted … (including the rights granted with respect to Input)»
  (MCA §5) → MainSpot/los negocios deben tener base legal y aviso para enviar mensajes de clientes.
- AUP §1.1 prohíbe «infringe … another person’s … privacy … rights»; §1.7 «disclose sensitive information
  without permission»; §1.4 «mislead others about whether content, including Output, was generated by AI»;
  §3.8 no acceder a datos de otros clientes.
- Menores: Privacy Policy «no part of the Services is directed to children» (<18); AUP §2 seguridad infantil.
  [INFERENCE] Que un cliente del negocio sea menor no está prohibido por sí mismo; lo prohibido es dirigir el
  servicio a menores o dañarlos.
- Decisiones automatizadas: no hay cláusula específica. MCA §9.3: «THE SERVICES MAY PRODUCE INACCURATE OR
  ERRONEOUS OUTPUT; (II) CUSTOMER IS RESPONSIBLE FOR INDEPENDENTLY EVALUATING THE OUTPUT».
- Idioma: «English is the primary training language … Other languages … are handled but not equally well; test
  on your own content» (docs/models). No es término contractual; el gate D4 (README §5.1) ya cubre la calidad en
  español.
- Export: no enviar información ITAR (MCA §16.12). Terms of Use del **sitio** §13(g) dice «intended for visitors
  located within the United States», pero el MCA (que rige la API) no limita geografía.
- Responsabilidad: cap «THE GREATER OF (A) THE AMOUNTS PAID … DURING THE 12 MONTHS … AND (B) $50 USD» (MCA
  §12.2); arbitraje JAMS en San Francisco (MCA §15); el cliente indemniza por reclamaciones «relating to Input»
  (MCA §13.2).

### 1.8 Conflictos con las condiciones del propietario

| Condición DEC-0067 | Cobertura |
|---|---|
| Acuerdo cubre el procesamiento previsto | Sí (MCA + DPA, processor; sin entrenamiento). Pendiente confirmar instrumento/versión de la cuenta. |
| Aislamiento por negocio | Responsabilidad de MainSpot (no se envía tenant). Sin conflicto. |
| Acceso autorizado | Credenciales de MainSpot; Trust Center controles de acceso. Sin conflicto. |
| Minimización | Compatible; Telemetry/«classifications» a perpetuidad refuerza no enviar identificadores. |
| Protección de credenciales | MCA §2.4 obliga a confidencialidad de la API key. Sin conflicto. |
| Trazabilidad | `jev_classification` + `ai_invocation` locales. Sin conflicto. |
| Gestión de retención | **Parcial**: sin plazo publicado; licencia perpetua para abuso/ley; ZDR solo «enterprise» bajo solicitud. |

---

## 2. Anthropic (Claude API — texto)

Fuentes primarias leídas: `https://www.anthropic.com/legal/commercial-terms` («Effective Jun 17, 2025»),
`https://www.anthropic.com/legal/data-processing-addendum` («Effective Feb 24, 2025»),
`https://www.anthropic.com/legal/service-specific-terms` («Effective Aug 31, 2026»),
`https://www.anthropic.com/legal/aup` (Usage Policy, «Effective Nov 12, 2026»),
`https://privacy.claude.com/en/articles/7996866-…` (retención comercial, «July 1, 2026»),
`https://privacy.claude.com/en/articles/7996868-…` (entrenamiento, «August 18, 2026»),
`https://privacy.claude.com/en/articles/8956058-…` (ZDR), `https://privacy.claude.com/en/articles/15425996-…`
(Covered Models), `https://platform.claude.com/docs/en/manage-claude/api-and-data-retention` (docs de
retención/ZDR por función), `https://trust.anthropic.com/subprocessors` (renderizado con navegador),
`https://www.anthropic.com/supported-countries`.

### 2.1 DPA: aplicación y forma de aceptación — VERIFICADO

- Commercial Terms rigen «Customer’s use of Anthropic API keys»; se aceptan al consentir electrónicamente o al
  primer acceso («effective on the earlier of the date that Customer first electronically consents … and the date
  that Customer first accesses the Services»). Entidad: «Anthropic, PBC if Customer resides anywhere else» (fuera
  de EEE/Suiza/UK) → aplica a México; ley de California, arbitraje JAMS en San Francisco (§M.7, §J.2.b).
- DPA incorporado sin firma: «Data submitted through the Services will be processed in accordance with the
  Anthropic Data Processing Addendum (“DPA”), which is incorporated into these Terms by reference» (§C). El DPA
  prevalece en conflicto (DPA preámbulo). Las SCC «will be deemed to have been executed by the parties» (DPA
  §I.1).
- **Estado de cuenta no verificable públicamente**: el propietario ya provisionó una clave API; el catálogo
  autenticado respondió HTTP 200 el 2026-11-03. Eso no prueba la configuración privada de retención ni saldo.

### 2.2 Rol — VERIFICADO

«With respect to Customer Personal Data, Customer is the controller and Anthropic is Customer’s processor» (DPA
§B.1); solo procesa «to provide or maintain the Services, and in compliance with Customer’s documented
instructions» (§B.2); no vende/comparte ni combina (§B.3). Schedule 1: categorías de titulares y datos
«Determined by Customer»; «Special categories of personal data: None»; «Storage Limitation: The duration is the
term of the Agreement». Módulos 2 y 3 de las SCC (§A.8, §I.1).

### 2.3 Entrenamiento — VERIFICADO (prohibido por contrato; opt-in explícito aparte)

- «Anthropic may not train models on Customer Content from Services» (Commercial Terms §B).
- «By default, we will not use your inputs or outputs from our commercial products … to train our models»
  (privacy.claude.com 7996868). Excepciones solo con acción del cliente: feedback (pulgar arriba/abajo, 5 años)
  o «Development Partner Mode» (Service Specific Terms §E: «If Customer enables Development Partner Mode,
  Anthropic may use the data … including to train models»). Condición: **no activar** Development Partner Mode ni
  enviar feedback con contenido real.

### 2.4 Retención — VERIFICADO

- Por defecto: «For Anthropic API users, we automatically delete inputs and outputs on our backend within 30 days
  of receipt or generation» salvo Files API, acuerdo ZDR, Usage Policy o ley (7996866).
- Infracciones: «We retain inputs and outputs for up to 2 years and trust and safety classification scores for up
  to 7 years if your chat is flagged» (7996866; igual en docs «Retention regardless of arrangement»).
- ZDR: «Under a ZDR arrangement, Anthropic does not store customer prompts or responses at rest after the API
  response is returned. To request ZDR for your organization, contact the Anthropic sales team. ZDR is enabled
  per organization» (docs api-and-data-retention). «subject to Anthropic’s approval» (8956058). Se confirma en
  consola «Settings > Privacy Controls > Data retention period». Aun con ZDR se conservan «User Safety classifier
  results».
- Funciones que usa MainSpot y su elegibilidad ZDR (tabla «Feature eligibility»): Messages API «Yes»; Structured
  outputs / strict tools «Yes (qualified)»: «Only the JSON schema is cached, for up to 24 hours since last use»
  → **no poner datos personales en los esquemas** (nombres de propiedades, `enum`, `const`, `pattern`); nuestros
  esquemas son estáticos (`src/ai/schema.ts`), sin conflicto. Prompt caching «Yes» (KV en memoria durante el
  TTL). Batch API «No» (29 días) y Files API «No» — no se usan.
- **Covered Models**: «Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, and Claude Mythos 5 … require 30-day
  data retention and are not available under ZDR unless expressly authorized» (docs). El catálogo de MainSpot usa
  Haiku 5.5 / Sonnet 5.5 → no afectados. Condición: si en el futuro se añade un Covered Model, documentar la
  retención de 30 días.
- Eliminación al terminar: «Within thirty (30) days of … termination … delete all copies of Customer Data» (DPA
  §H.1) con excepciones legales/abuso.

### 2.5 Subencargados y transferencias — VERIFICADO

- Lista (22, `trust.anthropic.com/subprocessors`; la DPA Schedule 4 remite a `anthropic.com/subprocessors`,
  que redirige al Trust Center): infraestructura Google Cloud, AWS, Microsoft Azure («Worldwide», All Products),
  Cloudflare (CDN, «Local to Customer»), Stripe (billing), WorkOS, soporte Intercom (US), Nutun (Sudáfrica),
  Boldr (Canadá), Twilio, Iterable, Sentry, Sift, Arkose Labs, hCaptcha (fraude/abuso), Brave Search, TurboPuffer,
  Parallel (web search — no usado), ElevenLabs (Claude for Work), Palantir (gobierno), Persona/Yoti (consumidor).
- Autorización general; aviso previo; objeción en 15 días (DPA §C). SCC Módulo 2/3 + UK Addendum + Swiss
  Addendum (Schedule 3). Procesamiento global; existe «Data residency» (`inference_geo`) elegible ZDR/HIPAA,
  no requerido por MainSpot.

### 2.6 Seguridad — VERIFICADO

DPA Schedule 2: «a minimum of AES-256 for data at rest, and TLS1.2+ for data in transit»; MFA y SSO para
sistemas con Customer Data; RBAC de mínimo privilegio; pruebas de penetración anuales; SIEM/SOAR; segregación
lógica por cliente («no customer is able to access the data of any other customer»). Auditoría externa anual,
informes (p. ej. SOC 2) bajo solicitud (DPA §F.1). Aviso de brecha «within 48 hours» (DPA §G.1).

### 2.7 Restricciones relevantes — VERIFICADO

- Commercial Terms: «Customer further represents and warrants that it has all rights and permissions required to
  submit Inputs» (§L.1); D.3 obliga a evaluar las salidas y a avisar a los usuarios de que «factual assertions in
  Outputs should not be relied upon without independently checking». Responsabilidad limitada a «Fees paid … in
  the previous 12 months» (§L.3.a); el cliente indemniza por reclamaciones «related to … Inputs» (§K.2).
- Usage Policy publicada con fecha futura **Nov 12, 2026** (no se presenta como vigente al 3-nov):
  se aplican preventivamente las siguientes restricciones compatibles con el alcance aprobado:
  - «Do Not Compromise Privacy or Identity Rights»: no «sharing personal information without consent», no
    «Compile, aggregate, or enrich personal data … to build profiles … for sale».
  - **Chatbots de cara al cliente**: «All consumer-facing chatbots or AI agents that communicate directly with
    external users must disclose to users that they are interacting with AI … at a minimum at the beginning of
    each chat session or in the product interface» → condición obligatoria para las respuestas automáticas de
    MainSpot a clientes (BR-0007 ya exige opt-in y texto de consentimiento; debe incluir la revelación de IA).
  - No «fake reviews», no «Create or operate fake personas» → las respuestas a reseñas deben ser en nombre del
    negocio, nunca reseñas inventadas.
  - Menores: «Products serving minors … must comply with the additional guidelines» (artículo de soporte 9307344).
    [INFERENCE] MainSpot no está dirigido a menores; no aplica salvo que un negocio lo esté.
  - High-risk (legal, médico, financiero, crédito, empleo, vivienda…): exige humano cualificado y revelación. Los
    casos de uso de MainSpot (marketing, web, respuestas a reseñas) están en la exclusión «Business operations that
    do not advise or decide about a specific individual». Condición: no usar Anthropic para dar consejo
    legal/médico/financiero personalizado a clientes del negocio.
  - «Do Not Engage in Deceptive Campaigns»: astroturfing, fake reviews.

### 2.8 Conflictos con las condiciones del propietario

| Condición | Cobertura |
|---|---|
| Acuerdo cubre el procesamiento | Sí (Commercial Terms + DPA; processor; sin entrenamiento). |
| Aislamiento / acceso / credenciales / trazabilidad | Responsabilidad de MainSpot; segregación lógica en Anthropic. Sin conflicto. |
| Minimización | Compatible. No enviar datos personales en esquemas JSON (caché 24 h). |
| Gestión de retención | **Cubierta con plazo publicado (30 días)**; contenido marcado hasta 2 años. ZDR disponible solo por aprobación de ventas; opcional. |
| Uso previsto (respuestas automáticas a clientes) | Cubierto **a condición** de revelar que es IA al cliente final. |

---

## 3. OpenAI (API — imágenes `gpt-image-2`; texto posible)

Fuentes primarias leídas: `https://openai.com/policies/services-agreement/` (OpenAI Services Agreement, «Updated
December 1, 2025 / Effective January 1, 2026»; `policies/business-terms` redirige a esta página),
`https://openai.com/policies/data-processing-addendum/` (DPA, «Effective January 1, 2026»),
`https://openai.com/policies/service-terms/` (Service Terms, «Updated October 16, 2026»),
`https://openai.com/policies/usage-policies/` (publica «Effective November 20, 2026»: versión futura, no prueba de vigencia al 3-nov),
`https://openai.com/policies/sharing-publication-policy/` («Updated November 14, 2022»),
`https://openai.com/policies/sub-processor-list/` («Last updated October 14, 2026»),
`https://platform.openai.com/docs/guides/your-data` (sirve `developers.openai.com/api/docs/guides/your-data`),
`https://openai.com/enterprise-privacy/` («Updated January 8, 2026»),
`https://developers.openai.com/api/docs/models/gpt-image-2`, guía de generación de imágenes,
`https://cdn.openai.com/osa/security-measures.pdf`, `https://openai.com/index/response-to-nyt-data-demands/`
(actualización 22-oct-2025), `developers.openai.com/api/docs/supported-countries`.

### 3.1 DPA: aplicación y forma de aceptación — VERIFICADO

- Services Agreement: «This OpenAI Services Agreement only applies to use of OpenAI’s APIs … By clicking “I agree,”
  accepting the Order Form, or using the Services, Customer agrees to this Agreement.» Contratante para México:
  «OpenAI OpCo, LLC, for Customers located outside the EEA or Switzerland»; ley de California; arbitraje NAM en San
  Francisco (§15–16).
- DPA incorporado: «If Customer uses the Services to process Personal Data, OpenAI and Customer will comply with the
  DPA, which is incorporated by this reference into the Agreement» (§5.3). El DPA mismo: «By clicking “I agree,”
  accepting the Order Form, or using the Services, Customer agrees to this Agreement.» Además existe ejecución
  formal: «Please complete our DPA form to execute a DPA with OpenAI» (enterprise-privacy; enlace Ironclad
  `https://ironcladapp.com/public-launch/63ffefa2bed6885f4536d0fe`, también al pie del DPA «Execute Data
  Processing Agreement»). [INFERENCE] La incorporación por uso ya aplica; la ejecución en Ironclad da una copia
  firmada con fecha, recomendable como evidencia de la «verificación única».
- **Estado de cuenta no verificable públicamente**: el propietario ya provisionó una clave API; el GET
  autenticado de `gpt-image-2` respondió HTTP 200 el 2026-11-03. No acredita saldo/cuota ni ZDR.

### 3.2 Rol — VERIFICADO

«OpenAI acts as a Data Processor on the Customer’s behalf» (DPA §1.1); procesa solo según «Customer Instructions»
(§2.1); CCPA: no vende/comparte, no combina (§5.1). Schedule 1: titulares «Customer’s employees, customers,
suppliers and generally End Users»; sensibles: «No sensitive data is intended to be transferred unless the user
includes it unexpectedly in unstructured data». Módulo 2 y Módulo 3 de las SCC (§8.1, para UK; EEE vía OpenAI
Ireland §4.1).

### 3.3 Entrenamiento — VERIFICADO (no por defecto)

«OpenAI will not use Customer Content to develop or improve the Services, unless Customer explicitly agrees to
such use» (Services Agreement §4.2). «As of March 1, 2023, data sent to the OpenAI API is not used to train or
improve OpenAI models (unless you explicitly opt in to share data with us)» (your-data). Tabla por endpoint:
`/v1/images/generations` «Data used for training: No». Condición: no activar el opt-in de compartir datos ni los
mecanismos de feedback con contenido real.

### 3.4 Retención — VERIFICADO

- Registros de abuso: «By default, abuse monitoring logs are generated for all API feature usage and retained for
  up to 30 days, unless longer retention is required by law, or is reasonably necessary to protect our services or
  any third party from harm» (your-data). «Abuse monitoring logs may contain certain customer content, such as
  prompts and responses».
- Endpoints de MainSpot: `/v1/images/generations` y `/v1/images/edits`: abuse monitoring 30 días, «Application
  state retention: None», «Zero Data Retention eligible: Yes». «Image generation is Zero Data Retention compatible
  when using … `gpt-image-2`». Si se usara texto: `/v1/responses` guarda estado 30 días por defecto o con
  `store=true` («the Responses API has a 30 day Application State retention period by default») → condición:
  enviar `store: false` (o usar `/v1/chat/completions`, estado «None»).
- ZDR / Modified Abuse Monitoring: «these controls are subject to prior approval by OpenAI and acceptance of
  additional requirements … Get in touch with our sales team». Quien lo activa asume «ensuring their users abide by
  OpenAI's policies … and complying with any moderation and reporting requirements».
- Excepción de imágenes: «Image and file inputs are scanned for CSAM content upon submission. If the classifier
  detects potential CSAM content, the image will be retained for manual review, even if Zero Data Retention … is
  enabled» → MainSpot no envía imágenes de entrada, solo prompt de texto.
- Caché de prompts: tensores cifrados en GPU local, expiración 24 h (no aplica a imágenes).
- Legal hold NYT: «Our obligations under the earlier order ended on September 26, 2025 … API data will also be
  automatically deleted after 30 days»; solo se conserva el histórico abril–septiembre 2025 (no afecta a MainSpot,
  que aún no ha enviado datos).
- Al terminar: «OpenAI will delete all Customer Content from its systems within thirty days» (Services Agreement
  §11.3) salvo ley/acuerdo; puede conservar «Abusive Customer Content».
- Revisión humana: «Our access to API business data stored on our systems is limited to (1) authorized employees …
  and (2) specialized third-party contractors … solely to review for abuse and misuse» (enterprise-privacy).

### 3.5 Subencargados y transferencias — VERIFICADO

- Lista (Oct 14, 2026): Cloudflare (CDN), Microsoft (cloud, incluye «Mexico» entre ubicaciones), CoreWeave, Oracle
  Cloud, Google Cloud, AWS, Cerebras (infra), Snowflake (warehousing, «Except where Zero Data Retention (ZDR) is
  used»), TaskUs (Filipinas) y Accenture (US/Canadá/Filipinas) «Moderation of content», Salesforce y Pylon
  (soporte), Fivetran (ETL), Cinder («Platform for content moderation», excepto ZDR); WorkOS y Merge solo
  ChatGPT. Moderación: «OpenAI may share samples of the flagged Customer Content with relevant Sub-processors».
- Afiliadas OpenAI con SCC entre ellas (OpCo US, Ireland, UK, Japan).
- Objeción a nuevos subencargados en 30 días (DPA §2.9). Residencia de datos (`us.api.openai.com` etc.) disponible;
  no requerida para MainSpot.

### 3.6 Seguridad — VERIFICADO

Services Agreement §5.1–5.2: «OpenAI will comply with the Security Measures»; informes de auditoría a petición una
vez al año. Security Measures (PDF): «Encryption of data at rest in production datastores», «Encryption of data in
transit», «Penetration testing is conducted on the Services at least annually», «SOC 2 Type II certification
audits», plan de respuesta a incidentes. Enterprise-privacy: «AES-256 … TLS 1.2+», SOC 2 Type 2 para la API.
Aviso de brecha «without undue delay» (DPA §2.7, sin plazo en horas).

### 3.7 Restricciones relevantes — VERIFICADO

- Services Agreement §3.3: no «allow minors to use OpenAI Services without consent from their parent or guardian»
  [INFERENCE: se refiere a usuarios del servicio, es decir dueños/personal de los negocios; los clientes finales
  no «usan» OpenAI]; §4.3 el cliente garantiza «all rights, licenses, and permissions required to provide Input».
- Service Terms §6 (Image and Video Capabilities): «You may not use Visual Capabilities to assist in identifying a
  person nor to solicit or infer private or sensitive information about a person. You may not use Visual
  Capabilities to reproduce the likeness of any person without express consent» → no generar imágenes de personas
  reales (dueño, clientes, empleados) sin consentimiento; prompts solo de marca/producto/escena.
- Usage Policies: «use of someone’s likeness, including their photorealistic image or voice, without their consent
  in ways that could confuse authenticity» prohibido; «deceit, fraud, scams, spam, or impersonation»; «building or
  offering AI tools that provide others with tailored advice that requires a license». Nada específico de pymes/
  marketing. «If you operate a model-access intermediary platform … you must obtain our prior review» — no aplica
  («does not apply solely because an application integrates OpenAI models»).
- Sharing & Publication Policy (2022, incorporada como «OpenAI Policies» en el Services Agreement): al publicar
  contenido en redes, «Manually review each generation before sharing», «Indicate that the content is AI-generated
  in a way no user could reasonably miss or misunderstand» → condición para imágenes publicadas en Facebook/web:
  revisión humana previa (ya existe preview/confirmación) y **etiquetado de imagen generada por IA** en la
  publicación.
- Moderación de imágenes: «All prompts and generated images are filtered in accordance with our content policy»;
  parámetro `moderation` `auto` (por defecto) o `low`; errores `moderation_blocked`. Condición: dejar `auto`.
- Responsabilidad: cap 12 meses de pagos (§14.2); indemnización de OpenAI por infracción de PI de las salidas con
  exclusiones (Service Terms §1(a)); el cliente indemniza por «Customer Content» (§13.2).

### 3.8 Conflictos con las condiciones del propietario

| Condición | Cobertura |
|---|---|
| Acuerdo cubre el procesamiento | Sí (Services Agreement + DPA; processor; sin entrenamiento). |
| Minimización | Compatible: solo prompt de texto; sin fotos de personas. |
| Gestión de retención | Cubierta con plazo publicado (30 días de logs de abuso; sin estado para imágenes). ZDR disponible solo por aprobación. |
| Publicación de contenido generado | Cubierto **a condición** de revisión humana y etiquetado «generado con IA». |
| Texto (si se evaluara) | Cubierto con `store:false` y sin opt-in de datos. |

---

## 4. Veredicto por proveedor

| Proveedor | Veredicto | Condiciones técnicas que MainSpot debe aplicar | Acción del propietario |
|---|---|---|---|
| **TypeSafe (Jev)** | **COVERED_WITH_CONDITIONS** | Texto mínimo y preguntas; no añadir metadata de identidad ni credenciales. Atención redacta contactos reconocibles; el mensaje libre del dueño sigue siendo el contenido autorizado (no anonimización garantizada). Proveedor directo y versión fijada, claves protegidas, aislamiento y trazas locales. Documentar retención sin plazo numérico y sin ZDR asumido. El DPA dice sensibles «N/A»: no ampliar el producto a expedientes sensibles; no implica prohibir toda queja que mencione salud. Una categoría nueva de tratamiento exigiría revisar cobertura. | Verificación basada en MCA/DPA públicos incorporados por uso; no se ha inspeccionado un acuerdo privado de cuenta. Archivar copia de ese acuerdo si existe y revisar cualquier diferencia material. ZDR opcional, no nuevo bloqueo ni autorización por mensaje. Mantener aviso/base legal aplicable. |
| **Anthropic (texto)** | **COVERED_WITH_CONDITIONS** | API comercial con clave propia; sin Development Partner Mode ni feedback de contenido real. Messages, sin Files/Batch; esquemas estáticos sin datos personales. Revelación de IA en respuestas automáticas; sin consejo regulado personalizado. No se asume ZDR; retención estándar y excepciones documentadas. | Clave provisionada y catálogo autenticado. Falta saldo para generación. Controles privados de retención/opt-in no inspeccionados; conservar valores comerciales por defecto, sin activar compartición. Solicitar ZDR es opcional. |
| **OpenAI (`gpt-image-2`)** | **COVERED_WITH_CONDITIONS** | Images con prompt de texto, sin fotos de entrada ni reproducción de personas reales; moderación predeterminada `auto`; revisión humana y etiqueta de IA antes de publicar. Texto alternativo, si se evalúa: Responses con `store:false`. Sin opt-in de entrenamiento ni Files/Batch/Assistants. | Clave provisionada y modelo accesible por catálogo. Falta cuota/saldo para generación. Copia firmada del DPA y ZDR son evidencias opcionales adicionales, no prerrequisitos nuevos frente a la incorporación contractual por uso. |

**Ninguna EXCEPTION** que obligue a limitar un tratamiento concreto: en los tres casos el proveedor actúa como
encargado, no entrena con el contenido por contrato y mantiene medidas de seguridad auditadas. Las condiciones
anteriores son requisitos técnicos/operativos, no incompatibilidades contractuales. Dos puntos quedan **abiertos
hasta que el propietario los confirme** y, mientras tanto, se tratan como condiciones, no como bloqueo:

1. TypeSafe: instrumento contractual exacto de la cuenta y estado ZDR (retención sin plazo publicado).
2. Base legal mexicana para la remisión a encargados en EE. UU. y texto del aviso de privacidad de los negocios
   [INFERENCE: en la LFPDPPP las remisiones a encargados no requieren consentimiento adicional, pero el aviso debe
   contemplarlas; corresponde al asesor legal].

Aplicación de ingeniería: estas comprobaciones no certifican un contrato privado ni una conclusión jurídica
en México. No se encontró en las fuentes públicas una incompatibilidad concreta con la clasificación y
generación aprobadas; por DEC-0067/0071 no se introduce una aprobación humana repetitiva. El texto libre puede
contener datos personales no detectados por reglas; la minimización por patrones no garantiza anonimato.
Las políticas con fecha futura se distinguen de los términos actuales; las protecciones preventivas no
amplían el alcance del producto ni acreditan cumplimiento legal completo.

## 5. Comparativa rápida

| Punto | TypeSafe | Anthropic | OpenAI |
|---|---|---|---|
| DPA | Incorporado por referencia (MCA §4.4), sin firma | Incorporado (§C), SCC «deemed executed» | Incorporado (§5.3) + ejecución opcional en Ironclad |
| Rol | Processor | Processor | Processor |
| Entrenamiento | No (MCA §4.1, Privacy Policy) | No (§B); opt-in solo Development Partner / feedback | No (§4.2); opt-in explícito |
| Retención por defecto | «as long as necessary»; sin plazo | 30 días; marcado hasta 2 años | 30 días (logs de abuso); imágenes sin estado |
| ZDR | «enterprise customers», formulario de soporte | Por organización, aprobación de ventas | Aprobación de ventas; `gpt-image-2` elegible |
| Aviso de brecha | 72 h | 48 h | «without undue delay» |
| Objeción a subencargados | 15 días | 15 días | 30 días |
| Certificación | SOC 2 Type II (2026) | Auditoría anual, SOC 2 (trust center) | SOC 2 Type II |
| Entidad / ley | TypeSafe AI, Inc. / California | Anthropic, PBC / California | OpenAI OpCo, LLC / California |
| México soportado | No limitado en MCA | Sí (lista) | Sí (lista) |

## 6. Fuentes (acceso 2026-11-03)

TypeSafe: https://docs.typesafe.ai/legal · https://typesafe.ai/legal/mca · https://typesafe.ai/legal/data-processing ·
https://typesafe.ai/legal/privacy-policy · https://typesafe.ai/legal/acceptable-use-policy · https://typesafe.ai/legal/terms ·
https://docs.typesafe.ai/models · https://trust.typesafe.ai/ · https://trust.typesafe.ai/subprocessors

Anthropic: https://www.anthropic.com/legal/commercial-terms · https://www.anthropic.com/legal/data-processing-addendum ·
https://www.anthropic.com/legal/service-specific-terms · https://www.anthropic.com/legal/aup ·
https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data ·
https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training ·
https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to ·
https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models ·
https://platform.claude.com/docs/en/manage-claude/api-and-data-retention · https://trust.anthropic.com/subprocessors ·
https://www.anthropic.com/supported-countries

OpenAI: https://openai.com/policies/services-agreement/ · https://openai.com/policies/data-processing-addendum/ ·
https://openai.com/policies/service-terms/ · https://openai.com/policies/usage-policies/ ·
https://openai.com/policies/sharing-publication-policy/ · https://openai.com/policies/sub-processor-list/ ·
https://platform.openai.com/docs/guides/your-data · https://openai.com/enterprise-privacy/ ·
https://developers.openai.com/api/docs/models/gpt-image-2 · https://developers.openai.com/api/docs/guides/image-generation ·
https://cdn.openai.com/osa/security-measures.pdf · https://openai.com/index/response-to-nyt-data-demands/ ·
https://developers.openai.com/api/docs/supported-countries

Repositorio: README §5.1, `docs/COGNITIVE-JEV.md`, `docs/architecture/ai-core.md`, `src/ai/catalog.ts`,
`.canonflow/decision-records/DEC-0019.json`, `DEC-0067.json`, `DEC-0069.json`, `DEC-0071.json`, `DEC-0072.md`.
