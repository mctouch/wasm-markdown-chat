# Production Deployment Plan: Kubernetes Option B
## www.socialartificial.com via ingress-nginx + cert-manager

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
       +---> K8s Node 192.168.185.22
                |
                +-- ingress-nginx Controller (NodePort 30081/30444)
                         |
                         +-- /       -> socialartificial-frontend:80
                         +-- /api/tts -> socialartificial-tts:8200
                         +-- /api/a2f -> socialartificial-a2f:8100
                         |
                +-- cert-manager (ClusterIssuer: letsencrypt-prod)
                |
                +-- socialartificial-frontend Pod (nginx static)
                +-- socialartificial-tts Pod (Piper Flask)
                +-- socialartificial-a2f Pod (A2F Proxy Flask)
```

---

## Phase 1: DNS Setup
**Agent:** `dns-setup-agent`
**Parallelizable:** Yes

### 1.1 DNS A Record
- Log into domain registrar for `socialartificial.com`
- Create A record: `www.socialartificial.com` -> `45.115.232.159`
- TTL: 300 (5 minutes)
- Verify: `dig www.socialartificial.com +short` returns `45.115.232.159`

### 1.2 Apex Redirect
- Create A record: `socialartificial.com` -> `45.115.232.159`
- Or registrar redirect to `https://www.socialartificial.com`

---

## Phase 2: UniFi UDM Pro Port Forwarding
**Agent:** `unifi-network-agent`
**Parallelizable:** Yes (with Phase 1)
**Prerequisites:** K8s node must have static IP: `192.168.185.22`

### 2.1 Assign Static IP to K8s Node
1. UniFi Network app -> Settings -> Networks -> LAN
2. Client Devices -> Find K8s node by MAC -> Config -> Network
3. Set **Fixed IP**: `192.168.185.22`

### 2.2 Port Forwarding Rules
**UniFi OS Path:** Settings -> Internet -> Port Forwarding -> Create New Rule

| Name | From | Port | Forward IP | Forward Port | Protocol |
|------|------|------|------------|--------------|----------|
| HTTP-to-K8s | Anywhere | 80 | 192.168.185.22 | 30081 | TCP |
| HTTPS-to-K8s | Anywhere | 443 | 192.168.185.22 | 30444 | TCP |

### 2.3 Firewall Rules (WAN IN)
**UniFi OS Path:** Settings -> Security -> Firewall Rules

```
Rule 1: Allow HTTP to K8s
- Type: WAN In
- Action: Accept
- Protocol: TCP
- Source: Any
- Destination: 192.168.185.22
- Destination Port: 30081

Rule 2: Allow HTTPS to K8s
- Type: WAN In
- Action: Accept
- Protocol: TCP
- Source: Any
- Destination: 192.168.185.22
- Destination Port: 30444

Rule 3: Deny all other WAN to LAN (after allow rules)
- Type: WAN In
- Action: Drop
- Source: Any
- Destination: LAN Network
```

### 2.4 Alternative: MetalLB LoadBalancer (Recommended)
Instead of NodePort, expose ingress-nginx via MetalLB for cleaner port mapping:

```bash
# On K8s cluster
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.5/config/manifests/metallb-native.yaml

# Create IPAddressPool for 192.168.185.100-192.168.185.110
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: socialartificial-pool
  namespace: metallb-system
spec:
  addresses:
  - 192.168.185.100-192.168.185.110
EOF

# L2Advertisement
cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: socialartificial-l2
  namespace: metallb-system
spec:
  ipAddressPools:
  - socialartificial-pool
EOF
```

Then change ingress-nginx service to LoadBalancer:
```bash
kubectl patch service ingress-nginx-controller -n ingress-nginx \
  -p '{"spec": {"type": "LoadBalancer"}}'
```

UniFi port forwards become:
| Name | Port | Forward IP | Forward Port |
|------|------|------------|--------------|
| HTTP | 80 | 192.168.185.100 | 80 |
| HTTPS | 443 | 192.168.185.100 | 443 |

---

## Phase 3: K8s Namespace & Ingress Setup
**Agent:** `k8s-ingress-agent`
**Target:** K8s cluster (192.168.185.22)

### 3.1 Create Namespace
```bash
kubectl create namespace socialartificial
```

### 3.2 cert-manager Installation
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml
kubectl wait --for=condition=Ready pods -l app=cert-manager -n cert-manager
```

### 3.3 ClusterIssuer (Let's Encrypt)
Create `cluster-issuer.yaml`:
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@socialartificial.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
```

```bash
kubectl apply -f cluster-issuer.yaml
```

