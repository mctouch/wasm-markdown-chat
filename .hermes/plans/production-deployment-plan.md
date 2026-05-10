# Production Deployment Plan: www.socialartificial.com

## Target
Deploy the WASM WebGPU Markdown + AI Chat app with avatar to production under `https://www.socialartificial.com` with Let's Encrypt SSL, behind a UniFi UDM Pro.

## Network Topology
```
Internet
    |
    | 45.115.232.159 (WAN)
    v
+-------------+
|  UDM Pro    | 192.168.185.1 (LAN Gateway)
|  (UniFi OS) |
+------+------+
       |
       | 192.168.185.0/24
       |
       +---> App Server (192.168.185.50) [static DHCP]
                |
                +-- nginx (80/443) --+---> static WASM files
                                     +---> /api/tts  -> piper_tts_server.py:8200
                                     +---> /api/a2f  -> a2f_proxy.py:8100
```

---

## Phase 1: DNS & Domain Setup
**Agent:** `dns-setup-agent`
**Parallelizable:** Yes (Phase 1-3 can run simultaneously)

### 1.1 DNS A Record
- Log into domain registrar for `socialartificial.com`
- Create A record: `www.socialartificial.com` -> `45.115.232.159`
- TTL: 300 (5 minutes) for fast propagation during testing
- Verify: `dig www.socialartificial.com +short` returns `45.115.232.159`

### 1.2 Apex Redirect (optional but recommended)
- Create A record: `socialartificial.com` -> `45.115.232.159`
- Or use registrar redirect: `socialartificial.com` -> `https://www.socialartificial.com`

---

## Phase 2: UniFi UDM Pro Network Configuration
**Agent:** `unifi-network-agent`
**Parallelizable:** Yes (with Phase 1, 3)
**Prerequisites:** App server must have static LAN IP assigned

### 2.1 Assign Static IP to App Server
1. Open UniFi Network app -> Settings -> Networks -> LAN
2. Go to **Client Devices**, find the app server (by MAC address)
3. Click -> **Config** -> **Network** -> Set **Fixed IP**: `192.168.185.50`
4. Note the server's MAC address for firewall rules

### 2.2 Port Forwarding (Port Forwarding tab)
| Name | From | Port | Forward IP | Forward Port | Protocol |
|------|------|------|------------|--------------|----------|
| HTTP | Anywhere | 80 | 192.168.185.50 | 80 | TCP |
| HTTPS | Anywhere | 443 | 192.168.185.50 | 443 | TCP |
| TTS-direct (optional) | Anywhere | 8200 | 192.168.185.50 | 8200 | TCP |
| A2F-direct (optional) | Anywhere | 8100 | 192.168.185.50 | 8100 | TCP |

**UniFi OS Path:** Settings -> Internet -> Port Forwarding -> Create New Rule
- **Type:** Port forwarding
- **From:** Internet (Anywhere)
- **Port:** 80
- **Forward IP:** 192.168.185.50
- **Forward Port:** 80
- **Protocol:** TCP
- **Enable logging:** Yes (for debugging)

Repeat for 443. The direct ports (8100, 8200) are optional if using nginx subpaths.

### 2.3 Firewall Rules (Firewall & Security tab)
**UniFi OS Path:** Settings -> Security -> Firewall Rules -> Create New Rule

**WAN IN Rules (allow external traffic):**
```
Rule 1: Allow HTTP
- Type: WAN In
- Action: Accept
- IPv4 Protocol: TCP
- Source: Any
- Destination: Address/IP Group -> 192.168.185.50
- Destination Port: 80

Rule 2: Allow HTTPS
- Type: WAN In
- Action: Accept
- IPv4 Protocol: TCP
- Source: Any
- Destination: Address/IP Group -> 192.168.185.50
- Destination Port: 443

Rule 3: Allow TTS (if direct port)
- Type: WAN In
- Action: Accept
- IPv4 Protocol: TCP
- Source: Any
- Destination: 192.168.185.50
- Destination Port: 8200

Rule 4: Allow A2F (if direct port)
- Type: WAN In
- Action: Accept
- IPv4 Protocol: TCP
- Source: Any
- Destination: 192.168.185.50
- Destination Port: 8100
```

**WAN IN Deny Rule (security hardening):**
```
Rule 5: Deny all other WAN to LAN
- Type: WAN In
- Action: Drop
- Source: Any
- Destination: LAN Network
- Place this AFTER the allow rules (order matters)
```

### 2.4 Enable UPnP (optional, for certbot validation)
UniFi OS Path: Settings -> Networks -> [LAN] -> Advanced -> Enable UPnP

### 2.5 Verify External Access
From outside the network:
```bash
curl -I http://www.socialartificial.com
# Should return 200 or redirect
```

---

## Phase 3: Server Preparation
**Agent:** `server-prep-agent`
**Parallelizable:** Yes (with Phase 1, 2)
**Target:** App server at 192.168.185.50 (or current VM migrated to LAN)

### 3.1 OS Packages
```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx ufw git
```

