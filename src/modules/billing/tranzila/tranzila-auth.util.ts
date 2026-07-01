import { createHmac, randomBytes } from 'node:crypto';

export interface TranzilaAuthHeaders {
  'X-tranzila-api-app-key': string;
  'X-tranzila-api-request-time': string;
  'X-tranzila-api-nonce': string;
  'X-tranzila-api-access-token': string;
}

/** Matches Tranzila developer guide: HMAC_SHA256(message=publicKey, key=privateKey+time+nonce). */
export function buildTranzilaAuthHeaders(
  publicKey: string,
  privateKey: string,
): TranzilaAuthHeaders {
  const requestTime = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(32).toString('hex');
  const signingKey = `${privateKey}${requestTime}${nonce}`;
  const accessToken = createHmac('sha256', signingKey)
    .update(publicKey)
    .digest('hex');

  return {
    'X-tranzila-api-app-key': publicKey,
    'X-tranzila-api-request-time': String(requestTime),
    'X-tranzila-api-nonce': nonce,
    'X-tranzila-api-access-token': accessToken,
  };
}
