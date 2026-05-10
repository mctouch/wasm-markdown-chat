FROM nginx:alpine

# Copy app static files explicitly
COPY index.html /usr/share/nginx/html/
COPY avatar-webgpu.js /usr/share/nginx/html/
COPY avatar-webgl2.js /usr/share/nginx/html/
COPY viseme.js /usr/share/nginx/html/
COPY viseme-sync.js /usr/share/nginx/html/
COPY piper-tts.js /usr/share/nginx/html/
COPY a2f-bridge.js /usr/share/nginx/html/
COPY avatar.glb /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY pkg/ /usr/share/nginx/html/pkg/
COPY fonts/ /usr/share/nginx/html/fonts/
COPY piper-voices/ /usr/share/nginx/html/piper-voices/
COPY node_modules/onnxruntime-web/dist/ /usr/share/nginx/html/node_modules/onnxruntime-web/dist/

# Custom nginx config
RUN rm -f /etc/nginx/conf.d/default.conf && cat > /etc/nginx/conf.d/default.conf << 'NGINX'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Add .mjs MIME type (JS modules)
    types {
        application/javascript js mjs;
        application/wasm wasm;
    }

    # Cache static assets for 30 days
    location ~* \.(wasm|js|mjs|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|glb)$ {
        try_files $uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Never cache index.html
    location = /index.html {
        try_files $uri =404;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

EXPOSE 80