### 3.2 Firewall (ufw on server)
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8100/tcp   # A2F proxy (if direct)
sudo ufw allow 8200/tcp   # TTS server (if direct)
sudo ufw enable
```

### 3.3 Clone/Deploy Code
```bash
cd /opt
sudo git clone https://github.com/mctouch/wasm-markdown-chat.git socialartificial
# OR rsync from development VM
cd socialartificial
git checkout locale  # or master
git pull
```

### 3.4 Build WASM (if needed)
```bash
cd /opt/socialartificial
wasm-pack build --target web --release
```

### 3.5 Copy Piper Voices
```bash
sudo mkdir -p /opt/socialartificial/piper-voices
sudo cp ~/piper-voices/*.onnx /opt/socialartificial/piper-voices/
sudo cp ~/piper-voices/*.json /opt/socialartificial/piper-voices/
```

---

## Phase 4: Nginx Reverse Proxy + SSL
**Agent:** `nginx-ssl-agent`
**Parallelizable:** No (depends on Phase 1-3)
**Target:** App server

### 4.1 Nginx Site Config
Create `/etc/nginx/sites-available/socialartificial`:

```nginx
# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name www.socialartificial.com socialartificial.com;
    return 301 https://www.socialartificial.com$request_uri;
}

# HTTPS main server
server {
    listen 443 ssl http2;
    server_name www.socialartificial.com;

    # SSL certificates (certbot will populate these)
    ssl_certificate /etc/letsencrypt/live/www.socialartificial.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/www.socialartificial.com/privkey.pem;

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Static WASM app
    location / {
        root /opt/socialartificial;
        index index.html;
        try_files $uri $uri/ =404;

        # Cache static assets
        location ~* \.(js|wasm|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
        }

        # Never cache index.html (for updates)
        location = /index.html {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }
    }

    # Piper TTS API proxy
    location /api/tts/ {
        proxy_pass http://localhost:8200/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # TTS responses can be large (audio files)
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 10M;
    }

    # A2F proxy API
    location /api/a2f/ {
        proxy_pass http://localhost:8100/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming response support (NDJSON)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
```

### 4.2 Enable Site
```bash
sudo ln -sf /etc/nginx/sites-available/socialartificial /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
```

### 4.3 Certbot Let's Encrypt
```bash
# Obtain certificate
sudo certbot --nginx -d www.socialartificial.com --non-interactive --agree-tos --email admin@socialartificial.com

# Verify auto-renewal
sudo certbot renew --dry-run

# Auto-renewal is installed as a systemd timer by default
certbot --version
```

### 4.4 Verify SSL
```bash
curl -I https://www.socialartificial.com
# Should show HTTP/2 200 and valid SSL
```

---

## Phase 5: Backend Services Deployment
**Agent:** `backend-deploy-agent`
**Parallelizable:** No (depends on Phase 3-4)
**Target:** App server

### 5.1 Systemd Service: Piper TTS Server
Create `/etc/systemd/system/piper-tts.service`:
```ini
[Unit]
Description=Piper TTS Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/socialartificial
Environment=PYTHONUNBUFFERED=1
Environment=HOME=/var/www
ExecStart=/usr/bin/python3 /opt/socialartificial/piper_tts_server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable piper-tts
sudo systemctl start piper-tts
sudo systemctl status piper-tts
```

### 5.2 Systemd Service: A2F Proxy
Create `/etc/systemd/system/a2f-proxy.service`:
```ini
[Unit]
Description=A2F-3D HTTP Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/socialartificial
Environment=A2F_HOST=172.16.230.214
Environment=A2F_PORT=52000
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/socialartificial/a2f_proxy.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable a2f-proxy
sudo systemctl start a2f-proxy
sudo systemctl status a2f-proxy
```

### 5.3 Update Frontend API URLs
Edit `index.html` to use relative paths (so they work through nginx):
```javascript
// Change from:
const proxyBase = window.location.protocol + '//' + window.location.hostname + ':8100';
fetch('http://localhost:8200/v1/tts/synthesize', ...)

// To:
const proxyBase = '/api/a2f';
fetch('/api/tts/v1/tts/synthesize', ...)
```

### 5.4 Verify Services
```bash
curl http://localhost:8200/v1/tts/voices
curl http://localhost:8100/health
curl https://www.socialartificial.com/api/tts/v1/tts/voices
curl https://www.socialartificial.com/api/a2f/health
```

---

## Phase 6: Health Monitoring & Logging
**Agent:** `monitoring-agent`
**Parallelizable:** Yes (can start after Phase 5)

### 6.1 Service Health Check Script
Create `/opt/socialartificial/health_check.sh`:
```bash
#!/bin/bash
# Health check for all services

check_http() {
    local url=$1
    local name=$2
    if curl -sf "$url" > /dev/null 2>&1; then
        echo "[OK] $name"
    else
        echo "[FAIL] $name"
        # Optional: send alert (email, webhook, etc.)
    fi
}

check_http "https://www.socialartificial.com/health" "Main Site"
check_http "https://www.socialartificial.com/api/tts/v1/tts/voices" "TTS Server"
check_http "https://www.socialartificial.com/api/a2f/health" "A2F Proxy"
```

### 6.2 Cron Job for Health Checks
```bash
chmod +x /opt/socialartificial/health_check.sh
sudo crontab -e
# Add:
*/5 * * * * /opt/socialartificial/health_check.sh >> /var/log/socialartificial-health.log 2>&1
```

### 6.3 Log Rotation
Create `/etc/logrotate.d/socialartificial`:
```
/var/log/socialartificial-health.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

