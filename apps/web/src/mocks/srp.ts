/**
 * The server half of Cognito's SRP-6a password check (USER_SRP_AUTH), for the Cognito mock. The
 * client half is Amplify's (`@aws-amplify/auth`, providers/cognito/utils/srp); this mirrors its
 * encoding (the 3072-bit RFC 5054 group, g = 2, Java-style padded hex, HKDF "Caldera Derived Key")
 * so a sign-in only succeeds when Amplify was given the right password, as with real Cognito.
 */

const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

const N = BigInt(`0x${N_HEX}`);
const g = 2n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
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

/** Even-length hex, with "00" in front when the top bit is set (Java's `BigInteger.toByteArray`). */
function padHex(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return /^[89a-f]/i.test(hex) ? `00${hex}` : hex;
}

function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

export function randomHex(byteCount: number): string {
  return hexFromBytes(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export function base64FromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** One PASSWORD_VERIFIER challenge: what the mock sends (salt, B) and keeps (b, the verifier). */
export interface SrpChallenge {
  saltHex: string;
  serverB: bigint;
  serverSecret: bigint;
  verifier: bigint;
}

/** Start a PASSWORD_VERIFIER challenge that only `password` can answer. */
export async function startChallenge(
  poolName: string,
  username: string,
  password: string,
): Promise<SrpChallenge> {
  const saltHex = padHex(BigInt(`0x${randomHex(16)}`));
  const identityHash = await sha256Hex(utf8(`${poolName}${username}:${password}`));
  const x = BigInt(`0x${await sha256Hex(bytesFromHex(saltHex + identityHash))}`);
  const verifier = modPow(g, x, N);
  const k = BigInt(`0x${await sha256Hex(bytesFromHex(padHex(N) + padHex(g)))}`);
  const serverSecret = BigInt(`0x${randomHex(128)}`);
  const serverB = (k * verifier + modPow(g, serverSecret, N)) % N;
  return { saltHex, serverB, serverSecret, verifier };
}

/** Whether the client's PASSWORD_CLAIM_SIGNATURE proves it knew the challenge's password. */
export async function verifyPasswordClaim(
  challenge: SrpChallenge,
  claim: {
    poolName: string;
    userIdForSrp: string;
    clientA: bigint;
    secretBlock: string;
    timestamp: string;
    signature: string;
  },
): Promise<boolean> {
  const { clientA } = claim;
  const u = BigInt(`0x${await sha256Hex(bytesFromHex(padHex(clientA) + padHex(challenge.serverB)))}`);
  const S = modPow(clientA * modPow(challenge.verifier, u, N), challenge.serverSecret, N);
  const prk = await hmac(bytesFromHex(padHex(u)), bytesFromHex(padHex(S)));
  const key = (await hmac(prk, concat(utf8("Caldera Derived Key"), utf8("\u0001")))).slice(0, 16);
  const expected = await hmac(
    key,
    concat(
      utf8(claim.poolName),
      utf8(claim.userIdForSrp),
      bytesFromBase64(claim.secretBlock),
      utf8(claim.timestamp),
    ),
  );
  return base64FromBytes(expected) === claim.signature;
}
