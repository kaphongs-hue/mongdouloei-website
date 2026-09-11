// Resolve local photos without routing through the old GitHub Pages domain.
export function resolveImageUrl(value, base = document.baseURI) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw || raw === 'null' || raw === 'undefined') return '';
  try {
    const url = new URL(raw, base);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.hostname === 'kaphongs-hue.github.io' && url.pathname.startsWith('/mongdouloei-website/images/')) {
      return new URL(url.pathname.slice('/mongdouloei-website/'.length), base).href;
    }
    return url.href;
  } catch { return ''; }
}

// Clear the error handler before fallback: a missing fallback must not loop.
export function setRoomImage(image, source) {
  image.onerror = () => {
    image.onerror = null;
    image.src = new URL('room-placeholder.svg', document.baseURI).href;
  };
  image.src = resolveImageUrl(source) || new URL('room-placeholder.svg', document.baseURI).href;
}