### 3.4 Ingress Resource
Create `ingress.yaml`:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: socialartificial
  namespace: socialartificial
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - www.socialartificial.com
    secretName: socialartificial-tls
  rules:
  - host: www.socialartificial.com
    http:
      paths:
      - path: /api/tts
        pathType: Prefix
        backend:
          service:
            name: socialartificial-tts
            port:
              number: 8200
      - path: /api/a2f
        pathType: Prefix
        backend:
          service:
            name: socialartificial-a2f
            port:
              number: 8100
      - path: /
        pathType: Prefix
        backend:
          service:
            name: socialartificial-frontend
            port:
              number: 80
```

```bash
kubectl apply -f ingress.yaml
```

---

## Phase 4: Frontend Deployment (Static WASM)
**Agent:** `frontend-deploy-agent`
**Target:** K8s cluster

### 4.1 Build Docker Image
Create `frontend/Dockerfile`:
```dockerfile
FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

Create `frontend/nginx.conf`:
```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|wasm|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
```

### 4.2 Build & Push
```bash
# Build WASM first
wasm-pack build --target web --release

# Build Docker image
docker build -t socialartificial/frontend:v1.0 -f frontend/Dockerfile .

# Push to registry (or load directly on K8s node)
docker save socialartificial/frontend:v1.0 | ssh root@192.168.185.22 "docker load"
```

### 4.3 K8s Deployment
Create `frontend-deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: socialartificial-frontend
  namespace: socialartificial
spec:
  replicas: 2
  selector:
    matchLabels:
      app: socialartificial-frontend
  template:
    metadata:
      labels:
        app: socialartificial-frontend
    spec:
      containers:
      - name: frontend
        image: socialartificial/frontend:v1.0
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
---
apiVersion: v1
kind: Service
metadata:
  name: socialartificial-frontend
  namespace: socialartificial
spec:
  selector:
    app: socialartificial-frontend
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP
```

```bash
kubectl apply -f frontend-deployment.yaml
```

---

## Phase 5: Piper TTS Backend Deployment
**Agent:** `tts-deploy-agent`
**Target:** K8s cluster

### 5.1 Build TTS Docker Image
Create `tts/Dockerfile`:
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    libespeak-ng1 \
    espeak-ng-data \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY piper_tts_server.py .
COPY piper-voices/ ./piper-voices/

RUN pip install flask piper-tts

EXPOSE 8200
CMD ["python3", "piper_tts_server.py"]
```

### 5.2 Build & Deploy
```bash
docker build -t socialartificial/tts:v1.0 -f tts/Dockerfile .
docker save socialartificial/tts:v1.0 | ssh root@192.168.185.22 "docker load"
```

Create `tts-deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: socialartificial-tts
  namespace: socialartificial
spec:
  replicas: 1
  selector:
    matchLabels:
      app: socialartificial-tts
  template:
    metadata:
      labels:
        app: socialartificial-tts
    spec:
      containers:
      - name: tts
        image: socialartificial/tts:v1.0
        ports:
        - containerPort: 8200
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
---
apiVersion: v1
kind: Service
metadata:
  name: socialartificial-tts
  namespace: socialartificial
spec:
  selector:
    app: socialartificial-tts
  ports:
  - port: 8200
    targetPort: 8200
  type: ClusterIP
```

```bash
kubectl apply -f tts-deployment.yaml
```

---

## Phase 6: A2F Proxy Deployment
**Agent:** `a2f-deploy-agent`
**Target:** K8s cluster

### 6.1 Build A2F Docker Image
Create `a2f/Dockerfile`:
```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY a2f_proxy.py .
COPY requirements.txt .
RUN pip install -r requirements.txt

ENV A2F_HOST=172.16.230.214
ENV A2F_PORT=52000

EXPOSE 8100
CMD ["python3", "a2f_proxy.py"]
```

### 6.2 Build & Deploy
```bash
docker build -t socialartificial/a2f:v1.0 -f a2f/Dockerfile .
docker save socialartificial/a2f:v1.0 | ssh root@192.168.185.22 "docker load"
```

Create `a2f-deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: socialartificial-a2f
  namespace: socialartificial
spec:
  replicas: 1
  selector:
    matchLabels:
      app: socialartificial-a2f
  template:
    metadata:
      labels:
        app: socialartificial-a2f
    spec:
      containers:
      - name: a2f
        image: socialartificial/a2f:v1.0
        ports:
        - containerPort: 8100
        env:
        - name: A2F_HOST
          value: "172.16.230.214"
        - name: A2F_PORT
          value: "52000"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: socialartificial-a2f
  namespace: socialartificial
