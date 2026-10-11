export type ObjectUrlPort = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

export function isPresentationActionBlocked(mode: 'presentation' | 'public', action: string | null): boolean {
  return mode === 'presentation' && (action === 'logout' || action === 'osi-server');
}

export function canNavigate(current: URL, target: string, ownedBlobUrls: ReadonlySet<string>, downloadFilename?: string | null): boolean {
  let next: URL;
  try { next = new URL(target, current); }
  catch { return false; }
  if (next.protocol === 'blob:') return Boolean(downloadFilename?.trim()) && ownedBlobUrls.has(next.href);
  return next.origin === current.origin && next.pathname === current.pathname;
}

export function createObjectUrlBoundary(port: ObjectUrlPort) {
  const owned = new Set<string>();
  return {
    create(blob: Blob): string {
      const url = port.createObjectURL(blob);
      owned.add(url);
      return url;
    },
    revoke(url: string): void {
      if (!owned.delete(url)) return;
      port.revokeObjectURL(url);
    },
    owns(url: string): boolean { return owned.has(url); },
    urls(): ReadonlySet<string> { return owned; },
    releaseAll(): void {
      for (const url of owned) port.revokeObjectURL(url);
      owned.clear();
    },
  };
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function localPngFromDataUrl(dataUrl: string): Blob | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(match[1]!);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 57 || signature.some((byte, index) => bytes[index] !== byte)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let sawHeader = false;
    let sawData = false;
    let dataEnded = false;
    let sawEnd = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) return null;
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) return null;
      const typeStart = offset + 4;
      const type = String.fromCharCode(...bytes.slice(typeStart, typeStart + 4));
      const payloadStart = offset + 8;
      const crcOffset = payloadStart + length;
      if (view.getUint32(crcOffset) !== pngCrc32(bytes.subarray(typeStart, crcOffset))) return null;
      if (!sawHeader) {
        if (type !== 'IHDR' || length !== 13 || view.getUint32(payloadStart) === 0 || view.getUint32(payloadStart + 4) === 0) return null;
        sawHeader = true;
      } else if (type === 'IHDR') return null;
      if (type === 'IDAT') {
        if (dataEnded) return null;
        sawData = true;
      } else if (sawData && type !== 'IEND') dataEnded = true;
      offset = crcOffset + 4;
      if (type === 'IEND') {
        if (length !== 0 || !sawData || offset !== bytes.length) return null;
        sawEnd = true;
        break;
      }
    }
    if (!sawHeader || !sawData || !sawEnd) return null;
    return new Blob([bytes], {type: 'image/png'});
  } catch { return null; }
}

export function localPngDownloadFromDataUrl(dataUrl: string, downloadFilename: string | null | undefined): Blob | null {
  if (!downloadFilename?.trim()) return null;
  return localPngFromDataUrl(dataUrl);
}
