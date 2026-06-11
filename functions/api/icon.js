const ALLOWED_HOSTS = new Set(["bin.bnbstatic.com"]);
const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="60" fill="#0f1f1a"/><path d="M31 62h58M60 33v54M39 43l42 38M81 43 39 81" stroke="#42f5a8" stroke-width="10" stroke-linecap="round"/></svg>`;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";

  if (!target) {
    return fallback();
  }

  let iconUrl;
  try {
    iconUrl = new URL(target);
  } catch {
    return fallback();
  }

  if (iconUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(iconUrl.hostname)) {
    return fallback();
  }

  try {
    const response = await fetch(iconUrl.toString(), {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 AlphaRightsideMonitor/1.0"
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 86400
      }
    });

    if (!response.ok) {
      return fallback();
    }

    const contentType = response.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
      return fallback();
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        "access-control-allow-origin": "*"
      }
    });
  } catch {
    return fallback();
  }
}

function fallback() {
  return new Response(fallbackSvg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*"
    }
  });
}
