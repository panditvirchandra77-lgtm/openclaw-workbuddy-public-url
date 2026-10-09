# OpenClaw — WorkBuddy Sandbox pe Permanent Public URL 🦋

WorkBuddy / CloudStudio sandbox ke andar OpenClaw dashboard (`127.0.0.1:18789`) ko
**bina kisi tunnel ke** real public URL par expose karne ka complete guide.

> **No ngrok. No cloudflared. No Tailscale. No account login.**
> Sirf platform ka native publish + ek chhota zero-dependency reverse proxy.

Adapted from
[`panditvirchandra77-lgtm/manus-dashboard-public`](https://github.com/panditvirchandra77-lgtm/manus-dashboard-public)
(Manus box ke liye likha gaya tha). WorkBuddy sandbox par do cheezein alag mili —
[ Differences from the Manus guide ](#differences-from-the-manus-guide) dekho.

---

## Result

| | |
| --- | --- |
| **Public URL** | `https://<your-app-id>.sg2.agentos-app.run` |
| **Token-login URL** | `https://<your-app-id>.sg2.agentos-app.run/#token=<gateway-token>` |
| **Verified** | `HTTP 200` · `<title>OpenClaw Control</title>` |
| **Tunnel** | ❌ none |
| **WebSocket** | ✅ works (Control UI live updates) |

---

## Problem

Do alag problems hain — dono ko alag tareeke se solve karna padta hai.

**1. Dashboard sirf loopback par sun raha hai.**
OpenClaw gateway `127.0.0.1:18789` par bind hota hai. Sandbox ke bahar se koi
direct public address nahi — isliye koi na koi reverse proxy chahiye.

**2. Proxy lagate hi 403 milta hai.** Proxy ke peeche se request jaate hi
dashboard ye deta hai:

```json
{"error":{"message":"Proxy client attribution is required. Configure gateway.trustedProxies narrowly...","type":"proxy_attribution_required"}}
```

Aur ye wala ilaaj — `gateway.trustedProxies` me proxy ka IP daalna — **is sandbox
par kaam nahi karta**. Kyun, wo [Part 7](#part-7--403-ka-asli-root-cause) me
source code ke saath likha hai.

> **Note:** agar aap Manus box par hain to problem thodi alag hai — wahan proxy ka
> client IP `10.x.x.x` hota hai (loopback nahi), isliye wahan `trustedProxies` me
> CIDR daalna hi sahi fix hai. Dono cases ka comparison
> [Differences from the Manus guide](#differences-from-the-manus-guide) me hai.

---

## Root Cause

403 koi random bug nahi hai — OpenClaw ka ingress-attribution logic **jaan-bujh
kar** aisa karta hai. `dist/worker/worker.mjs` me asli function (thoda saaf kiya
hua):

```js
function resolveGatewayIngressAttribution({ req, trustedProxies, allowRealIpFallback }) {
  const peer         = req.socket?.remoteAddress ?? "unknown";
  const hasForwarded = hasForwardedRequestHeaders(req);  // forwarded | x-real-ip | x-forwarded-*
  const hasTailscale = hasTailscaleOwnedHeaders(req);    // tailscale-*

  // 1) loopback se direct request, koi forwarded header nahi => theek
  if (isLoopbackAddress(peer) && !hasForwarded && !hasTailscale)
    return attributed("direct-local", peer);                       // ✅ 200

  // 2) peer trustedProxies me hai => headers se client IP nikaalo
  if (isTrustedProxyAddress(peer, trustedProxies)) {
    const clientIp = resolveRequestClientIpFromHeaders(req, trustedProxies, allowRealIpFallback);
    return !clientIp || isLoopbackAddress(clientIp)
      ? unattributableProxy(peer)                                  // ❌ 403
      : attributed("trusted-proxy", clientIp);                     // ✅ 200
  }

  // 3) peer trusted nahi + forwarded headers hain => 403
  return hasForwarded || hasTailscale
    ? unattributableProxy(peer)                                    // ❌ 403
    : attributed("direct-remote", peer);                           // ✅ 200
}
```

### Decision table

| Peer (proxy ka IP) | Forwarded headers | `trustedProxies` me? | Result |
| --- | --- | --- | --- |
| `127.0.0.1` | ❌ koi nahi | — | ✅ `direct-local` |
| `127.0.0.1` | ✅ present | — | ❌ **403** |
| `10.x.x.x` | ✅ real client IP | ✅ CIDR me | ✅ `trusted-proxy` |
| `10.x.x.x` | resolved IP `127.0.0.1` | ✅ CIDR me | ❌ **403** |
| `10.x.x.x` | ✅ present | ❌ nahi | ❌ **403** |
| koi bhi non-loopback | ❌ koi nahi | ❌ nahi | ✅ `direct-remote` |

### Isse do cheezein clear hoti hain

1. **`trustedProxies` me `127.0.0.1` daalna bekaar hai.** Rule 2 ke hisaab se
   resolved client IP loopback hi niklega → `isLoopbackAddress(clientIp)` → 403.
   Isliye is sandbox par sirf headers **hatana** kaam karta hai: tab peer
   `127.0.0.1` + `hasForwarded=false` → rule 1 → `direct-local` ✅.

2. **`x-forwarded-*` ko rewrite karna bhi bekaar hai** (`127.0.0.1` se bhar do
   to bhi). Header *maujood* hona hi kaafi hai — `hasForwardedRequestHeaders`
   bas ye check karta hai:
   ```js
   name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-")
   ```
   Isliye fix = **delete**, rewrite nahi.

Poora walkthrough (kaise dhoondha, kaunse log, kaunsi file) —
[Part 7](#part-7--403-ka-asli-root-cause) me hai.

---

## Architecture

```
Internet
   │  https://<your-app-id>.sg2.agentos-app.run
   ▼
Platform publish edge  (HTTPS terminate, forwards to container :8080)
   │
   ▼
proxy/server.js        ← forwarded headers STRIPPED (this is the fix)
   │
   ▼
OpenClaw gateway  ws://127.0.0.1:18789
```

---

## Prerequisites

- WorkBuddy sandbox (Linux, internet on)
- Node ≥ **22.22.3** (OpenClaw refuses to install below this — see [Part 1](#part-1--install-openclaw-node-version-trap))
- `openclaw` CLI

---

## Part 1 — Install OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

### ⚠️ Trap: Node version

Sandbox ka default Node aksar purana hota hai (e.g. `22.13.1`), aur installer
bail kar jata hai:

```
no compatible Node.js runtime is available
```

Fix — nvm se supported version lagao (system Node untouched rehta hai):

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 26
nvm alias default 26
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

Agar `openclaw` naye shell mein nahi milta (sandbox PATH nvm source nahi karta),
to ek wrapper bana do:

```bash
cat > /usr/local/bin/openclaw <<'EOF'
#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 26 >/dev/null 2>&1
exec "/root/.nvm/versions/node/v26.11.1/lib/node_modules/openclaw/dist/cli.mjs" "$@"
EOF
chmod +x /usr/local/bin/openclaw
```

Verify:

```bash
openclaw --version     # OpenClaw 2026.9.9
```

---

## Part 2 — Gateway config

Do keys **required** hain, warna gateway boot hi nahi karta:

```json
{
  "gateway": {
    "mode": "local",
    "auth": { "mode": "token", "token": "<48-hex>" }
  }
}
```

Token banao:

```bash
python3 -c "import secrets;print(secrets.token_hex(24))"
```

Apply:

```bash
openclaw config patch --file config/gateway.patch.json
openclaw config validate
```

> **Backup pehle:** `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)`
> Ek missing/galat key se gateway boot fail ho sakta hai
> ("treat this as suspicious or clobbered config").

Start:

```bash
openclaw gateway run        # default port 18789
openclaw gateway status     # Connectivity probe: ok
```

---

## Part 3 — Model provider (OpenRouter example)

OpenClaw mein custom OpenAI-compatible provider manually add karte hain:

```bash
cat > /tmp/or.patch.json <<'PATCH'
{
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-completions",
        "auth": "api-key",
        "models": [
          { "id": "poolside/laguna-s-2.1:free", "name": "Poolside Laguna S 2.1 (free)" }
        ]
      }
    }
  }
}
PATCH

openclaw config patch --file /tmp/or.patch.json
printf "%s" "sk-or-v1-..." | openclaw models auth paste-api-key --provider openrouter
openclaw models set "openrouter/poolside/laguna-s-2.1:free"
```

Test:

```bash
openclaw agent --message "Reply with exactly one word: OK"
```

> Free tier cap hota hai (~50 req/day). Log mein `status=429` dikhe to paid key
> lagao ya dusra provider add karke fallback set karo.

---

## Part 4 — Telegram bot (optional)

```bash
openclaw channels add --channel telegram --token <BOT_TOKEN>
openclaw gateway restart
```

Bot ko pehla message bhejne par wo pairing code dega:

```
Access not configured. Your Telegram user id: 8647466603
Pairing code: LFSBC8W2
```

Approve karo:

```bash
openclaw pairing approve telegram LFSBC8W2
```

Check:

```bash
openclaw channels status --probe
# telegram: enabled, configured, running, connected, mode:polling, works
```

---

## Part 5 — Gateway ko zinda rakho (watchdog)

Sandbox mein **koi systemd nahi** — idle hone par gateway mar jata hai aur
khud restart nahi hota. Watchdog lagao:

```bash
chmod +x watchdog/openclaw-watchdog.sh
./watchdog/openclaw-watchdog.sh --background
tail -f /tmp/openclaw-watchdog.log
```

Ye har 20s mein `:18789` probe karta hai aur girne par `openclaw gateway run`
dobara start karta hai.

---

## Part 6 — Public URL (bina tunnel)

### 6.1 Config — public origin allow karo

```json
{
  "gateway": {
    "bind": "lan",
    "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "publicOrigin": "https://<your-app-id>.sg2.agentos-app.run",
    "controlUi": {
      "allowedOrigins": ["https://<your-app-id>.sg2.agentos-app.run"]
    }
  }
}
```

`publicOrigin` / `allowedOrigins` **hot-reload** hote hain — full restart ki
zarurat nahi:

```bash
PID=$(ss -ltnp | grep 18789 | grep -oP 'pid=\K[0-9]+' | head -1)
kill -USR1 $PID
```

### 6.2 Proxy

`proxy/server.js` — zero dependencies, HTTP + raw WebSocket dono forward karta
hai. `PORT` env sunta hai (publish platform yahi set karta hai).

```bash
cd proxy && PORT=8099 node server.js
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8099/   # 200
```

### 6.3 Publish

```bash
node "/root/.codebuddy/skills/发布为应用/scripts/publish.js" \
  --dir ./proxy \
  --language node --port 8080 \
  --install-cmd "" --start-cmd "node server.js"
```

```json
{"shareLink":"https://<your-app-id>.sg2.agentos-app.run","verified":true}
```

Re-publish karne par **same link** milta hai.

---

## Part 7 — ⭐ 403 ka asli root cause

Pehli request par ye mila:

```json
{"error":{"message":"Proxy client attribution is required. Configure
 gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild
 forwarded client headers.","type":"proxy_attribution_required"}}
```

Error message kehta hai "trustedProxies configure karo" — **par usse fix nahi
hua.** Source (`dist/worker/worker.mjs`) padhne par asli logic mila:

```js
const hasForwarded = hasForwardedRequestHeaders(req);
const peer = socket.remoteAddress;

if (isLoopbackAddress(peer) && !hasForwarded && !hasTailscale)
    return attributed("direct-local", peer);          // ✅ accepted

if (isTrustedProxyAddress(peer, trustedProxies)) {
    const client = resolveRequestClientIpFromHeaders(req, trustedProxies, ...);
    if (!client || isLoopbackAddress(client)) return unattributableProxy(peer); // ❌
    return attributed("trusted-proxy", client);
}
return hasForwarded || hasTailscale
    ? unattributableProxy(peer)                        // ❌ 403
    : attributed("direct-remote", peer);
```

Aur `hasForwardedRequestHeaders`:

```js
key === "forwarded" || key === "x-real-ip" || key.startsWith("x-forwarded-")
```

**Matlab:** hamara proxy loopback se connect karta hai, isliye
`direct-local` tab hi milega jab **koi bhi forwarded header na ho**.

```js
// ✅ sahi fix — headers DELETE karo
if (lower.startsWith('x-forwarded-')) continue;
if (['forwarded','x-real-ip','x-client-ip','cf-connecting-ip',
     'true-client-ip','fly-client-ip'].includes(lower)) continue;
```

> ⚠️ **Rewrite mat karo.** `X-Forwarded-For: 127.0.0.1` set karne se bhi 403
> aata hai — `hasForwarded` phir bhi `true` rehta hai. Ye wahi galti hai jo
> maine pehle ki thi.

---

## Part 8 — Verify

```bash
U="https://<your-app-id>.sg2.agentos-app.run"

curl -s -o /dev/null -w "%{http_code}\n" "$U/"          # 200
curl -s "$U/" | grep -o '<title>.*</title>'             # <title>OpenClaw Control</title>
```

Browser mein `device not approved` aaye to:

```bash
openclaw devices list
openclaw devices approve <device-id>
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no compatible Node.js runtime` | Node < 22.22.3 | `nvm install 26` |
| Gateway boot fail: "clobbered config" | `gateway.mode` missing | set `mode: "local"` |
| `GatewayCredentialsRequiredError` | `gateway.auth` unset | token mode set karo |
| `403 proxy_attribution_required` | forwarded headers present on loopback peer | headers **strip** karo, rewrite nahi |
| `status probe failed` but gateway running | port mismatch (started `--port 19000`, probe reads 18789) | default port pe run karo |
| Gateway dead after idle | no systemd | watchdog script |
| `401 invalid token` from provider | key dead/expired | key rotate karo |
| `403 email_verification_required` | provider account locked | dashboard pe email verify karo |
| `429` in logs | free-tier cap | paid key ya fallback provider |

---

## Differences from the Manus guide

| Manus box | WorkBuddy / CloudStudio sandbox |
| --- | --- |
| Port-based public URL pehle se kaam karta tha (`https://18789-<id>.sg2.manus.computer/`) | Port URL **exist karta hai** par edge `302 → reason=unauthorized` deta hai — sirf logged-in owner browser ke liye |
| Fix = `trustedProxies` mein proxy IP add karna | Fix = proxy layer mein forwarded headers **strip** karna (`trustedProxies` se 403 nahi mita) |
| systemd restart available | Koi service manager nahi → watchdog script |

WorkBuddy ka native port URL (reference):

```
https://18789-<space-key>.sg2.sandbox.cloudstudio.club
→ 302 location: https://sandbox.cloudstudio.club/ws/...?reason=unauthorized
```

Isliye yahan platform ka **native publish** use kiya gaya.

---

## ⚠️ Security

Ye URL **poora Control UI** expose karta hai — agent ka shell access aur saare
saved provider keys (model API keys, Telegram bot token). Sirf gateway token se
protected hai.

- Link + token ko **password ki tarah** treat karo
- Token kabhi commit mat karo (`.gitignore` mein `openclaw.json` hai)
- Kaam ho jaye to unpublish:
  ```bash
  node "/root/.codebuddy/skills/发布为应用/scripts/unpublish.js"
  ```
- Chat/DM mein token paste kar diya ho to turant rotate karo

---

## Author

**GitHub:** [`@panditvirchandra77-lgtm`](https://github.com/panditvirchandra77-lgtm)

Is guide ka author, aur original
[`manus-dashboard-public`](https://github.com/panditvirchandra77-lgtm/manus-dashboard-public)
repo ka bhi. Sandbox pe OpenClaw chalana, 403 `proxy_attribution_required` ka
root cause dhoondhna aur bina tunnel ke public URL nikalna — sab isi account ka kaam.

| | |
| --- | --- |
| **Profile** | https://github.com/panditvirchandra77-lgtm |
| **Repos** | https://github.com/panditvirchandra77-lgtm?tab=repositories |
| **Issues welcome** | https://github.com/panditvirchandra77-lgtm/openclaw-workbuddy-public-url/issues |

> Agar aapko ye guide kaam aaye to repo ko ⭐ star kar do — doosron ko dhoondhne
> me help milti hai.

## Tools Istemal Kiye

| Tool | Kaam | Example |
| --- | --- | --- |
| `openclaw config patch/get/validate` | Config ko merge-safe badalna + schema check | `openclaw config validate` |
| `openclaw gateway run/status` | Gateway chalana, health check | `ss -ltnp \| grep 18789` |
| `openclaw dashboard --json` | Dashboard URL + token nikalna | `openclaw dashboard --json` |
| `openclaw devices approve` | Browser ko Control UI allow karna | `openclaw devices approve <id>` |
| `openclaw models set` / `models auth` | Provider + default model set karna | `openclaw models set <ref>` |
| `ss` (netstat) | Gateway PID + port `18789` dhundhna | `ss -ltnp \| grep 18789` |
| `jq` | Config JSON safely modify karna | `jq '.gateway.bind = "lan"' cfg.json` |
| `curl` | Public URL verify (HTTP code + title) | `curl -s -o /dev/null -w '%{http_code}' URL` |
| `grep` | Log se proxy IP / error reason nikalna | `grep "unattributable" /tmp/openclaw/*.log` |
| `node` (zero-dep) | Reverse proxy: HTTP + WebSocket upgrade | `node proxy/server.js` |
| `bash` loop (watchdog) | Gateway auto-restart (systemd nahi hai) | `./openclaw-watchdog.sh --background` |
| `nvm` | Node 26 pin karna (OpenClaw ko ≥22.22.3 chahiye) | `nvm install 26 && nvm use 26` |
| `openssl rand -hex 24` | Naya gateway token banana | `openssl rand -hex 24` |
| `getent hosts` / `curl -I` | Public hostname resolve + status code | `getent hosts <host>` |
| `md5sum` | Do files identical hain ya nahi (temple wala case) | `md5sum a.html b.html` |
| `git` + GitHub REST API | Repo push, metadata (topics/homepage/stars) | `gh api repos/:owner/:repo` |

**Sabse kaam ke 3:**

1. `grep "unattributable" /tmp/openclaw/*.log | grep -oP 'from \K[0-9.]+'` — 403 ka
   peer IP batata hai, aur isse hi decide hota hai ki fix `trustedProxies` hai ya
   header-strip ([Root Cause](#root-cause) dekho).
2. `ss -ltnp | grep 18789` — gateway zinda hai ya nahi, 2 second me.
3. `curl -s URL | grep -o '<title>.*</title>'` — 200 aane ke baad bhi confirm ho
   jata hai ki sahi page mil raha hai (`<title>OpenClaw Control</title>`), koi
   login/error page nahi.

## Files

| Path | What |
| --- | --- |
| `proxy/server.js` | Public reverse proxy — HTTP + WebSocket, zero deps |
| `watchdog/openclaw-watchdog.sh` | Gateway auto-restart (no systemd) |
| `config/gateway.patch.json` | Gateway config example (placeholders) |

## Links

- OpenClaw docs — https://docs.openclaw.ai
- CLI reference — https://docs.openclaw.ai/cli/dashboard
- Original Manus guide — https://github.com/panditvirchandra77-lgtm/manus-dashboard-public

## Credits

Original idea: [`manus-dashboard-public`](https://github.com/panditvirchandra77-lgtm/manus-dashboard-public).
WorkBuddy sandbox ke liye adapt kiya gaya, saath hi 403 ka asli root cause
(source-code level) aur fix.

---

MIT © panditvirchandra77-lgtm
