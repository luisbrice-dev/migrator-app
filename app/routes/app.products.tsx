import { useState, useMemo, useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

interface BigCommerceImage {
  url_standard?: string;
  url_zoom?: string;
}

interface BigCommerceCustomUrl {
  url?: string;
}

interface BigCommerceProduct {
  id?: number;
  name?: string;
  description?: string;
  sku?: string;
  price?: number;
  inventory_level?: number;
  custom_url?: BigCommerceCustomUrl;
  images?: BigCommerceImage[];
}

interface FetchProductsResult {
  intent: "fetch-products";
  success: boolean;
  count: number;
  products: BigCommerceProduct[];
  error?: string;
}

interface ExportProductsResult {
  intent: "export-products-csv";
  csv: string;
  filename: string;
  error?: string;
}

interface BigCommerceProductsResponse {
  data?: BigCommerceProduct[];
  meta?: {
    pagination?: {
      current_page?: number;
      total_pages?: number;
      total?: number;
    };
  };
}

function escapeCSV(value: unknown): string {
  if (value == null) return "";
  const str = String(value);
  if (
    str.includes('"') ||
    str.includes(",") ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildHandle(product: BigCommerceProduct): string {
  if (product.custom_url?.url) {
    return product.custom_url.url.replace(/^\/|\/$/g, "").split("/").pop() || "";
  }

  const source = product.name || "";
  return source
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function firstImageUrl(product: BigCommerceProduct): string {
  const image = product.images?.[0];
  return image?.url_standard || image?.url_zoom || "";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "fetch-products") {
    const storeHash = formData.get("storeHash") as string;
    const accessToken = formData.get("accessToken") as string;

    if (!storeHash || !accessToken) {
      return {
        intent: "fetch-products",
        success: false,
        count: 0,
        products: [],
        error: "Store Hash and Access Token are required.",
      } satisfies FetchProductsResult;
    }

    try {
      const allProducts: BigCommerceProduct[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const query = new URLSearchParams({
          limit: "250",
          page: String(page),
          include: "images",
        });

        const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${query.toString()}`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "X-Auth-Token": accessToken,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorMsg = `BigCommerce API error (${response.status})`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.title || errorJson.message || errorMsg;
          } catch {
            if (errorText) errorMsg += `: ${errorText.substring(0, 200)}`;
          }

          return {
            intent: "fetch-products",
            success: false,
            count: 0,
            products: [],
            error: errorMsg,
          } satisfies FetchProductsResult;
        }

        const payload: BigCommerceProductsResponse = await response.json();
        const products = Array.isArray(payload.data) ? payload.data : [];
        allProducts.push(...products);

        const pagination = payload.meta?.pagination;
        const totalPages = pagination?.total_pages ?? 1;
        const currentPage = pagination?.current_page ?? page;

        if (products.length === 0 || currentPage >= totalPages) {
          hasMore = false;
        } else {
          page += 1;
        }
      }

      return {
        intent: "fetch-products",
        success: true,
        count: allProducts.length,
        products: allProducts,
      } satisfies FetchProductsResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        intent: "fetch-products",
        success: false,
        count: 0,
        products: [],
        error: `Connection error: ${message}`,
      } satisfies FetchProductsResult;
    }
  }

  if (intent === "export-products-csv") {
    const productsJson = formData.get("products") as string;
    const defaultVendor = (formData.get("defaultVendor") as string) || "";
    const defaultType = (formData.get("defaultType") as string) || "";
    const defaultTags = (formData.get("defaultTags") as string) || "";

    let products: BigCommerceProduct[];
    try {
      products = JSON.parse(productsJson);
    } catch {
      return {
        intent: "export-products-csv",
        csv: "",
        filename: "",
        error: "Invalid JSON.",
      } satisfies ExportProductsResult;
    }

    if (!Array.isArray(products) || products.length === 0) {
      return {
        intent: "export-products-csv",
        csv: "",
        filename: "",
        error: "No products to export.",
      } satisfies ExportProductsResult;
    }

    // Basic Shopify product import shape.
    const headers = [
      "Handle",
      "Title",
      "Body (HTML)",
      "Vendor",
      "Type",
      "Tags",
      "Published",
      "Variant SKU",
      "Variant Price",
      "Image Src",
    ];

    const rows = [headers.map(escapeCSV).join(",")];

    for (const product of products) {
      const row = [
        escapeCSV(buildHandle(product)),
        escapeCSV(product.name || ""),
        escapeCSV(product.description || ""),
        escapeCSV(defaultVendor),
        escapeCSV(defaultType),
        escapeCSV(defaultTags),
        escapeCSV("TRUE"),
        escapeCSV(product.sku || ""),
        escapeCSV(product.price != null ? String(product.price) : ""),
        escapeCSV(firstImageUrl(product)),
      ];

      rows.push(row.join(","));
    }

    const csvContent = "\uFEFF" + rows.join("\n");
    const base64 = Buffer.from(csvContent, "utf-8").toString("base64");

    return {
      intent: "export-products-csv",
      csv: base64,
      filename: "products_shopify.csv",
    } satisfies ExportProductsResult;
  }

  return null;
};

export default function ProductMigrator() {
  const fetchProductsFetcher = useFetcher<FetchProductsResult>();
  const exportProductsFetcher = useFetcher<ExportProductsResult>();

  const [products, setProducts] = useState<BigCommerceProduct[]>([]);
  const [defaultVendor, setDefaultVendor] = useState("Imported from BigCommerce");
  const [defaultType, setDefaultType] = useState("General");
  const [defaultTags, setDefaultTags] = useState("imported,bigcommerce");
  const lastDownloadedCsvRef = useRef<string | null>(null);

  const isFetchingProducts =
    fetchProductsFetcher.state !== "idle" &&
    fetchProductsFetcher.formData?.get("_action") === "fetch-products";

  const isExportingProducts =
    exportProductsFetcher.state !== "idle" &&
    exportProductsFetcher.formData?.get("_action") === "export-products-csv";

  useEffect(() => {
    if (
      fetchProductsFetcher.data?.intent === "fetch-products" &&
      fetchProductsFetcher.data.success
    ) {
      setProducts(fetchProductsFetcher.data.products);
    }
  }, [fetchProductsFetcher.data]);

  useEffect(() => {
    if (
      exportProductsFetcher.data?.intent !== "export-products-csv" ||
      !exportProductsFetcher.data.csv ||
      exportProductsFetcher.data.csv === lastDownloadedCsvRef.current
    ) {
      return;
    }

    const base64 = exportProductsFetcher.data.csv;
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportProductsFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    lastDownloadedCsvRef.current = exportProductsFetcher.data.csv;
  }, [exportProductsFetcher.data]);

  const displayProducts = useMemo(() => {
    if (
      fetchProductsFetcher.data?.intent === "fetch-products" &&
      fetchProductsFetcher.data.success &&
      fetchProductsFetcher.data.products.length > 0
    ) {
      return fetchProductsFetcher.data.products;
    }

    return products;
  }, [fetchProductsFetcher.data, products]);

  const stats = useMemo(() => {
    const withImage = displayProducts.filter((p) => !!firstImageUrl(p)).length;
    const withSku = displayProducts.filter((p) => !!p.sku).length;

    return {
      total: displayProducts.length,
      withImage,
      withSku,
    };
  }, [displayProducts]);

  const fetchError =
    fetchProductsFetcher.data?.intent === "fetch-products" &&
    fetchProductsFetcher.data.error
      ? fetchProductsFetcher.data.error
      : null;

  const exportError =
    exportProductsFetcher.data?.intent === "export-products-csv" &&
    exportProductsFetcher.data.error
      ? exportProductsFetcher.data.error
      : null;

  return (
    <s-page heading="BigCommerce -> Shopify Product Migrator">
      <s-section heading="BigCommerce Credentials - Step 1">
        <fetchProductsFetcher.Form method="POST">
          <input type="hidden" name="_action" value="fetch-products" />
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Store Hash"
                name="storeHash"
                placeholder="for example: abc123xyz"
                details="Panel -> Advanced Settings -> API Accounts"
                required
              />
              <s-password-field
                label="Access Token"
                name="accessToken"
                placeholder="Your API access token"
                details="Requires Products -> Read-only permission"
                required
              />
            </s-stack>

            {fetchError && (
              <s-banner tone="critical" dismissible>
                {fetchError}
              </s-banner>
            )}

            {fetchProductsFetcher.data?.intent === "fetch-products" &&
              fetchProductsFetcher.data.success && (
                <s-banner tone="success" dismissible>
                  {fetchProductsFetcher.data.count} products found. Ready to
                  export!
                </s-banner>
              )}

            <s-button
              variant="primary"
              type="submit"
              {...(isFetchingProducts ? { loading: true } : {})}
            >
              Fetch Products
            </s-button>
          </s-stack>
        </fetchProductsFetcher.Form>
      </s-section>

      {displayProducts.length > 0 && (
        <s-section heading="Products Preview - Step 2">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="140px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.total}</strong>
                  <s-paragraph color="subdued">Products found</s-paragraph>
                </s-stack>
              </s-box>

              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="140px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.withImage}</strong>
                  <s-paragraph color="subdued">With image</s-paragraph>
                </s-stack>
              </s-box>

              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="140px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.withSku}</strong>
                  <s-paragraph color="subdued">With SKU</s-paragraph>
                </s-stack>
              </s-box>
            </s-stack>

            <s-box borderWidth="base" borderRadius="base" overflow="hidden">
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header format="numeric">#</s-table-header>
                  <s-table-header>Title</s-table-header>
                  <s-table-header>SKU</s-table-header>
                  <s-table-header format="currency">Price</s-table-header>
                  <s-table-header format="numeric">Inventory</s-table-header>
                  <s-table-header>Image</s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {displayProducts.slice(0, 50).map((product, index) => {
                    const imageUrl = firstImageUrl(product);

                    return (
                      <s-table-row key={product.id || index}>
                        <s-table-cell>{index + 1}</s-table-cell>
                        <s-table-cell>{product.name || "(Untitled)"}</s-table-cell>
                        <s-table-cell>{product.sku || "-"}</s-table-cell>
                        <s-table-cell>
                          {product.price != null ? `$${product.price}` : "-"}
                        </s-table-cell>
                        <s-table-cell>
                          {product.inventory_level != null
                            ? String(product.inventory_level)
                            : "-"}
                        </s-table-cell>
                        <s-table-cell>{imageUrl ? "Yes" : "-"}</s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            </s-box>

            {displayProducts.length > 50 && (
              <s-paragraph color="subdued">
                Showing 50 of {displayProducts.length} products in preview. All
                products will be included in the CSV.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

      {displayProducts.length > 0 && (
        <s-section heading="Export CSV for Shopify - Step 3">
          <exportProductsFetcher.Form method="POST">
            <input type="hidden" name="_action" value="export-products-csv" />
            <input
              type="hidden"
              name="products"
              value={JSON.stringify(displayProducts)}
            />

            <s-stack direction="block" gap="base">
              <s-text-field
                label="Default vendor"
                name="defaultVendor"
                value={defaultVendor}
                placeholder="for example: Imported from BigCommerce"
                onChange={(e) => setDefaultVendor(e.currentTarget.value)}
              />

              <s-text-field
                label="Default product type"
                name="defaultType"
                value={defaultType}
                placeholder="for example: General"
                onChange={(e) => setDefaultType(e.currentTarget.value)}
              />

              <s-text-field
                label="Default tags"
                name="defaultTags"
                value={defaultTags}
                placeholder="for example: imported,bigcommerce"
                onChange={(e) => setDefaultTags(e.currentTarget.value)}
              />

              {exportError && (
                <s-banner tone="critical" dismissible>
                  {exportError}
                </s-banner>
              )}

              <s-button
                variant="primary"
                type="submit"
                {...(isExportingProducts ? { loading: true } : {})}
              >
                Download CSV ({displayProducts.length} products)
              </s-button>
            </s-stack>
          </exportProductsFetcher.Form>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
