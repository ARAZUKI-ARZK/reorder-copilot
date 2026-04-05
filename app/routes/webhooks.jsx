import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
      case "CUSTOMERS_REDACT":
      case "SHOP_REDACT":
        break;
      default:
        throw new Response("Unhandled webhook topic", { status: 404 });
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof Response) throw error;
    return new Response("Unauthorized", { status: 401 });
  }
};
