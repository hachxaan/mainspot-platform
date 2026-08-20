/**
 * Registry de canales (INC-002, DEC-016/026).
 *
 * CHANNEL_PRIMARY=telegram|simulated. Telegram real solo si existe
 * TELEGRAM_BOT_TOKEN; en ausencia de credenciales cae a SimulatedChannel
 * (modo simulado funcional para E2E y piloto sin credenciales externas).
 */

import type { AppConfig } from '../shared/config.ts';
import { SimulatedChannel } from './simulated.ts';
import { TelegramAdapter } from './telegram.ts';
import type { ChannelAdapter } from './types.ts';

export function createChannelAdapter(config: Pick<AppConfig, 'channelPrimary' | 'telegramBotToken' | 'telegramBaseUrl'>): ChannelAdapter {
  if (config.channelPrimary === 'telegram' && config.telegramBotToken) {
    return new TelegramAdapter(config.telegramBotToken, config.telegramBaseUrl);
  }
  // DEC-026: sin credenciales => canal simulado funcional (E2E/piloto).
  return new SimulatedChannel();
}
