module.exports = {
  ORIGIN: process.env.ORIGIN || "https://example.wixsite.com",
  SITE_PATH: process.env.SITE_PATH || "/mysite",
  PUBLIC_HOST: process.env.PUBLIC_HOST || "https://www.example.com",
  PUBLIC_BASE: process.env.PUBLIC_BASE || "",
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || process.env.PUBLIC_HOST || "https://www.example.com",
  FAVICON_URL: process.env.FAVICON_URL || "/assets/logo.png",
  OG_IMAGE_URL: process.env.OG_IMAGE_URL || process.env.FAVICON_URL || "/assets/logo.png",
  LOGO_ALT_NAMES: (process.env.LOGO_ALT_NAMES ? process.env.LOGO_ALT_NAMES.split(',') : ["logo.png", "logo1.png"]),
  SITE_TITLE: process.env.SITE_TITLE || "My Proxy Site",
  SITE_DESCRIPTION: process.env.SITE_DESCRIPTION || "Proxying a Wix site through a custom domain"
};
