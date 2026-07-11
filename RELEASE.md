# ExcaliDash PWA v0.6.0

Release date: 2026-07-11

## Key changes

- Took v0.5.1 of ExcaliDash https://github.com/ZimengXiong/ExcaliDash
- Added PWA support
- Added offline mode support for PWA
- Pulling notes to installed PWA to store them offline
- Added data synch going offline and back online
- Running app on excalidash.local:6767 DNS on local wifi network.
- Minor UI improvements and improvements of app stability

### How to run (Docker Hub compose)

1. Download docker-compose.prod.ssl.yml in some folder on your computer.
2. Go through notes in docs/CUSTOM-SSL.md to create a cert folder with your custom certificate next the the docker-compose.prod.ssl.yml file. You need to generate your own ssl certificates.
3. Pull the images and run the app:
```bash
docker compose -f docker-compose.prod.ssl.yml pull
docker compose -f docker-compose.prod.ssl.yml up -d
```
4. Add certs/excalidash-pwa.cer to your browser such that it will not warn you with security issues


</details>
