# PisteMates server

Hetzner Cloud CAX11 (Arm, Falkenstein), Ubuntu 26.04 LTS, `pistemates-1`, 2.31.175.156.
Admin access: `ssh -i ~/.ssh/ekipa_server root@2.31.175.156` (key only, passwords disabled).

- **Firewall (ufw):** SSH, 80, 443 only. fail2ban on. Unattended security upgrades, reboot at 04:00 if needed.
- **Mosquitto 2.0** (`mosquitto-pistemates.conf`, `mosquitto-acl`): listens on localhost only – websockets 9001, plain 1883.
  No anonymous access; one app account `pistemates-app` limited to `ekipa-narty/v1/#`. Retained messages persist on disk.
  The password lives in `/etc/mosquitto/passwd` (hashed) and locally in `~/.ssh/pistemates_mqtt_password` and `docs/config.js` (not in git).
- **Caddy** (`Caddyfile`): serves `/var/www/pistemates` (= `docs/`) on pistemates.com / www / mqtt with automatic Let's Encrypt
  certificates, and proxies `wss://…/mqtt` to Mosquitto.
- **Deploy:** `tools/deploy.sh` (rsync of `docs/`).

Change the app password: `mosquitto_passwd -b /etc/mosquitto/passwd pistemates-app <new>` + `systemctl restart mosquitto`,
then update `docs/config.js`, deploy, and ship a new app build.
