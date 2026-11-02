// Server-side key handling. The maths shared with the browser lives in public/blind.js.
import { createHash, generateKeyPair, privateDecrypt, constants } from 'node:crypto';
import { promisify } from 'node:util';

const generate = promisify(generateKeyPair);
const b64ToHex = (value) => Buffer.from(value, 'base64url').toString('hex').replace(/^0+/, '');

export async function newFormKey() {
  const { publicKey, privateKey } = await generate('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    n: b64ToHex(jwk.n),
    e: b64ToHex(jwk.e),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

// Raw RSA private operation on the blinded value: b^d mod n.
export function signBlinded(privatePem, blindedHex, nHex) {
  const size = Math.ceil(nHex.length / 2);
  const input = Buffer.from(blindedHex.padStart(size * 2, '0'), 'hex');
  const output = privateDecrypt({ key: privatePem, padding: constants.RSA_NO_PADDING }, input);
  return output.toString('hex').replace(/^0+/, '');
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
