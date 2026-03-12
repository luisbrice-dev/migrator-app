import { useState, useMemo, useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// ─── Types ───
interface BlogPost {
  title?: string;
  body?: string;
  summary?: string;
  author?: string;
  tags?: string[] | string;
  published_date?: string | { date: string };
  published_date_iso8601?: string;
  url?: string;
  thumbnail_path?: string;
  preview_url?: string;
}

interface FetchResult {
  intent: "fetch-blogs";
  success: boolean;
  count: number;
  posts: BlogPost[];
  error?: string;
}

interface ExportResult {
  intent: "export-csv";
  csv: string;
  filename: string;
  error?: string;
}

// ─── Server helpers ───

function makeAbsolute(url: string | undefined, domain: string): string {
  if (!url || url.startsWith("http") || url.startsWith("//")) return url || "";
  return domain + (url.startsWith("/") ? "" : "/") + url;
}

function fixBodyImages(body: string, domain: string): string {
  let fixed = body;
  fixed = fixed.replace(/src="\/([^"]+)"/g, `src="${domain}/$1"`);
  fixed = fixed.replace(/src='\/([^']+)'/g, `src='${domain}/$1'`);
  fixed = fixed.replace(
    /src="product_images\//g,
    `src="${domain}/product_images/`
  );
  return fixed;
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

function formatDate(rawDate: unknown): string {
  if (!rawDate) return "";
  try {
    let dateStr = rawDate;
    if (typeof rawDate === "object" && rawDate !== null && "date" in rawDate) {
      dateStr = (rawDate as { date: string }).date;
    }
    const date = new Date(dateStr as string);
    if (isNaN(date.getTime())) return "";
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return "";
  }
}

function extractHandle(url: string | undefined): string {
  if (!url) return "";
  return (
    url
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .pop() || ""
  );
}

// ─── Loader ───
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

