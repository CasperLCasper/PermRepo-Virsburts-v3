# PermRepo-Virsburts-v3

PermRepo ir GitHub repozitoriju backup sistēma ar client-side šifrēšanu un permanentu Arweave/Turbo glabāšanu.

## Arhitektūra

```text
GitHub OAuth
    │
    ▼
PermRepo serveris ──────► GitHub API
    │
    └────► Redis (session + backup job state)

Browser wallet
    │
    ├────► Turbo browser upload
    │
    └────► PermRepo NFT / Subscription

Master Key
    │
    └────► paliek tikai lietotāja pusē
```

Serverim nav privātās blockchain/Turbo atslēgas un tas neveic lietotāja Turbo maksājumus.

## Backup plūsma

1. Lietotājs autorizējas GitHub.
2. Lietotājs pievieno wallet.
3. Serveris pārbauda aktīvu subscription.
4. Serveris pārbauda, ka repo ir autorizētā GitHub lietotāja repo.
5. Serveris pārbauda, ka wallet ir attiecīgā repo NFT īpašnieks.
6. Serveris nolasa GitHub Git Tree un failu saturu.
7. Browser salīdzina failu SHA-256 ar iepriekšējo manifestu.
8. Mainītie faili tiek ievietoti ZIP arhīvā browserī.
9. ZIP tiek šifrēts ar AES-GCM un nejaušu 12 baitu IV.
10. Šifrētais ZIP tiek augšupielādēts Turbo ar lietotāja wallet.
11. Manifests tiek augšupielādēts Turbo ar lietotāja wallet.
12. Lietotājs paraksta EIP-712 `AddBackup` autorizāciju.
13. NFT `addBackup()` ieraksta manifesta URI un commitment blockchainā.

## Master Key

- Pirmajam backupam 32 baitu atslēga tiek ģenerēta browserī.
- Master Key netiek sūtīta serverim.
- Lietotājam tā obligāti jāuzglabā drošā vietā, piemēram, password managerī.
- Viena browser sesija saglabā ģenerēto pirmā backupa atslēgu atmiņā, lai pēc upload kļūmes retry neģenerētu citu atslēgu.
- Atslēga netiek automātiski saglabāta serverī vai Redis.

## Redis

Redis tiek izmantots:

- Express session glabāšanai;
- backup job state glabāšanai;
- distributed job lock izmantošanai.

Redis nav source of truth backup datiem. Permanentie backup dati un NFT history atrodas Turbo/Arweave un blockchainā.

## Environment variables

Obligātie:

```text
CHAIN_ID
RPC_URL
SESSION_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_REDIRECT_URI
NFT_ADDRESS
SUBSCRIPTION_ADDRESS
USDC_ADDRESS
ARWEAVE_GATEWAY
TURBO_UPLOAD_URL
TURBO_PAYMENT_URL
```

Ieteicamie limiti:

```text
MAX_REPO_FILES=5000
MAX_REPO_BYTES=524288000
MAX_FILE_BYTES=104857600
JOB_TTL_SECONDS=3600
SESSION_TTL_SECONDS=3600
```

## Deployment

```bash
npm ci
npm run build
npm start
```

Šī versija neizmanto GitHub Actions backup automatizācijai.

## Svarīga piezīme par smart contracts

Šajā v3 auditā Solidity faili nav mainīti.

Tādēļ smart-contract līmeņa jautājumi, kas prasa paša līguma maiņu, piemēram:

- permissionless `mintRepository()` aizsardzība;
- ERC-721 pārvedumu bloķēšana;
- īpašs NFT migration-only ownership modelis;

šajā versijā nav atrisināti un apzināti paliek ārpus šī koda labojuma.
