# ExcaliDash PWA v0.6.11

Release date: 2026-07-11

## Key changes

- Took v0.5.1 of ExcaliDash https://github.com/ZimengXiong/ExcaliDash
- Added PWA support
- Added offline mode support for PWA
- Pulling notes to installed PWA to store them offline
- Added data synch going offline and back online
- Running app on excalidash.local:6767 DNS on local wifi network.
- Minor UI improvements and improvements of app stability
- Auto-lock feature for existing drawings to prevent accidental changes

### How to run (Docker Hub compose)

0. You need to have Docker Desktop to run this app on your machine. https://docs.docker.com/get-started/introduction/get-docker-desktop/
1. Download docker-compose.prod.ssl.yml in some folder on your computer.
2. Pull the images and run the app with the commands
```bash
docker compose -f docker-compose.prod.ssl.yml pull
docker compose -f docker-compose.prod.ssl.yml up -d
```
3. Add generated cert in working directory along with docker-compose.prod.ssl.yml - certs/excalidash-pwa.cer to your browser and/or mobile device such that it will not warn you with security issues


</details>
