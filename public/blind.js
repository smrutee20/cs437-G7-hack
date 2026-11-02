// RSA blind signatures (Chaum), with a full-domain hash. This one file runs in both the
// browser and the server, so both sides do the same maths.
//
//   Browser: picks a random token, hashes it to m, sends b = m * r^e mod n.
//   Server:  checks the invite, returns b^d mod n. It never sees the token.
//   Browser: divides out r to get s = m^d mod n, a valid signature the server has never seen.
//
// All numbers cross the network as lowercase hex strings.

const DOMAIN = 'anything-ballot-v1';
const utf8 = (s) => new TextEncoder().encode(s);
const big = (hex) => BigInt(`0x${hex}`);
const hex = (n) => n.toString(16);
const bytesToBig = (bytes) => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

const sha256 = async (bytes) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const byteLength = (n) => Math.ceil(n.toString(2).length / 8);

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function gcd(a, b) {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x;
}

function modInverse(a, modulus) {
  let [oldR, r] = [a % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % modulus) + modulus) % modulus;
}

// Hash the form id and token to a number below n. The form id in the hash stops a ballot from
// one form being replayed on another, even if a key were ever reused.
async function fullDomainHash(key, formId, token) {
  const n = big(key.n);
  const seed = utf8(`${DOMAIN}|${formId}|${token}`);
  const need = byteLength(n) + 32;
  const out = new Uint8Array(need + 32);
  let filled = 0;
  for (let counter = 0; filled < need; counter += 1) {
    const block = new Uint8Array(seed.length + 4);
    block.set(seed);
    new DataView(block.buffer).setUint32(seed.length, counter);
    out.set(await sha256(block), filled);
    filled += 32;
  }
  return bytesToBig(out.subarray(0, need)) % n;
}

export const tokenToNumberHex = async (key, formId, token) => hex(await fullDomainHash(key, formId, token));

export const newToken = () => [...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function blindToken(key, formId, token) {
  const n = big(key.n);
  const e = big(key.e);
  const m = await fullDomainHash(key, formId, token);
  let r;
  do {
    r = bytesToBig(randomBytes(byteLength(n) + 32)) % n;
  } while (r < 2n || gcd(r, n) !== 1n);
  return { blinded: hex((m * modPow(r, e, n)) % n), r: hex(r) };
}

export function unblind(key, blindSignature, r) {
  const n = big(key.n);
  return hex((big(blindSignature) * modInverse(big(r), n)) % n);
}

export async function verify(key, formId, token, signature) {
  const n = big(key.n);
  const s = big(signature);
  if (s <= 0n || s >= n) return false;
  return modPow(s, big(key.e), n) === (await fullDomainHash(key, formId, token));
}

// A short code for the form's public key. If a server gave one person a special key to track
// them, that person would see a different code from everybody else.
export async function fingerprint(key) {
  const digest = await sha256(utf8(`${key.n}:${key.e}`));
  const text = [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return text.match(/.{4}/g).join(' ');
}

// Re-check every spent ballot. The organiser's own browser does this, not the server.
export async function checkAudit(audit, formId) {
  let valid = 0;
  for (const ballot of audit.ballots) {
    let good = false;
    try { good = await verify(audit.key, formId, ballot.token, ballot.signature); } catch { good = false; }
    if (good) valid += 1;
  }
  const ballots = audit.ballots.length;
  const invalid = ballots - valid;
  const unbacked = Math.max(0, audit.responses - ballots);
  return { responses: audit.responses, ballots, valid, invalid, unbacked, ok: invalid === 0 && unbacked === 0 };
}
