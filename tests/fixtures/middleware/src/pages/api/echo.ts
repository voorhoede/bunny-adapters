import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) =>
  Response.json({ url: url.href, received: (await request.text()).length });
