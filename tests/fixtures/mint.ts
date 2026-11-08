// Test-only credential minting: the browser's prepare/blind/finalize steps from
// the protocol package, with an independent OpenSSL raw private operation as
// the signer. Not production code.
import { createPrivateKey, randomBytes } from "node:crypto";
import { blindMessage, finalizeSignature, importPollPublicKey, prepareMessage } from "../../packages/protocol/src/blind";
import { encodeApplicationMessage } from "../../packages/protocol/src/credential";
import { nodeRawSign } from "./rsa";

export async function mintCredential(signer: { keyId: string; jwk: unknown; der: Uint8Array }, messagePollId: string,
  secret: Uint8Array = randomBytes(32)) {
  const key = await importPollPublicKey(signer.jwk);
  const prepared = prepareMessage(encodeApplicationMessage(messagePollId, secret));
  const { blindedMessage, inverse } = await blindMessage(key, prepared);
  const blindSig = nodeRawSign(createPrivateKey({ key: Buffer.from(signer.der), format: "der", type: "pkcs8" }), blindedMessage);
  const signature = await finalizeSignature(key, prepared, blindSig, inverse);
  return { version: 1, keyId: signer.keyId, keyVersion: 1,
    preparedMessage: Buffer.from(prepared).toString("base64url"), signature: Buffer.from(signature).toString("base64url") };
}
