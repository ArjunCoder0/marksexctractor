import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Proxy /api/groq/* → https://api.groq.com (bypasses CORS)
app.use(
  "/api/groq",
  createProxyMiddleware({
    target: "https://api.groq.com",
    changeOrigin: true,
    pathRewrite: { "^/api/groq": "" },
    on: {
      error: (err, req, res) => {
        console.error("Proxy error:", err.message);
        res.status(502).json({ error: "Proxy error", details: err.message });
      },
    },
  })
);

// Serve built React app
app.use(express.static(join(__dirname, "dist")));

// SPA fallback — all routes → index.html
app.use((req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Marksheet Extractor running on port ${PORT}`);
});
