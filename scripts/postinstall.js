const repo = "https://github.com/TacosyHorchata/pilot";

console.log(`
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1m  pilot installed — your AI agent, inside your real browser\x1b[0m

  \x1b[1mQuick start:\x1b[0m
    1. npx playwright install chromium
    2. npx pilot-mcp --install-extension
    3. Add to your .mcp.json:

       { "mcpServers": { "pilot": {
           "command": "npx",
           "args": ["-y", "pilot-mcp"]
       }}}

  \x1b[1mExtension mode\x1b[0m (recommended):
    Install the Chrome extension and your agent controls
    a tab in YOUR browser — already logged in, no Cloudflare.

  \x1b[33m  Star the repo: ${repo}\x1b[0m
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`);