---

## Phase 7: Security Hardening
**Agent:** `security-agent`
**Parallelizable:** Yes (after Phase 5)

### 7.1 Fail2Ban (rate limiting)
```bash
sudo apt install -y fail2ban
```

Create `/etc/fail2ban/jail.local`:
```ini
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
action = iptables-multiport[name=ReqLimit, port="http,https", protocol=tcp]
logpath = /var/log/nginx/error.log
```

```bash
sudo systemctl restart fail2ban
```

### 7.2 Nginx Rate Limiting
Add to nginx config (inside `server` block):
```nginx
# Rate limit API endpoints
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

location /api/ {
    limit_req zone=api burst=20 nodelay;
    # ... proxy_pass
}
```

### 7.3 Disable Server Tokens
```bash
sudo sed -i 's/# server_tokens off;/server_tokens off;/' /etc/nginx/nginx.conf
sudo systemctl reload nginx
```

---

## Phase 8: Rollback Plan
**Agent:** `rollback-agent` (on standby)

### 8.1 Quick Rollback Steps
```bash
# 1. Stop services
sudo systemctl stop nginx piper-tts a2f-proxy

# 2. Revert to previous git commit
cd /opt/socialartificial
git log --oneline -5  # find previous stable commit
git checkout <previous-commit>

# 3. Rebuild if needed
wasm-pack build --target web --release

# 4. Restart services
sudo systemctl start nginx piper-tts a2f-proxy

# 5. Verify
curl -I https://www.socialartificial.com
```

### 8.2 Database/State (if any)
- Current app is stateless (no DB)
- localStorage in browser holds API key only
- No server-side state to migrate

### 8.3 Blue-Green Deployment (future enhancement)
- Deploy to `/opt/socialartificial-green`
- Test independently
- Swap nginx root symlink
- Instant rollback: point symlink back

---

## Multi-Agent Swarm Task Assignments

| Agent | Phase | Files to Create/Edit | Estimated Time |
|-------|-------|---------------------|----------------|
| `dns-setup-agent` | Phase 1 | DNS records at registrar | 15 min |
| `unifi-network-agent` | Phase 2 | UniFi OS screenshots + config | 30 min |
| `server-prep-agent` | Phase 3 | Server packages, ufw, code deploy | 30 min |
| `nginx-ssl-agent` | Phase 4 | `/etc/nginx/sites-available/socialartificial`, certbot | 45 min |
| `backend-deploy-agent` | Phase 5 | systemd services, frontend URL updates | 45 min |
| `monitoring-agent` | Phase 6 | health_check.sh, cron, logrotate | 20 min |
| `security-agent` | Phase 7 | fail2ban, nginx rate limits | 20 min |
| `rollback-agent` | Phase 8 | Rollback runbook (standby) | 10 min |

**Critical Path:** Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5
**Parallelizable:** Phase 1, 2, 3 can run simultaneously. Phase 6, 7, 8 can start after Phase 5.

---

## Pre-Deployment Checklist

- [ ] Domain DNS propagated (`dig www.socialartificial.com`)
- [ ] UniFi port forwards active (test from external: `curl http://45.115.232.159`)
- [ ] Server static IP assigned (192.168.185.50)
- [ ] Code deployed to `/opt/socialartificial`
- [ ] Piper voices copied to `piper-voices/`
- [ ] Nginx config valid (`sudo nginx -t`)
- [ ] SSL certificate obtained (`certbot --nginx`)
- [ ] TTS server responding (`curl /api/tts/v1/tts/voices`)
- [ ] A2F proxy responding (`curl /api/a2f/health`)
- [ ] Frontend loads without console errors
- [ ] Avatar renders (WebGPU or WebGL2 fallback)
- [ ] Voice synthesis works end-to-end
- [ ] A2F Talk button captures mic and animates avatar

---

## Post-Deployment Verification Commands

```bash
# Full stack health check
curl -s https://www.socialartificial.com/health
curl -s https://www.socialartificial.com/api/tts/v1/tts/voices | head -c 200
curl -s https://www.socialartificial.com/api/a2f/health

# SSL certificate check
echo | openssl s_client -servername www.socialartificial.com -connect www.socialartificial.com:443 2>/dev/null | openssl x509 -noout -dates -subject

# DNS propagation check
nslookup www.socialartificial.com
dig www.socialartificial.com A +short

# UniFi port forward test (from outside network)
curl -I http://www.socialartificial.com
curl -I https://www.socialartificial.com
```
