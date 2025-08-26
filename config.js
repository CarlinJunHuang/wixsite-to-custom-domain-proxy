module.exports = {
  ORIGIN: process.env.ORIGIN || "https://viaadnexusnus.wixsite.com",
  SITE_PATH: process.env.SITE_PATH || "/viaadnexus",
  PUBLIC_HOST: process.env.PUBLIC_HOST || "https://www.viaadnexus.top",
  PUBLIC_BASE: process.env.PUBLIC_BASE || "",
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || process.env.PUBLIC_HOST || "https://www.viaadnexus.top",
  FAVICON_URL: process.env.FAVICON_URL || "/assets/viaadnexus_logo.png",
  OG_IMAGE_URL: process.env.OG_IMAGE_URL || process.env.FAVICON_URL || "/assets/viaadnexus_logo.png",
  LOGO_ALT_NAMES: (process.env.LOGO_ALT_NAMES ? process.env.LOGO_ALT_NAMES.split(',') : ["viaadnexus_logo.png", "viaadnexus_logo1.png"])
};
