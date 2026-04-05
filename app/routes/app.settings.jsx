import { json } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: {
      shopDomain: session.shop,
      defaultLeadTime: 14,
      defaultSafetyStock: 7,
    },
  });

  return json({
    leadTime: shop.defaultLeadTime,
    safetyStock: shop.defaultSafetyStock,
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const leadTime = parseInt(formData.get("leadTime"), 10);
  const safetyStock = parseInt(formData.get("safetyStock"), 10);

  if (isNaN(leadTime) || isNaN(safetyStock) || leadTime < 0 || safetyStock < 0) {
    return json({ error: "Please enter a valid number." }, { status: 400 });
  }

  await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { defaultLeadTime: leadTime, defaultSafetyStock: safetyStock },
    create: {
      shopDomain: session.shop,
      defaultLeadTime: leadTime,
      defaultSafetyStock: safetyStock,
    },
  });

  return json({ success: true });
};

export default function Settings() {
  const { leadTime, safetyStock } = useLoaderData();
  const shopify = useAppBridge();
  const submit = useSubmit();

  const [leadTimeValue, setLeadTimeValue] = useState(String(leadTime));
  const [safetyStockValue, setSafetyStockValue] = useState(String(safetyStock));
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const formData = new FormData();
    formData.append("leadTime", leadTimeValue);
    formData.append("safetyStock", safetyStockValue);

    await submit(formData, { method: "POST" });
    setSaving(false);
    shopify.toast.show("Settings saved");
  }, [leadTimeValue, safetyStockValue, submit, shopify]);

  return (
    <Page
      title="Settings"
      backAction={{ url: "/app" }}
    >
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Reorder Defaults
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              These values apply to all SKU reorder calculations.
            </Text>
            <FormLayout>
              <TextField
                label="Default Lead Time (days)"
                type="number"
                value={leadTimeValue}
                onChange={setLeadTimeValue}
                min={0}
                autoComplete="off"
                helpText="Average number of days to receive products from your supplier"
              />
              <TextField
                label="Safety Stock (days)"
                type="number"
                value={safetyStockValue}
                onChange={setSafetyStockValue}
                min={0}
                autoComplete="off"
                helpText="Extra buffer days to cover unexpected demand spikes"
              />
              <Button variant="primary" onClick={handleSave} loading={saving}>
                Save
              </Button>
            </FormLayout>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
