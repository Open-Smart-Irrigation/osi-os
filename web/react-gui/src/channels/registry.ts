import manifest from './channels.json';

export interface ChannelManifestEntry {
  key: string;
  unit: string | null;
  label: string;
  cardType: string;
  exportable?: boolean;
  deprecated?: boolean;
  legacyAliases?: string[];
}

interface ChannelRegistry {
  cardChannels(cardType: string): string[];
  cardChannelsForSource(cardType: string, source?: ChannelSourceContext): string[];
  channelLabel(key: string): string;
  channelUnit(key: string): string | null;
  canonicalize(keyOrAlias: string): string;
}

export interface ChannelSourceContext {
  deviceType?: string | null;
  chameleonEnabled?: boolean;
  tempEnabled?: boolean;
}

export function createChannelRegistry(channels: ChannelManifestEntry[]): ChannelRegistry {
  const channelsByKey = new Map(channels.map((channel) => [channel.key, channel]));
  const aliasesByKey = new Map<string, string>();

  for (const channel of channels) {
    for (const alias of channel.legacyAliases ?? []) {
      aliasesByKey.set(alias, channel.key);
    }
  }

  function canonicalizeEntry(keyOrAlias: string): string {
    return aliasesByKey.get(keyOrAlias) ?? keyOrAlias;
  }

  function cardChannelsForCard(cardType: string): string[] {
    return channels
      .filter((channel) => channel.cardType === cardType && channel.exportable !== false && channel.deprecated !== true)
      .map((channel) => channel.key);
  }

  function filterAvailable(cardType: string, defaults: string[]): string[] {
    const allowed = new Set(cardChannelsForCard(cardType));
    return defaults.filter((key) => allowed.has(key));
  }

  return {
    canonicalize: canonicalizeEntry,
    cardChannels: cardChannelsForCard,
    cardChannelsForSource(cardType, source) {
      if (!source) {
        return cardChannelsForCard(cardType);
      }

      if (cardType === 'soil' && source.chameleonEnabled) {
        return filterAvailable(cardType, ['swt_1', 'swt_2', 'swt_3']);
      }

      if (cardType === 'environment') {
        if (source.deviceType === 'DRAGINO_LSN50') {
          return source.tempEnabled ? filterAvailable(cardType, ['ext_temperature_c']) : [];
        }

        if (source.deviceType === 'KIWI_SENSOR') {
          return filterAvailable(cardType, ['ambient_temperature', 'relative_humidity', 'light_lux']);
        }
      }

      return cardChannelsForCard(cardType);
    },
    channelLabel(key) {
      const canonicalKey = canonicalizeEntry(key);
      return channelsByKey.get(canonicalKey)?.label ?? canonicalKey;
    },
    channelUnit(key) {
      return channelsByKey.get(canonicalizeEntry(key))?.unit ?? null;
    },
  };
}

const registry = createChannelRegistry(manifest as ChannelManifestEntry[]);

export function canonicalize(keyOrAlias: string): string {
  return registry.canonicalize(keyOrAlias);
}

export function cardChannels(cardType: string): string[] {
  return registry.cardChannels(cardType);
}

export function cardChannelsForSource(cardType: string, source?: ChannelSourceContext): string[] {
  return registry.cardChannelsForSource(cardType, source);
}

export function channelLabel(key: string): string {
  return registry.channelLabel(key);
}

export function channelUnit(key: string): string | null {
  return registry.channelUnit(key);
}
