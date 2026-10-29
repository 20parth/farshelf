export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms: number, now = Date.now()): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return 'just now';
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatEta(remainingBytes: number, rate: number): string {
  if (rate <= 0 || remainingBytes <= 0) return '';
  const s = Math.round(remainingBytes / rate);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${(s / 3600).toFixed(1)} h left`;
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(p: string): string {
  if (p === '/') return '/';
  return p.slice(0, p.lastIndexOf('/')) || '/';
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

const PREVIEWABLE =
  /\.(mp4|m4v|mov|webm|mp3|m4a|wav|flac|ogg|opus|aac|jpe?g|png|gif|webp|svg|pdf|txt|md|json|csv)$/i;
export const isPreviewable = (name: string) => PREVIEWABLE.test(name);

export function fileKind(name: string): 'video' | 'audio' | 'image' | 'document' | 'archive' | 'other' {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (/^(mp4|m4v|mov|mkv|avi|webm|mxf|braw|r3d|mts)$/.test(ext)) return 'video';
  if (/^(mp3|wav|aiff?|flac|m4a|aac|ogg|opus)$/.test(ext)) return 'audio';
  if (/^(jpe?g|png|gif|heic|webp|tiff?|raw|cr[23]|nef|arw|dng|psd|svg)$/.test(ext)) return 'image';
  if (/^(pdf|docx?|xlsx?|pptx?|txt|md|rtf|pages|numbers|key|csv|epub)$/.test(ext)) return 'document';
  if (/^(zip|tar|gz|tgz|7z|rar|dmg|iso|sparsebundle)$/.test(ext)) return 'archive';
  return 'other';
}
