'use strict';
/* Copy to config.js (not in git) and fill in. The app falls back to the public test brokers without it. */
const SERVER = {
  web: 'https://pistemates.com/',
  brokers: [
    { url: 'wss://mqtt.pistemates.com/mqtt', username: 'pistemates-app', password: '…' },
  ],
};
