// The script runs as middleware in front of a storage-origin pull zone, so a
// pull zone reads the files from the nearest storage replica itself.
import { defineConfig } from "astro/config";
import bunny from "@bunny.net/astro-adapter";

export default defineConfig({
  build: { inlineStylesheets: "never" },
  security: { csp: true },
  redirects: { "/old": "/about" },
  adapter: bunny({ script: "middleware" }),
});
