import crypto from "crypto";

export const action = async ({ request }) => {
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  const body = await request.text();

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !hmacHeader) {
    return new Response("Unauthorized", { status: 401 });
  }

  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  if (generatedHash !== hmacHeader) {
    return new Response("Unauthorized", { status: 401 });
  }

  const topic = request.headers.get("X-Shopify-Topic");
  console.log(`Received ${topic} webhook`);

  return new Response(null, { status: 200 });
};
