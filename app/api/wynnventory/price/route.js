const WYNNVENTORY_BASE_URL =
  process.env.WYNNVENTORY_BASE_URL ?? "https://wynnventory.com";

export async function GET(request) {
  const requestUrl = new URL(request.url);
  const itemName = requestUrl.searchParams.get("name");

  if (!itemName) {
    return Response.json({ error: "Missing item name" }, { status: 400 });
  }

  const targetUrl = new URL(
    `/api/trademarket/item/${encodeURIComponent(itemName)}/price`,
    WYNNVENTORY_BASE_URL,
  );
  const shiny = requestUrl.searchParams.get("shiny");
  const tier = requestUrl.searchParams.get("tier");

  if (shiny) {
    targetUrl.searchParams.set("shiny", shiny);
  }
  if (tier) {
    targetUrl.searchParams.set("tier", tier);
  }

  const headers = {
    Accept: "application/json",
  };
  const authorization = getServerAuthorization();

  if (authorization) {
    headers.Authorization = authorization;
  } else {
    return Response.json(
      { error: "Missing WYNNVENTORY_API_KEY server environment variable" },
      { status: 500 },
    );
  }

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