spec:
  selector:
    app: socialartificial-a2f
  ports:
  - port: 8100
    targetPort: 8100
  type: ClusterIP
```

```bash
kubectl apply -f a2f-deployment.yaml
```

---

## Phase 7: Frontend API URL Updates
**Agent:** `frontend-config-agent`
**Target:** Source code (before Docker build)

### 7.1 Change API URLs to Relative Paths
Edit `index.html` JavaScript:
```javascript
// Before:
const proxyBase = window.location.protocol + '//' + window.location.hostname + ':8100';
fetch('http://localhost:8200/v1/tts/synthesize', ...)

// After:
const proxyBase = '/api/a2f';
fetch('/api/tts/v1/tts/synthesize', ...)
```

This ensures all API calls go through ingress-nginx with SSL termination.

---

## Phase 8: Helm Chart (Optional but Recommended)
**Agent:** `helm-chart-agent`
**Target:** Source repo

### 8.1 Create Helm Chart Structure
```
helm/socialartificial/
  Chart.yaml
  values.yaml
  templates/
    namespace.yaml
    ingress.yaml
    frontend-deployment.yaml
    frontend-service.yaml
    tts-deployment.yaml
    tts-service.yaml
    a2f-deployment.yaml
    a2f-service.yaml
```

### 8.2 values.yaml
```yaml
replicaCount:
  frontend: 2
  tts: 1
  a2f: 1

image:
  frontend: socialartificial/frontend
  tts: socialartificial/tts
  a2f: socialartificial/a2f
  tag: v1.0
  pullPolicy: IfNotPresent

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: www.socialartificial.com
      paths:
        - path: /
          service: frontend
          port: 80
        - path: /api/tts
          service: tts
          port: 8200
        - path: /api/a2f
          service: a2f
          port: 8100
  tls:
    - secretName: socialartificial-tls
      hosts:
        - www.socialartificial.com

resources:
  frontend:
    requests: { memory: "64Mi", cpu: "100m" }
    limits: { memory: "128Mi", cpu: "200m" }
  tts:
    requests: { memory: "512Mi", cpu: "500m" }
    limits: { memory: "2Gi", cpu: "2000m" }
  a2f:
    requests: { memory: "128Mi", cpu: "100m" }
    limits: { memory: "512Mi", cpu: "500m" }
```

### 8.3 Deploy with Helm
```bash
helm upgrade --install socialartificial ./helm/socialartificial \
  --namespace socialartificial \
  --create-namespace \
  --wait
```

---

## Phase 9: Monitoring & Logging
**Agent:** `monitoring-agent`
**Target:** K8s cluster

### 9.1 Pod Health Checks
Add liveness/readiness probes to all deployments:
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 80
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /health
    port: 80
  initialDelaySeconds: 5
  periodSeconds: 10
```

### 9.2 Prometheus Metrics (optional)
Add nginx-prometheus-exporter to ingress-nginx:
```bash
kubectl apply -f https://raw.githubusercontent.com/nginxinc/nginx-prometheus-exporter/main/deploy/service-monitor.yaml
```

### 9.3 Log Aggregation
```bash
# View logs
kubectl logs -n socialartificial -l app=socialartificial-tts --tail=100 -f
kubectl logs -n socialartificial -l app=socialartificial-a2f --tail=100 -f
kubectl logs -n socialartificial -l app=socialartificial-frontend --tail=100 -f
```

---

## Phase 10: Security Hardening
**Agent:** `security-agent`
**Target:** K8s cluster + UDM Pro

### 10.1 NetworkPolicy
Create `network-policy.yaml`:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: socialartificial-policy
  namespace: socialartificial
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 80
    - protocol: TCP
      port: 8200
    - protocol: TCP
      port: 8100
```

### 10.2 Rate Limiting (ingress-nginx)
Add annotations to Ingress:
```yaml
nginx.ingress.kubernetes.io/limit-rps: "10"
nginx.ingress.kubernetes.io/limit-connections: "5"
nginx.ingress.kubernetes.io/limit-rpm: "100"
```

### 10.3 Pod Security
Add SecurityContext:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
```

---

## Phase 11: Rollback Plan
**Agent:** `rollback-agent` (on standby)

### 11.1 Helm Rollback
```bash
# View revision history
helm history socialartificial -n socialartificial

# Rollback to previous version
helm rollback socialartificial 1 -n socialartificial
```

