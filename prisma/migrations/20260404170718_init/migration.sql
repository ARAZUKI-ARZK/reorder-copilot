-- CreateTable
CREATE TABLE "Shop" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopDomain" TEXT NOT NULL,
    "defaultLeadTime" INTEGER NOT NULL DEFAULT 14,
    "defaultSafetyStock" INTEGER NOT NULL DEFAULT 7
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
