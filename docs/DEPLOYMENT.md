# Deployment Guide

This guide covers production deployment of Skiff.

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Docker + Docker Compose installed
- Domain name (optional, but recommended for HTTPS)
- Reverse proxy (nginx or Caddy) for HTTPS

## Option 1: Docker Compose (Recommended)

### 1. Clone and Configure

```bash
# Clone the repository
git clone https://github.com/yourusername/skiff.git
cd skiff

# Create environment file
cp .env.example .env

# Generate secure cookie secret
openssl rand -hex 32

# Edit .env and set:
# SKIFF_COOKIE_SECRET=<the generated secret>
# NODE_ENV=production
```

### 2. Start the Container

```bash
docker compose up -d --build
```

### 3. Verify

```bash
# Check logs
docker compose logs -f

# Test API health
curl http://localhost:8080/api/health

# Should return: {"ok":true,"data":{"status":"ok",...}}
```

### 4. Set Up Reverse Proxy (HTTPS)

**Option A: Caddy (easiest)**

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# Create Caddyfile
sudo nano /etc/caddy/Caddyfile
```

Add:
```
skiff.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

**Option B: nginx**

```bash
# Install nginx
sudo apt install nginx

# Create site config
sudo nano /etc/nginx/sites-available/skiff
```

Add:
```nginx
server {
    listen 80;
    server_name skiff.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload:
```bash
sudo ln -s /etc/nginx/sites-available/skiff /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL cert with Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d skiff.yourdomain.com
```

### 5. Backups

**Automated backup script:**

```bash
#!/bin/bash
# /opt/skiff-backup.sh

BACKUP_DIR="/backups/skiff"
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="skiff_backup_${DATE}.tar.gz"

mkdir -p "$BACKUP_DIR"
cd /path/to/skiff
tar -czf "$BACKUP_DIR/$FILENAME" data/

# Keep only last 30 backups
ls -t "$BACKUP_DIR" | tail -n +31 | xargs -r rm
```

Add to crontab:
```bash
crontab -e

# Add this line (backup daily at 2 AM):
0 2 * * * /opt/skiff-backup.sh
```

## Option 2: Manual Build (No Docker)

### 1. Install Dependencies

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm
npm install -g pnpm@9

# Build tools (for better-sqlite3)
sudo apt install -y python3 make g++
```

### 2. Build Skiff

```bash
git clone https://github.com/yourusername/skiff.git
cd skiff

# Install deps
pnpm install

# Build for production
pnpm build
```

### 3. Set Up Environment

```bash
# Create data directory
mkdir -p /opt/skiff/data

# Create .env
cat > /opt/skiff/.env << 'ENVEOF'
NODE_ENV=production
SKIFF_PORT=8080
SKIFF_HOST=0.0.0.0
SKIFF_COOKIE_SECRET=<generate with: openssl rand -hex 32>
SKIFF_DB_PATH=/opt/skiff/data/skiff.sqlite
ENVEOF
```

### 4. Create systemd Service

```bash
sudo nano /etc/systemd/system/skiff.service
```

Add:
```ini
[Unit]
Description=Skiff SSH Manager
After=network.target

[Service]
Type=simple
User=skiff
WorkingDirectory=/opt/skiff
Environment="NODE_ENV=production"
EnvironmentFile=/opt/skiff/.env
ExecStart=/usr/bin/node /opt/skiff/apps/api/dist/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Create user and start:
```bash
sudo useradd -r -s /bin/false skiff
sudo chown -R skiff:skiff /opt/skiff
sudo systemctl daemon-reload
sudo systemctl enable skiff
sudo systemctl start skiff
```

## Security Hardening

### Firewall

```bash
# Allow only SSH and HTTPS
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# If running Docker, also:
sudo ufw allow from 172.16.0.0/12 to any port 8080
```

### Fail2ban (Optional)

```bash
sudo apt install fail2ban

# Create Skiff jail
sudo nano /etc/fail2ban/jail.local
```

Add:
```ini
[skiff]
enabled = true
port = 80,443
filter = skiff
logpath = /var/log/nginx/access.log
maxretry = 5
bantime = 3600
```

## Monitoring

### Logs

```bash
# Docker logs
docker compose logs -f

# systemd logs
sudo journalctl -u skiff -f

# nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Health Check

```bash
# API health endpoint
curl https://skiff.yourdomain.com/api/health

# Should return:
# {"ok":true,"data":{"status":"ok","version":"0.1.0",...}}
```

## Updating

### Docker

```bash
cd /path/to/skiff
git pull
docker compose down
docker compose up -d --build
```

### Manual

```bash
cd /path/to/skiff
git pull
pnpm install
pnpm build
sudo systemctl restart skiff
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs

# Verify .env file
cat .env

# Check if port is in use
sudo lsof -i :8080
```

### Database is locked

```bash
# Stop all instances
docker compose down
sudo systemctl stop skiff

# Check for lock files
ls -la data/

# Remove if present
rm data/skiff.sqlite-wal
rm data/skiff.sqlite-shm

# Restart
docker compose up -d
```

### Out of disk space

```bash
# Check disk usage
df -h

# Clean Docker images
docker system prune -a

# Check database size
du -sh data/skiff.sqlite
```
