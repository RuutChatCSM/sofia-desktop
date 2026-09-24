export const dynamic = "force-static"

const linkset = {
  linkset: [
    {
      anchor: "https://sofia-api.ruut.chat",
      "service-desc": [
        {
          href: "https://sofia-api.ruut.chat/openapi.json",
          type: "application/vnd.oai.openapi+json;version=3.1",
          title: "Sofia Den API — OpenAPI 3.1 document",
        },
      ],
      "service-doc": [
        {
          href: "https://sofia.ruut.chat/docs/api-reference",
          type: "text/html",
          title: "Sofia Den API — human documentation",
        },
      ],
      status: [
        {
          href: "https://sofia-api.ruut.chat/health",
          type: "application/json",
          title: "Sofia Den API — health endpoint",
        },
      ],
      "service-meta": [
        {
          href: "https://sofia.ruut.chat/llms.txt",
          type: "text/plain",
          title: "Sofia llms.txt — agent-facing site guide",
        },
      ],
    },
  ],
}

export function GET() {
  return new Response(JSON.stringify(linkset, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
