// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

import { SITE_URL } from "./src/consts";

/**
 * Astro 7 static build.
 *
 * Deployment target is Cloudflare Pages (spec §2): the repo is pushed to
 * GitHub and CF Pages runs `pnpm build` -> publishes `dist/`.
 * There is deliberately no adapter — this is a fully static site.
 */
export default defineConfig({
  // Single source of truth for the domain lives in src/consts.ts.
  site: SITE_URL,
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      // Legal / utility pages add no search value.
      filter: (page) => !/\/(privacy|contact)\/$/.test(page),
    }),
  ],
  markdown: {
    shikiConfig: { theme: "github-light" },
  },
  build: {
    // Emit /about/index.html style paths so URLs stay extension-less.
    format: "directory",
  },
});