// ─── Action ───
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  // ═══ FETCH BLOGS ═══
  if (intent === "fetch-blogs") {
    const storeHash = formData.get("storeHash") as string;
    const accessToken = formData.get("accessToken") as string;
    const storeDomain = (
      (formData.get("storeDomain") as string) || ""
    ).replace(/\/+$/, "");

    if (!storeHash || !accessToken) {
      return {
        intent: "fetch-blogs",
        success: false,
        count: 0,
        posts: [],
        error: "Store Hash and Access Token are required.",
      } satisfies FetchResult;
    }

    try {
      let allPosts: BlogPost[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.bigcommerce.com/stores/${storeHash}/v2/blog/posts?limit=250&page=${page}`;
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
            intent: "fetch-blogs",
            success: false,
            count: 0,
            posts: [],
            error: errorMsg,
          } satisfies FetchResult;
        }

        const posts: BlogPost[] = await response.json();

        if (!Array.isArray(posts) || posts.length === 0) {
          hasMore = false;
        } else {
          const processedPosts = posts.map((post) => {
            const domain = storeDomain;
            if (domain) {
              post.url = makeAbsolute(post.url, domain);
              post.thumbnail_path = makeAbsolute(post.thumbnail_path, domain);
              post.preview_url = makeAbsolute(post.preview_url, domain);
              if (post.body) {
                post.body = fixBodyImages(post.body, domain);
              }
            }
            return post;
          });

          allPosts = allPosts.concat(processedPosts);
          if (posts.length < 250) {
            hasMore = false;
          } else {
            page++;
          }
        }
      }

      return {
        intent: "fetch-blogs",
        success: true,
        count: allPosts.length,
        posts: allPosts,
      } satisfies FetchResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        intent: "fetch-blogs",
        success: false,
        count: 0,
        posts: [],
        error: `Connection error: ${message}`,
      } satisfies FetchResult;
    }
  }

  // ═══ EXPORT CSV ═══
  if (intent === "export-csv") {
    const postsJson = formData.get("posts") as string;
    const blogTitle = (formData.get("blogTitle") as string) || "News";

    let posts: BlogPost[];
    try {
      posts = JSON.parse(postsJson);
    } catch {
      return { intent: "export-csv", csv: "", filename: "", error: "Invalid JSON." } satisfies ExportResult;
    }

    if (!Array.isArray(posts) || posts.length === 0) {
      return { intent: "export-csv", csv: "", filename: "", error: "No posts to export." } satisfies ExportResult;
    }

    const headers = [
      "Title",
      "Body HTML",
      "Summary HTML",
      "Author",
      "Tags",
      "Published At",
      "Handle",
      "Image Src",
      "Image Alt Text",
      "Blog Title",
    ];

    const rows = [headers.map(escapeCSV).join(",")];

    for (const post of posts) {
      let tags = "";
      if (Array.isArray(post.tags)) {
        tags = post.tags.join(", ");
      } else if (typeof post.tags === "string") {
        tags = post.tags;
      }

      const row = [
        escapeCSV(post.title || ""),
        escapeCSV(post.body || ""),
        escapeCSV(post.summary || ""),
        escapeCSV(post.author || ""),
        escapeCSV(tags),
        escapeCSV(
          formatDate(post.published_date_iso8601 || post.published_date || "")
        ),
        escapeCSV(extractHandle(post.url || "")),
        escapeCSV(post.thumbnail_path || ""),
        escapeCSV(post.title || ""),
        escapeCSV(blogTitle),
      ];

      rows.push(row.join(","));
    }

    const csvContent = "\uFEFF" + rows.join("\n");
    const base64 = Buffer.from(csvContent, "utf-8").toString("base64");

    return {
      intent: "export-csv",
      csv: base64,
      filename: "blogs_shopify.csv",
    } satisfies ExportResult;
  }

  return null;
};

// ─── Component ───
export default function BlogMigrator() {
  const fetchBlogsFetcher = useFetcher<FetchResult>();
  const exportFetcher = useFetcher<ExportResult>();

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [blogTitle, setBlogTitle] = useState("News");
  const lastDownloadedCsvRef = useRef<string | null>(null);

  // Track fetching / exporting state
  const isFetching =
    fetchBlogsFetcher.state !== "idle" &&
    fetchBlogsFetcher.formData?.get("_action") === "fetch-blogs";
  const isExporting =
    exportFetcher.state !== "idle" &&
    exportFetcher.formData?.get("_action") === "export-csv";

  useEffect(() => {
    if (
      fetchBlogsFetcher.data?.intent === "fetch-blogs" &&
      fetchBlogsFetcher.data.success
    ) {
      setPosts(fetchBlogsFetcher.data.posts);
    }
  }, [fetchBlogsFetcher.data]);

  useEffect(() => {
    if (
      exportFetcher.data?.intent !== "export-csv" ||
      !exportFetcher.data.csv ||
      exportFetcher.data.csv === lastDownloadedCsvRef.current
    ) {
      return;
    }

    const base64 = exportFetcher.data.csv;
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
    a.download = exportFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    lastDownloadedCsvRef.current = exportFetcher.data.csv;
  }, [exportFetcher.data]);

  // Use the most recently fetched posts (either from state or fetcher data)
  const displayPosts = useMemo(() => {
    if (
      fetchBlogsFetcher.data?.intent === "fetch-blogs" &&
      fetchBlogsFetcher.data.success &&
      fetchBlogsFetcher.data.posts.length > 0
    ) {
      return fetchBlogsFetcher.data.posts;
    }
    return posts;
  }, [fetchBlogsFetcher.data, posts]);

  // Compute stats
  const stats = useMemo(() => {
    const authors = new Set(displayPosts.map((p) => p.author).filter(Boolean));
    const allTags = new Set<string>();
    displayPosts.forEach((p) => {
      if (Array.isArray(p.tags)) {
        p.tags.forEach((t) => allTags.add(String(t)));
      } else if (typeof p.tags === "string" && p.tags) {
        p.tags.split(",").forEach((t) => allTags.add(t.trim()));
      }
    });
    return { total: displayPosts.length, authors: authors.size, tags: allTags.size };
  }, [displayPosts]);

  const fetchError =
    fetchBlogsFetcher.data?.intent === "fetch-blogs" && fetchBlogsFetcher.data.error
      ? fetchBlogsFetcher.data.error
      : null;

  const exportError =
    exportFetcher.data?.intent === "export-csv" && exportFetcher.data.error
      ? exportFetcher.data.error
      : null;

  return (
    <s-page heading="BigCommerce → Shopify Blog Migrator">
      {/* ── Step 1: Credentials ── */}
      <s-section heading="BigCommerce Credentials - Step 1">
        <fetchBlogsFetcher.Form method="POST">
          <input type="hidden" name="_action" value="fetch-blogs" />
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
                details="Requires Content -> Read-only permission"
                required
              />
              <s-text-field
                label="Store domain (URL)"
                name="storeDomain"
                placeholder="https://my-store.com"
                details="Used to convert relative paths into absolute URLs"
              />
            </s-stack>

            {fetchError && (
              <s-banner tone="critical" dismissible>
                {fetchError}
              </s-banner>
            )}

            {fetchBlogsFetcher.data?.intent === "fetch-blogs" &&
              fetchBlogsFetcher.data.success && (
                <s-banner tone="success" dismissible>
                  {fetchBlogsFetcher.data.count} posts found. Ready to export!
                </s-banner>
              )}

            <s-button
              variant="primary"
              type="submit"
              {...(isFetching ? { loading: true } : {})}
            >
              🌐 Fetch Blog Posts
            </s-button>
          </s-stack>
        </fetchBlogsFetcher.Form>
      </s-section>

      {/* ── Step 2: Preview ── */}
      {displayPosts.length > 0 && (
        <s-section heading="Posts Preview - Step 2">
          <s-stack direction="block" gap="base">
            {/* Stats */}
            <s-stack direction="inline" gap="base">
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="120px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.total}</strong>
                  <s-paragraph color="subdued">Posts found</s-paragraph>
                </s-stack>
              </s-box>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="120px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.authors}</strong>
                  <s-paragraph color="subdued">Authors</s-paragraph>
                </s-stack>
              </s-box>
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
                minInlineSize="120px"
              >
                <s-stack direction="block" gap="base">
                  <strong>{stats.tags}</strong>
                  <s-paragraph color="subdued">Unique tags</s-paragraph>
                </s-stack>
              </s-box>
            </s-stack>

            {/* Posts Table */}
            <s-box borderWidth="base" borderRadius="base" overflow="hidden">
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header format="numeric">#</s-table-header>
                  <s-table-header>Title</s-table-header>
                  <s-table-header>Author</s-table-header>
                  <s-table-header>Tags</s-table-header>
                  <s-table-header>Date</s-table-header>
                  <s-table-header>Handle</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {displayPosts.slice(0, 50).map((post, i) => {
                    let tagsStr = "—";
                    if (Array.isArray(post.tags) && post.tags.length > 0) {
                      tagsStr = post.tags.slice(0, 3).join(", ");
                      if (post.tags.length > 3)
                        tagsStr += ` +${post.tags.length - 3}`;
                    } else if (typeof post.tags === "string" && post.tags) {
                      tagsStr = post.tags;
                    }

                    const handle = extractHandle(post.url || "");

                    let formattedDate = "—";
                    const dateStr =
                      post.published_date_iso8601 ||
                      (typeof post.published_date === "string"
                        ? post.published_date
                        : "") ||
                      "";
                    if (dateStr) {
                      try {
                        const d = new Date(dateStr as string);
                        if (!isNaN(d.getTime())) {
                          formattedDate = d.toLocaleDateString("en", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          });
                        }
                      } catch {
                        /* ignore */
                      }
                    }

                    return (
                      <s-table-row key={i}>
                        <s-table-cell>{i + 1}</s-table-cell>
                        <s-table-cell>{post.title || "(Untitled)"}</s-table-cell>
                        <s-table-cell>{post.author || "-"}</s-table-cell>
                        <s-table-cell>{tagsStr}</s-table-cell>
                        <s-table-cell>{formattedDate}</s-table-cell>
                        <s-table-cell>{handle || "-"}</s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            </s-box>

            {displayPosts.length > 50 && (
              <s-paragraph color="subdued">
                Showing 50 of {displayPosts.length} posts in preview. All posts
                will be included in the CSV.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

      {/* ── Step 3: Export ── */}
      {displayPosts.length > 0 && (
        <s-section heading="Export CSV for Shopify - Step 3">
          <exportFetcher.Form method="POST">
            <input type="hidden" name="_action" value="export-csv" />
            <input
              type="hidden"
              name="posts"
              value={JSON.stringify(displayPosts)}
            />
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Shopify blog name"
                name="blogTitle"
                value={blogTitle}
                placeholder="for example: News"
                onChange={(e) => setBlogTitle(e.currentTarget.value)}
              />

              {exportError && (
                <s-banner tone="critical" dismissible>
                  {exportError}
                </s-banner>
              )}

              <s-button
                variant="primary"
                type="submit"
                {...(isExporting ? { loading: true } : {})}
              >
                Download CSV ({displayPosts.length} posts)
              </s-button>
            </s-stack>
          </exportFetcher.Form>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
