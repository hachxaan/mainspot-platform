/**
 * DEV-E2E-04 §3 — configuración del correo transaccional (recuperación de contraseña).
 *
 * Solo NOMBRES de variables; los valores viven en el entorno (.env fuera de Git o secret store).
 * Sin MAIL_TRANSPORT (o con `disabled`) no se envía ningún correo: la solicitud de recuperación
 * responde igual de neutra, registra `mail.transport_disabled` y la capacidad queda
 * BLOCKED_EXTERNAL. Nunca se simula una entrega.
 *
 *   MAIL_TRANSPORT = disabled | smtp | resend
 *   MAIL_FROM      remitente verificado en el proveedor ("MainSpot <no-responder@dominio>")
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE=implicit|starttls, SMTP_CA_FILE
 *   RESEND_API_KEY, RESEND_BASE_URL (https://api.resend.com)
 */

export const MAIL_TRANSPORTS = ['disabled', 'smtp', 'resend'] as const;
export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

export interface MailConfig {
  transport: MailTransportName;
  /** Remitente verificado en el proveedor (MAIL_FROM). */
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  /** 'implicit' = TLS desde la conexión (465); 'starttls' = STARTTLS obligatorio (587). */
  smtpSecure: 'implicit' | 'starttls';
  /** Ruta a un PEM con CA adicional (relés privados con CA propia); vacío = solo CAs del sistema. */
  smtpCaFile: string;
  resendApiKey: string;
  resendBaseUrl: string;
}

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const transportRaw = (env.MAIL_TRANSPORT ?? '').trim();
  const transport = MAIL_TRANSPORTS.find((t) => t === transportRaw);
  if (transportRaw !== '' && !transport) {
    throw new Error(`Invalid MAIL_TRANSPORT="${transportRaw}". Allowed: ${MAIL_TRANSPORTS.join(', ')}`);
  }
  const port = Number(env.SMTP_PORT ?? 587);
  const secureRaw = (env.SMTP_SECURE ?? '').trim();
  if (secureRaw !== '' && secureRaw !== 'implicit' && secureRaw !== 'starttls') {
    throw new Error('Invalid SMTP_SECURE. Allowed: implicit, starttls');
  }
  return {
    transport: transport ?? 'disabled',
    from: (env.MAIL_FROM ?? '').trim(),
    smtpHost: (env.SMTP_HOST ?? '').trim(),
    smtpPort: port,
    smtpUser: env.SMTP_USER ?? '',
    smtpPass: env.SMTP_PASS ?? '',
    smtpSecure: secureRaw === '' ? (port === 465 ? 'implicit' : 'starttls') : secureRaw,
    smtpCaFile: (env.SMTP_CA_FILE ?? '').trim(),
    resendApiKey: env.RESEND_API_KEY ?? '',
    resendBaseUrl: (env.RESEND_BASE_URL ?? 'https://api.resend.com').replace(/\/$/, ''),
  };
}

/** Prerrequisitos externos que faltan para enviar correo REAL (nombres, nunca valores). */
export function mailBlockedPrerequisites(cfg: MailConfig): string[] {
  if (cfg.transport === 'smtp') {
    const out: string[] = [];
    if (!cfg.smtpHost) out.push('SMTP_HOST');
    if (!cfg.smtpUser) out.push('SMTP_USER');
    if (!cfg.smtpPass) out.push('SMTP_PASS');
    if (!cfg.from) out.push('MAIL_FROM');
    return out;
  }
  if (cfg.transport === 'resend') {
    const out: string[] = [];
    if (!cfg.resendApiKey) out.push('RESEND_API_KEY');
    if (!cfg.from) out.push('MAIL_FROM');
    return out;
  }
  return ['MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST|RESEND_API_KEY'];
}
