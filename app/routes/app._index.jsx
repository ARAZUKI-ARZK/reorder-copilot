import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Text,
  Card,
  BlockStack,
  InlineGrid,
  Banner,
  Spinner,
  Tabs,
  IndexTable,
  Badge,
  Box,
  InlineStack,
  EmptySearchResult,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { EARLY_ACCESS_MODE, FREE_SKU_LIMIT } from "../config";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Read shop settings from DB (create with defaults if not found)
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: {
      shopDomain: session.shop,
      defaultLeadTime: 14,
      defaultSafetyStock: 7,
    },
  });

  const LEAD_TIME_DAYS = shop.defaultLeadTime;
  const SAFETY_STOCK_DAYS = shop.defaultSafetyStock;

  // 1) Fetch all product variants (paginated)
  let variants = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query getProducts($cursor: String) {
          products(first: 50, after: $cursor) {
            edges {
              node {
                title
                variants(first: 100) {
                  edges {
                    node {
                      id
                      title
                      sku
                      inventoryQuantity
                    }
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }`,
      { variables: { cursor } },
    );

    const data = await response.json();
    const products = data.data.products;

    for (const edge of products.edges) {
      const productTitle = edge.node.title;
      for (const variantEdge of edge.node.variants.edges) {
        const v = variantEdge.node;
        variants.push({
          id: v.id,
          productTitle,
          variantTitle: v.title,
          sku: v.sku || "(No SKU)",
          inventoryQuantity: v.inventoryQuantity ?? 0,
        });
      }
      cursor = edge.cursor;
    }

    hasNextPage = products.pageInfo.hasNextPage;
  }

  // 2) Calculate sales per variant from last 30 days of orders
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceDate = thirtyDaysAgo.toISOString();

  const salesMap = {}; // variantId -> totalQuantity

  let hasNextOrderPage = true;
  let orderCursor = null;

  while (hasNextOrderPage) {
    const orderResponse = await admin.graphql(
      `#graphql
        query getOrders($cursor: String, $query: String) {
          orders(first: 50, after: $cursor, query: $query) {
            edges {
              node {
                lineItems(first: 100) {
                  edges {
                    node {
                      quantity
                      variant {
                        id
                      }
                    }
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }`,
      {
        variables: {
          cursor: orderCursor,
          query: `created_at:>='${sinceDate}'`,
        },
      },
    );

    const orderData = await orderResponse.json();
    const orders = orderData.data.orders;

    for (const orderEdge of orders.edges) {
      for (const lineEdge of orderEdge.node.lineItems.edges) {
        const variantId = lineEdge.node.variant?.id;
        if (variantId) {
          salesMap[variantId] =
            (salesMap[variantId] || 0) + lineEdge.node.quantity;
        }
      }
      orderCursor = orderEdge.cursor;
    }

    hasNextOrderPage = orders.pageInfo.hasNextPage;
  }

  // 3) Compute reorder metrics per SKU
  const skuData = variants.map((v) => {
    const sold30d = salesMap[v.id] || 0;
    const dailyAvg = sold30d / 30;
    const coverageDays =
      dailyAvg > 0 ? v.inventoryQuantity / dailyAvg : Infinity;

    const threshold = LEAD_TIME_DAYS + SAFETY_STOCK_DAYS;
    let signal;
    if (coverageDays < threshold) {
      signal = "red";
    } else if (coverageDays < threshold * 2) {
      signal = "yellow";
    } else {
      signal = "green";
    }

    const recommendedQty = Math.max(
      Math.ceil(threshold * dailyAvg - v.inventoryQuantity),
      0,
    );

    return {
      ...v,
      sold30d,
      dailyAvg: Math.round(dailyAvg * 100) / 100,
      coverageDays:
        coverageDays === Infinity
          ? null
          : Math.round(coverageDays * 10) / 10,
      signal,
      recommendedQty,
    };
  });

  // 4) Sort: highest urgency first, no-sales SKUs last
  const signalOrder = { red: 0, yellow: 1, green: 2 };
  skuData.sort((a, b) => {
    const aNoSales = a.dailyAvg === 0;
    const bNoSales = b.dailyAvg === 0;
    if (aNoSales !== bNoSales) return aNoSales ? 1 : -1;
    if (signalOrder[a.signal] !== signalOrder[b.signal]) {
      return signalOrder[a.signal] - signalOrder[b.signal];
    }
    const aCov = a.coverageDays ?? Infinity;
    const bCov = b.coverageDays ?? Infinity;
    return aCov - bCov;
  });

  // 5) Summary counts
  const summary = {
    red: skuData.filter((s) => s.signal === "red").length,
    yellow: skuData.filter((s) => s.signal === "yellow").length,
    green: skuData.filter((s) => s.signal === "green").length,
  };

  return json({
    summary,
    skuData,
    leadTime: LEAD_TIME_DAYS,
    safetyStock: SAFETY_STOCK_DAYS,
    earlyAccess: EARLY_ACCESS_MODE,
    totalSkuCount: skuData.length,
  });
};

const SIGNAL_CONFIG = {
  red: { emoji: "\uD83D\uDD34", label: "Order Now", tone: "critical" },
  yellow: { emoji: "\uD83D\uDFE1", label: "Order Soon", tone: "warning" },
  green: { emoji: "\uD83D\uDFE2", label: "In Stock", tone: "success" },
};

function SignalBadge({ signal }) {
  const config = SIGNAL_CONFIG[signal];
  return (
    <Badge tone={config.tone}>
      {config.emoji} {config.label}
    </Badge>
  );
}

function ExpandedRow({ sku, leadTime, safetyStock }) {
  return (
    <Box padding="400" background="bg-surface-secondary">
      <InlineStack gap="400" wrap>
        <Text as="span" variant="bodyMd">Stock: {sku.inventoryQuantity}</Text>
        <Text as="span" variant="bodyMd">30d Sales: {sku.sold30d}</Text>
        <Text as="span" variant="bodyMd">
          Cover: {sku.coverageDays !== null ? `${sku.coverageDays} days` : "—"}
        </Text>
        <Text as="span" variant="bodyMd" fontWeight="bold">
          → Order: {sku.recommendedQty}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          (Lead Time: {leadTime} days + Safety Stock: {safetyStock} days)
        </Text>
      </InlineStack>
    </Box>
  );
}

export default function Index() {
  const data = useLoaderData();
  const [selectedTab, setSelectedTab] = useState(1);
  const [expandedRows, setExpandedRows] = useState({});

  const handleTabChange = useCallback((index) => setSelectedTab(index), []);

  const toggleRow = useCallback((id) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  if (!data) {
    return (
      <Page>
        <TitleBar title="ARAZUKI Reorder Copilot" />
        <BlockStack gap="500" align="center">
          <Spinner size="large" />
          <Text as="p" variant="bodyMd" alignment="center">
            Loading data...
          </Text>
        </BlockStack>
      </Page>
    );
  }

  const { summary, skuData, leadTime, safetyStock, earlyAccess, totalSkuCount } = data;

  const tabs = [
    { id: "all", content: `All (${skuData.length})` },
    { id: "red", content: `\uD83D\uDD34 Order Now (${summary.red})` },
    { id: "yellow", content: `\uD83D\uDFE1 Order Soon (${summary.yellow})` },
    { id: "green", content: `\uD83D\uDFE2 In Stock (${summary.green})` },
  ];

  const filterMap = ["all", "red", "yellow", "green"];
  const activeFilter = filterMap[selectedTab];
  const filteredData =
    activeFilter === "all"
      ? skuData
      : skuData.filter((s) => s.signal === activeFilter);

  const resourceName = { singular: "SKU", plural: "SKUs" };

  // Build rows with expandable detail
  const rowsWithExpansion = filteredData.flatMap((sku, index) => {
    const displayName =
      sku.variantTitle && sku.variantTitle !== "Default Title"
        ? `${sku.productTitle} - ${sku.variantTitle}`
        : sku.productTitle;

    const rows = [
      <IndexTable.Row
        id={sku.id}
        key={sku.id}
        position={index}
        onClick={() => toggleRow(sku.id)}
      >
        <IndexTable.Cell>
          <BlockStack gap="100">
            <Text variant="bodyMd" fontWeight="semibold" as="span">
              {displayName}
            </Text>
            <Text variant="bodySm" as="span" tone="subdued">
              {sku.sku}
            </Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <SignalBadge signal={sku.signal} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">
            {sku.coverageDays !== null ? `${sku.coverageDays} days` : "No sales"}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {sku.recommendedQty}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">
            {leadTime} days
          </Text>
        </IndexTable.Cell>
      </IndexTable.Row>,
    ];

    if (expandedRows[sku.id]) {
      rows.push(
        <IndexTable.Row key={`${sku.id}-detail`} id={`${sku.id}-detail`} position={index}>
          <IndexTable.Cell colSpan={5}>
            <ExpandedRow sku={sku} leadTime={leadTime} safetyStock={safetyStock} />
          </IndexTable.Cell>
        </IndexTable.Row>,
      );
    }

    return rows;
  });

  return (
    <Page>
      <TitleBar title="ARAZUKI Reorder Copilot" />
      <BlockStack gap="500">
        <BlockStack gap="200">
          <Text as="h1" variant="headingXl">
            ARAZUKI Reorder Copilot
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            See which SKUs to reorder and how much — in about 5 minutes
          </Text>
        </BlockStack>

        {earlyAccess && (
          <Banner tone="success">
            <Text as="p" variant="bodyMd">
              All features are currently free
            </Text>
          </Banner>
        )}

        <Banner tone="info">
          <InlineStack gap="200" align="start" blockAlign="center">
            <Text as="p" variant="bodyMd">
              Default Lead Time: {leadTime} days | Safety Stock: {safetyStock} days
            </Text>
            <Link to="/app/settings">Change Settings</Link>
          </InlineStack>
        </Banner>

        <InlineGrid columns={3} gap="400">
          <div
            onClick={() => setSelectedTab(1)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedTab(1); }}
          >
            <Card>
              <BlockStack gap="200" align="center">
                <Text as="p" variant="headingLg" alignment="center">
                  {"\uD83D\uDD34"} Order Now
                </Text>
                <Text as="p" variant="heading2xl" alignment="center" fontWeight="bold">
                  {summary.red}
                </Text>
              </BlockStack>
            </Card>
          </div>
          <div
            onClick={() => setSelectedTab(2)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedTab(2); }}
          >
            <Card>
              <BlockStack gap="200" align="center">
                <Text as="p" variant="headingLg" alignment="center">
                  {"\uD83D\uDFE1"} Order Within 7 Days
                </Text>
                <Text as="p" variant="heading2xl" alignment="center" fontWeight="bold">
                  {summary.yellow}
                </Text>
              </BlockStack>
            </Card>
          </div>
          <div
            onClick={() => setSelectedTab(3)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedTab(3); }}
          >
            <Card>
              <BlockStack gap="200" align="center">
                <Text as="p" variant="headingLg" alignment="center">
                  {"\uD83D\uDFE2"} In Stock
                </Text>
                <Text as="p" variant="heading2xl" alignment="center" fontWeight="bold">
                  {summary.green}
                </Text>
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>

        <Text as="p" variant="bodyMd" tone="subdued">
          Total SKUs: {totalSkuCount}
        </Text>

        <Card padding="0">
          <BlockStack>
            <Box padding="400" paddingBlockEnd="0">
              <Text as="h2" variant="headingLg">
                Reorder Priorities
              </Text>
            </Box>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange}>
              {filteredData.length === 0 ? (
                <Box padding="600">
                  <EmptySearchResult
                    title="No SKUs need immediate reordering"
                    description="Check the Order Soon tab or view all SKUs"
                    withIllustration
                  />
                </Box>
              ) : (
                <IndexTable
                  resourceName={resourceName}
                  itemCount={filteredData.length}
                  headings={[
                    { title: "Product / SKU" },
                    { title: "Reorder Signal" },
                    { title: "Stock Cover Days" },
                    { title: "Recommended Order Qty" },
                    { title: "Lead Time" },
                  ]}
                  selectable={false}
                >
                  {rowsWithExpansion}
                </IndexTable>
              )}
            </Tabs>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
