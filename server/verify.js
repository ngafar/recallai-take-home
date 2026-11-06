const crypto = require("node:crypto");

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// Recall signs `${id}.${timestamp}.${rawBody}` with the base64 key after "whsec_".
// Async Desktop SDK webhooks use either webhook-* or legacy svix-* headers.
function verifyWebhook(secret, headers, rawBody) {
  const messageId = headers["webhook-id"] || headers["svix-id"];
  const timestamp = headers["webhook-timestamp"] || headers["svix-timestamp"];
  const signatureHeader = headers["webhook-signature"] || headers["svix-signature"];

  if (!secret || !secret.startsWith("whsec_")) {
    throw new Error("RECALL_WEBHOOK_SECRET is missing or does not start with whsec_");
  }
  if (!messageId || !timestamp || !signatureHeader) {
    throw new Error("Webhook is missing id, timestamp, or signature headers");
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp is outside the 5 minute tolerance");
  }

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest();

  const signatures = signatureHeader.split(" ");
  const matches = signatures.some((versioned) => {
    const [version, signature] = versioned.split(",");
    if (version !== "v1" || !signature) {
      return false;
    }
    const received = Buffer.from(signature, "base64");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });

  if (!matches) {
    throw new Error(
      "Webhook signature does not match. Use the workspace verification secret for workspaces created on or after December 15, 2025, or the signing secret shown on the webhook endpoint for older workspaces.",
    );
  }
}

module.exports = { verifyWebhook };
