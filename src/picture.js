// -----------------------------------------------------------------------------
// Download of the car picture the user configured (`vehicle_image_url`).
//
// Volkswagen serves no picture to third parties any more (the app's media
// service sits behind the retired app API, the EU Data Act portal has none),
// so the user may point the picture widget at any image they host. It is a
// public https address: no Volkswagen cookie or token is ever sent to it.
// -----------------------------------------------------------------------------

import { httpsFetch } from './vw/transport.js';

const MAX_REDIRECTS = 5;

/** The bytes of the image at `url` (https only, redirects followed). */
export async function downloadPublicImage(url, { fetch: fetchImpl = httpsFetch } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') {
      throw new Error('the picture address must start with https://');
    }
    const response = await fetchImpl(current.toString(), {
      method: 'GET',
      headers: { accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`the picture address answered HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('too many redirects at the picture address');
}
