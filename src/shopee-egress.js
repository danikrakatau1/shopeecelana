const textEncoder = new TextEncoder();

async function signRelayMessage(keyMaterial, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(message)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getRelayConfig(env) {
  const relayUrl = String(env?.SHOPEE_EGRESS_RELAY_URL || '').trim();
  const relayKey = String(env?.SHOPEE_EGRESS_SHARED_SECRET || '').trim();
  if (!relayUrl && !relayKey) return null;
  if (!relayUrl || !relayKey) throw new Error('shopee_egress_relay_misconfigured');

  const parsed = new URL(relayUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/v1/forward') {
    throw new Error('shopee_egress_relay_url_invalid');
  }
  return { relayUrl: parsed.toString(), relayKey };
}

function selectHeaders(headersInit) {
  const headers = new Headers(headersInit || {});
  const selected = {};
  const accept = headers.get('accept');
  const contentType = headers.get('content-type');
  if (accept) selected.accept = accept.slice(0, 512);
  if (contentType) selected['content-type'] = contentType.slice(0, 512);
  return selected;
}

function serializeBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('shopee_egress_body_type_not_supported');
}

export async function shopeeFetch(env, target, init = {}) {
  const relay = getRelayConfig(env);
  if (!relay) return fetch(target, init);

  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error('shopee_egress_method_not_allowed');

  const targetUrl = new URL(String(target));
  if (targetUrl.protocol !== 'https:') throw new Error('shopee_egress_target_invalid');

  const envelope = JSON.stringify({
    url: targetUrl.toString(),
    method,
    headers: selectHeaders(init.headers),
    body: method === 'GET' ? '' : serializeBody(init.body)
  });
  const timestamp = String(Date.now());
  const signature = await signRelayMessage(relay.relayKey, `${timestamp}.${envelope}`);

  return fetch(relay.relayUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-arstore-egress-timestamp': timestamp,
      'x-arstore-egress-signature': signature
    },
    body: envelope,
    redirect: 'manual'
  });
}