### 11.2 Manual Rollback
```bash
# Scale down new version
kubectl scale deployment socialartificial-frontend --replicas=0 -n socialartificial

# Rollback image
kubectl set image deployment/socialartificial-frontend \
  frontend=socialartificial/frontend:v0.9 -n socialartificial

# Scale up
kubectl scale deployment socialartificial-frontend --replicas=2 -n socialartificial
```

### 11.3 Emergency: Remove Ingress
```bash
kubectl delete ingress socialartificial -n socialartificial
# Site goes offline immediately (last resort)
```

---

## Multi-Agent Swarm Assignments

| Agent | Phase | Task | Parallel? | Depends On |
|-------|-------|------|-----------|------------|
| `dns-setup-agent` | 1 | DNS A record + apex redirect | ✓ | - |
| `unifi-network-agent` | 2 | UniFi port forwards + firewall + MetalLB | ✓ | K8s node static IP |
| `k8s-ingress-agent` | 3 | Namespace, cert-manager, ClusterIssuer, Ingress | ✓ | 1, 2 |
| `frontend-deploy-agent` | 4 | Build WASM, Docker image, frontend deployment | ✓ | 3 |
| `tts-deploy-agent` | 5 | Piper TTS Docker image + deployment | ✓ | 3 |
| `a2f-deploy-agent` | 6 | A2F proxy Docker image + deployment | ✓ | 3 |
| `frontend-config-agent` | 7 | Update API URLs to relative paths | ✓ | 4, 5, 6 |
| `helm-chart-agent` | 8 | Create Helm chart (optional) | ✓ | 4, 5, 6 |
| `monitoring-agent` | 9 | Probes, metrics, logging | ✓ | 4, 5, 6 |
| `security-agent` | 10 | NetworkPolicy, rate limits, security contexts | ✓ | 4, 5, 6 |
| `rollback-agent` | 11 | Rollback runbook (standby) | - | - |

**Critical Path:** Phase 1 → Phase 2 → Phase 3 → Phase 4+5+6 (parallel) → Phase 7

---

## Pre-Deployment Checklist

- [ ] DNS A record propagated (`dig www.socialartificial.com`)
- [ ] UniFi port forwards active (test `curl http://45.115.232.159:80`)
- [ ] K8s node accessible at `192.168.185.22`
- [ ] ingress-nginx running (`kubectl get pods -n ingress-nginx`)
- [ ] cert-manager running (`kubectl get pods -n cert-manager`)
- [ ] ClusterIssuer created (`kubectl get clusterissuer`)
- [ ] Docker images built and loaded on K8s node
- [ ] Frontend API URLs use relative paths (`/api/tts`, `/api/a2f`)
- [ ] Piper voices included in TTS Docker image
- [ ] A2F proxy can reach `172.16.230.214:52000` from K8s pod
- [ ] Ingress TLS secret created by cert-manager
- [ ] All pods in `socialartificial` namespace Running

---

## Post-Deployment Verification Commands

```bash
# Check all pods
kubectl get pods -n socialartificial

# Check ingress
kubectl get ingress -n socialartificial
kubectl describe ingress socialartificial -n socialartificial

# Check TLS certificate
kubectl get certificate -n socialartificial
kubectl describe certificate socialartificial-tls -n socialartificial

# Test endpoints from inside cluster
kubectl run debug --rm -it --image=curlimages/curl -- \
  http://socialartificial-frontend.socialartificial.svc.cluster.local/

# Test from external
curl -I https://www.socialartificial.com
curl -I https://www.socialartificial.com/api/tts/v1/tts/voices
curl -I https://www.socialartificial.com/api/a2f/health

# SSL certificate check
echo | openssl s_client -connect www.socialartificial.com:443 -servername www.socialartificial.com 2>/dev/null | openssl x509 -noout -dates -subject

# DNS check
nslookup www.socialartificial.com
```

---

## Key Differences from Option A (Single VM)

| Aspect | Option A (VM) | Option B (K8s) |
|--------|---------------|----------------|
| Reverse Proxy | nginx on VM | ingress-nginx on K8s |
| SSL | certbot + nginx | cert-manager + ingress |
| Services | systemd units | K8s Deployments + Services |
| Scaling | Manual | `kubectl scale` or HPA |
| High Availability | Single point | Multiple replicas |
| Port Forwarding | 80/443 → VM IP:80/443 | 80/443 → K8s node:30081/30444 or MetalLB |
| Updates | Git pull + restart | Rolling update via `kubectl set image` |
| Rollback | Git checkout | `helm rollback` or `kubectl rollout undo` |
| Resource Isolation | None | Pod-level CPU/memory limits |
