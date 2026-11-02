#!/bin/sh
# Upload the web app, resort packs and legal pages to the PisteMates server.
# Needs ~/.ssh/ekipa_server and docs/config.js (server settings, not in git).
set -e
cd "$(dirname "$0")/.."
[ -f docs/config.js ] || { echo "docs/config.js missing (copy docs/config.example.js)"; exit 1; }
rsync -az --delete -e "ssh -i $HOME/.ssh/ekipa_server" docs/ root@2.31.175.156:/var/www/pistemates/
ssh -i "$HOME/.ssh/ekipa_server" root@2.31.175.156 'chown -R caddy:caddy /var/www/pistemates'
echo "deployed to https://pistemates.com/"
