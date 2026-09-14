import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const certificate = fileURLToPath(new URL("./data/rochester-lan-https.pfx", import.meta.url));
const https = existsSync(certificate)
  ? {pfx: readFileSync(certificate), passphrase: "codex-local-vr"}
  : undefined;
if (!https) console.warn("[AR] HTTPS certificate missing. Run scripts/setup-https.ps1 for Quest LAN access.");

const hosting = {
  host: "0.0.0.0", port: 5182, strictPort: true, https,
  headers: {"Permissions-Policy": "xr-spatial-tracking=(self)"},
};

export default defineConfig({ server: hosting, preview: hosting });
