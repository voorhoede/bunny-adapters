// @ts-check
import { defineConfig } from "astro/config";
import bunny from "@bunny.net/astro-adapter";

// Every option here is set on purpose, so the site exercises it. A real
// project needs none of them: `adapter: bunny()` is the whole configuration.
export default defineConfig({
  output: "server",

  build: {
    // Emit a stylesheet file instead of inlining it, so the site exercises the
    // path where the script serves an asset out of Bunny Storage.
    inlineStylesheets: "never",
  },

  adapter: bunny({
    // `tests/e2e.mjs --middleware` builds the same site as a middleware script.
    script: process.env.SHOWCASE_SCRIPT === "middleware" ? "middleware" : "standalone",
    // Bunny Optimizer resizes images at the edge. Turn Optimizer on for the
    // pull zone, or the original image is served unchanged.
    imageService: "bunny",
    image: {
      widths: [360, 720, 1080],
      quality: 82,
    },
  }),

  // Cache rules for the CDN. The adapter turns these into Cache-Control and
  // CDN-Tag headers, and purges by tag.
  routeRules: {
    "/cached": { maxAge: 60, swr: 600, tags: ["demo"] },
  },

  session: {
    cookie: { name: "showcase-session", sameSite: "lax" },
  },
});
