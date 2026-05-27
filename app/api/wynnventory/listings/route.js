const WYNNVENTORY_BASE_URL =
  process.env.WYNNVENTORY_BASE_URL ?? "https://wynnventory.com";

const LISTING_QUERY_KEYS = [
  "item_name",
  "rarity",
  "shiny",
  "unidentified",
  "tier",
  "itemType",
  "subType",
  "sort",
  "page",
  "page_size",
];

export async function GET(request) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL("/api/trademarket/listings", WYNNVENTORY_BASE_URL);

  LISTING_QUERY_KEYS.forEach((key) => {
    const value = requestUrl.searchParams.get(key);
    if (value !== null && value !== "") {
      targetUrl.searchParams.set(key, value);
    }
  });

  return proxyWynnventory(targetUrl);
}

async function proxyWynnventory(targetUrl) {
  const authorization = getServerAuthorization();

  if (!authorization) {
    return Response.json(
      { error: "Missing WYNNVENTORY_API_KEY server environment variable" },
      { status: 500 },
    );
  }

  const headers = {
    Accept: "application/json",
    Authorization: authorization,
  };

  try {
    const response = await fetch(targetUrl, {
      cache: "no-store",
      headers,
    });
    const body = await response.text();

    return new Response(body, {
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
      status: response.status,
    });
  } catch {
    return Response.json(
      { error: "Unable to reach WynnVentory API" },
      { status: 502 },
    );
  }
}

function getServerAuthorization() {
  const apiKey = process.env.WYNNVENTORY_API_KEY?.trim();

  if (!apiKey) {
    return "";
  }

  return apiKey.toLowerCase().startsWith("api-key ")
    ? apiKey
    : `Api-Key ${apiKey}`;
}
