# Wixsite-to-Custom-Domain-Proxy

A lightweight **reverse proxy** solution for serving free Wix sites under your own custom domain using **Azure Functions**. This project strips away Wix banners, rewrites links, proxies assets and API calls, and injects SEO-friendly headers, making your Wix site look professional without paying for Wix’s premium plans.

---

## ✨ Features

* **Reverse proxy** for Wix-hosted sites (via Azure Functions HTTP trigger).
* **Cleans URLs** by rewriting Wix absolute links to your custom domain.
* **Supports Wix APIs** – relays `/_api` requests through `/__x/wixapi`.
* **Static assets & workers** – proxies images, CSS, JS, and service workers.
* **Removes Wix banners/ads** and fixes layout offsets.
* **SEO Enhancements**: injects canonical links, favicons, Open Graph/Twitter meta tags.
* **Caching headers** for improved performance.
* Runs on **Node.js 20** (Azure Functions v4).

---

## 📂 Project Structure

```
root/
├── host.json
├── package.json
└── Proxy/
    ├── function.json
    └── index.js   # main proxy logic
```

---

## ⚙️ Configuration

Edit [`config.js`](config.js) or provide equivalent environment variables:

* `ORIGIN` – your Wix origin (e.g. `https://<yoursite>.wixsite.com`).
* `SITE_PATH` – the Wix path prefix (e.g. `/mysitename`).
* `PUBLIC_HOST` – your custom domain (e.g. `https://www.example.com`).
* `PUBLIC_BASE` – optional if you want to deploy under a subpath.
* `FAVICON_URL` / `OG_IMAGE_URL` – local assets for branding.
* `SITE_TITLE` / `SITE_DESCRIPTION` – SEO metadata injected into HTML pages.

Other tunables like `TIMEOUT_MS` and `ALLOW_METHODS` live at the top of [`Proxy/index.js`](Proxy/index.js).

---

## 🚀 Deployment

1. Create an **Azure Functions App** (Node 20, Linux).
2. Add these project files to a GitHub repo.
3. Let Azure set up a GitHub Actions workflow.
4. Push changes to `main` (or your workflow branch).
5. Once deployed, your proxy will be live at `https://<APP_NAME>.azurewebsites.net/`.

---

## 🌐 Custom Domain Setup

1. In Azure Portal → Function App → **Custom domains**, add your domain.
2. Set a **DNS CNAME** record: `www → <APP_NAME>.azurewebsites.net`.
3. Request and bind a managed TLS certificate.
4. Enable **HTTPS Only**.
5. Optionally, redirect the naked domain to `www`.

---

## 🛠 Local Development

Install [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local):

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
func start
```

This will run the proxy locally for testing.

---

## ⚠️ Notes

* This project is **community-maintained** and tailored for educational/demo purposes.
* Some Wix apps (e.g., Forms, Bookings) may require extra handling.
* Use responsibly, respecting Wix’s TOS.

---

## 🙏 Acknowledgements

Originally developed as part of the **ViaAdNexus project (NOC 2025 August)**. Inspired by the need to give student startups professional-looking domains without incurring heavy costs.

---

## 📄 License

[Apache-2.0](LICENSE) – includes an explicit patent license.

