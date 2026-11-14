const FICTIONAL_DEVEUI_PREFIX = '02F1';
const MAX_GENERATION_ATTEMPTS = 8;
const reservedDeviceEuis = new Set<string>();

export function isPublicSimulatorBuild(): boolean {
  return import.meta.env.VITE_PUBLIC_SIMULATOR === 'true';
}

/** Create a locally assigned fictional identity for a public simulator device. */
export function createPublicSimulatorDevEui(): string {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const randomBytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(randomBytes);
    const suffix = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    const deveui = `${FICTIONAL_DEVEUI_PREFIX}${suffix}`;

    if (!reservedDeviceEuis.has(deveui)) {
      reservedDeviceEuis.add(deveui);
      return deveui;
    }
  }

  throw new Error('Could not generate a unique public simulator DevEUI');
}
