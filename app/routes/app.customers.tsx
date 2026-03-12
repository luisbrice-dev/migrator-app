import { useState, useMemo, useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

interface BigCommerceCustomer {
  id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
  date_created?: string;
}

interface FetchCustomersResult {
  intent: "fetch-customers";
  success: boolean;
  count: number;
  customers: BigCommerceCustomer[];
  error?: string;
}

interface ExportCustomersResult {
  intent: "export-customers-csv";
  csv: string;
  filename: string;
  error?: string;
}

interface BigCommerceCustomersResponse {
  data?: BigCommerceCustomer[];
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

function toBoolString(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "fetch-customers") {
    const storeHash = formData.get("storeHash") as string;
    const accessToken = formData.get("accessToken") as string;

    if (!storeHash || !accessToken) {
      return {
        intent: "fetch-customers",
        success: false,
        count: 0,
        customers: [],
        error: "Store Hash and Access Token are required.",
      } satisfies FetchCustomersResult;
    }

    try {
      const allCustomers: BigCommerceCustomer[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/customers?limit=250&page=${page}`;
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
            intent: "fetch-customers",
            success: false,
            count: 0,
            customers: [],
            error: errorMsg,
          } satisfies FetchCustomersResult;
        }

        const payload: BigCommerceCustomersResponse = await response.json();
        const customers = Array.isArray(payload.data) ? payload.data : [];

        allCustomers.push(...customers);

        const pagination = payload.meta?.pagination;
        const totalPages = pagination?.total_pages ?? 1;
        const currentPage = pagination?.current_page ?? page;

        if (customers.length === 0 || currentPage >= totalPages) {
          hasMore = false;
        } else {
          page += 1;
        }
      }

      return {
        intent: "fetch-customers",
        success: true,
        count: allCustomers.length,
        customers: allCustomers,
      } satisfies FetchCustomersResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        intent: "fetch-customers",
        success: false,
        count: 0,
        customers: [],
        error: `Connection error: ${message}`,
      } satisfies FetchCustomersResult;
    }
  }

  if (intent === "export-customers-csv") {
    const customersJson = formData.get("customers") as string;
    const defaultTag = (formData.get("defaultTag") as string) || "";
    const acceptsMarketing = formData.get("acceptsMarketing") === "on";

    let customers: BigCommerceCustomer[];
    try {
      customers = JSON.parse(customersJson);
    } catch {
      return {
        intent: "export-customers-csv",
        csv: "",
        filename: "",
        error: "Invalid JSON.",
      } satisfies ExportCustomersResult;
    }

    if (!Array.isArray(customers) || customers.length === 0) {
      return {
        intent: "export-customers-csv",
        csv: "",
        filename: "",
        error: "No customers to export.",
      } satisfies ExportCustomersResult;
    }

    // Basic Shopify customer import columns.
    const headers = [
      "First Name",
      "Last Name",
      "Email",
      "Phone",
      "Company",
      "Tags",
      "Accepts Email Marketing",
      "Note",
    ];

    const rows = [headers.map(escapeCSV).join(",")];

    for (const customer of customers) {
      const note = customer.id ? `BigCommerce Customer ID: ${customer.id}` : "";
      const row = [
        escapeCSV(customer.first_name || ""),
        escapeCSV(customer.last_name || ""),
        escapeCSV(customer.email || ""),
        escapeCSV(customer.phone || ""),
        escapeCSV(customer.company || ""),
        escapeCSV(defaultTag),
        escapeCSV(toBoolString(acceptsMarketing)),
        escapeCSV(note),
      ];
      rows.push(row.join(","));
    }

    const csvContent = "\uFEFF" + rows.join("\n");
    const base64 = Buffer.from(csvContent, "utf-8").toString("base64");

    return {
      intent: "export-customers-csv",
      csv: base64,
      filename: "customers_shopify.csv",
    } satisfies ExportCustomersResult;
  }

  return null;
};

export default function CustomerMigrator() {
  const fetchCustomersFetcher = useFetcher<FetchCustomersResult>();
  const exportCustomersFetcher = useFetcher<ExportCustomersResult>();

  const [customers, setCustomers] = useState<BigCommerceCustomer[]>([]);
  const [defaultTag, setDefaultTag] = useState("Imported from BigCommerce");
  const [acceptsMarketing, setAcceptsMarketing] = useState(true);
  const lastDownloadedCsvRef = useRef<string | null>(null);

  const isFetchingCustomers =
    fetchCustomersFetcher.state !== "idle" &&
    fetchCustomersFetcher.formData?.get("_action") === "fetch-customers";

  const isExportingCustomers =
    exportCustomersFetcher.state !== "idle" &&
    exportCustomersFetcher.formData?.get("_action") === "export-customers-csv";

  useEffect(() => {
    if (
      fetchCustomersFetcher.data?.intent === "fetch-customers" &&
      fetchCustomersFetcher.data.success
    ) {
      setCustomers(fetchCustomersFetcher.data.customers);
    }
  }, [fetchCustomersFetcher.data]);

  useEffect(() => {
    if (
      exportCustomersFetcher.data?.intent !== "export-customers-csv" ||
      !exportCustomersFetcher.data.csv ||
      exportCustomersFetcher.data.csv === lastDownloadedCsvRef.current
    ) {
      return;
    }

    const base64 = exportCustomersFetcher.data.csv;
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
    a.download = exportCustomersFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    lastDownloadedCsvRef.current = exportCustomersFetcher.data.csv;
  }, [exportCustomersFetcher.data]);

  const displayCustomers = useMemo(() => {
    if (
      fetchCustomersFetcher.data?.intent === "fetch-customers" &&
      fetchCustomersFetcher.data.success &&
      fetchCustomersFetcher.data.customers.length > 0
    ) {
      return fetchCustomersFetcher.data.customers;
    }
    return customers;
  }, [fetchCustomersFetcher.data, customers]);

  const stats = useMemo(() => {
    const companies = new Set(
      displayCustomers.map((c) => c.company?.trim()).filter(Boolean),
    );
    const withPhone = displayCustomers.filter((c) => c.phone).length;

    return {
      total: displayCustomers.length,
      uniqueCompanies: companies.size,
      withPhone,
    };
  }, [displayCustomers]);

  const fetchError =
    fetchCustomersFetcher.data?.intent === "fetch-customers" &&
    fetchCustomersFetcher.data.error
      ? fetchCustomersFetcher.data.error
      : null;

  const exportError =
    exportCustomersFetcher.data?.intent === "export-customers-csv" &&
    exportCustomersFetcher.data.error
      ? exportCustomersFetcher.data.error
      : null;

  return (
    <s-page heading="BigCommerce -> Shopify Customer Migrator">
      <s-section heading="BigCommerce Credentials - Step 1">
        <fetchCustomersFetcher.Form method="POST">
          <input type="hidden" name="_action" value="fetch-customers" />
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
                details="Requires Customers -> Read-only permission"
                required
              />
            </s-stack>

            {fetchError && (
              <s-banner tone="critical" dismissible>
                {fetchError}
              </s-banner>
            )}

            {fetchCustomersFetcher.data?.intent === "fetch-customers" &&
              fetchCustomersFetcher.data.success && (
                <s-banner tone="success" dismissible>
                  {fetchCustomersFetcher.data.count} customers found. Ready to
                  export!
                </s-banner>
              )}

            <s-button
              variant="primary"
              type="submit"
              {...(isFetchingCustomers ? { loading: true } : {})}
            >
              Fetch Customers
            </s-button>
          </s-stack>
        </fetchCustomersFetcher.Form>
      </s-section>

      {displayCustomers.length > 0 && (
        <s-section heading="Customers Preview - Step 2">
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
                  <s-paragraph color="subdued">Customers found</s-paragraph>
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
                  <strong>{stats.uniqueCompanies}</strong>
                  <s-paragraph color="subdued">Unique companies</s-paragraph>
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
                  <strong>{stats.withPhone}</strong>
                  <s-paragraph color="subdued">With phone</s-paragraph>
                </s-stack>
              </s-box>
            </s-stack>

            <s-box borderWidth="base" borderRadius="base" overflow="hidden">
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header format="numeric">#</s-table-header>
                  <s-table-header>Name</s-table-header>
                  <s-table-header>Email</s-table-header>
                  <s-table-header>Company</s-table-header>
                  <s-table-header>Phone</s-table-header>
                  <s-table-header>Created</s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {displayCustomers.slice(0, 50).map((customer, index) => {
                    const fullName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim();

                    let created = "-";
                    if (customer.date_created) {
                      const d = new Date(customer.date_created);
                      if (!isNaN(d.getTime())) {
                        created = d.toLocaleDateString("en", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        });
                      }
                    }

                    return (
                      <s-table-row key={customer.id || index}>
                        <s-table-cell>{index + 1}</s-table-cell>
                        <s-table-cell>{fullName || "(No name)"}</s-table-cell>
                        <s-table-cell>{customer.email || "-"}</s-table-cell>
                        <s-table-cell>{customer.company || "-"}</s-table-cell>
                        <s-table-cell>{customer.phone || "-"}</s-table-cell>
                        <s-table-cell>{created}</s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            </s-box>

            {displayCustomers.length > 50 && (
              <s-paragraph color="subdued">
                Showing 50 of {displayCustomers.length} customers in preview.
                All customers will be included in the CSV.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

      {displayCustomers.length > 0 && (
        <s-section heading="Export CSV for Shopify - Step 3">
          <exportCustomersFetcher.Form method="POST">
            <input type="hidden" name="_action" value="export-customers-csv" />
            <input
              type="hidden"
              name="customers"
              value={JSON.stringify(displayCustomers)}
            />
            <input
              type="hidden"
              name="acceptsMarketing"
              value={acceptsMarketing ? "on" : "off"}
            />

            <s-stack direction="block" gap="base">
              <s-text-field
                label="Default customer tag"
                name="defaultTag"
                value={defaultTag}
                placeholder="for example: Imported from BigCommerce"
                onChange={(e) => setDefaultTag(e.currentTarget.value)}
              />

              <s-box>
                <label>
                  <input
                    type="checkbox"
                    checked={acceptsMarketing}
                    onChange={(e) => setAcceptsMarketing(e.currentTarget.checked)}
                  />{" "}
                  Mark imported customers as subscribed to email marketing
                </label>
              </s-box>

              {exportError && (
                <s-banner tone="critical" dismissible>
                  {exportError}
                </s-banner>
              )}

              <s-button
                variant="primary"
                type="submit"
                {...(isExportingCustomers ? { loading: true } : {})}
              >
                Download CSV ({displayCustomers.length} customers)
              </s-button>
            </s-stack>
          </exportCustomersFetcher.Form>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
