# PermRepo

> Permanent GitHub repository backups on Arweave + Base blockchain

---

## 🌍 Valodas / Languages / Lingvoj

- [🇱🇻 Latviešu](#-latviešu)
- [🇬🇧 English](#-english)
- [🌐 Esperanto](#-esperanto)

---

# 🇱🇻 Latviešu

## Kas ir PermRepo?

**PermRepo** ir platforma, kas veido **permanentus GitHub repozitoriju backupus** uz **Arweave** un reģistrē tos **Base** blokķēdē.

Katrs repozitorijs iegūst **On-chain Deskriptoru** — unikālu ierakstu Base blokķēdē, kas:
- Saista tavu maku ar GitHub repozitoriju
- Glabā backup metadatus (backupu skaits, pēdējais manifests, Merkle sakne)
- Nodrošina permanentus, pārbaudāmus backupus
- Ir **nepārdodams** (var tikai migrēt, nevis pārdot)

## Kāpēc PermRepo?

GitHub ir lielisks, bet tas **nav permanents**:

- ❌ GitHub var nomirt
- ❌ GitHub var dzēst tavu repo
- ❌ GitHub var mainīt noteikumus
- ❌ Tu **nepiederi** savu repo

**PermRepo nodrošina:**

- ✅ Permanentus backupus uz Arweave
- ✅ On-chain Deskriptorus uz Base
- ✅ Pārbaudāmus backupus (Merkle sakne)
- ✅ Decentralizētu glabāšanu
- ✅ Tu kontrolē savus datus

## Kā tas strādā?

### Lietotāja plūsma

1. Savieno GitHub (OAuth)
2. Savieno maku (MetaMask uz Base)
3. Iegādājies abonementu (2.5 USDC / mēnesī)
4. Izvēlies repozitoriju
5. Izveido On-chain Deskriptoru
6. Izveido backupu (ZIP + šifrē + augšupielādē uz Arweave)
7. Pārbaudi (Merkle sakne uz Base)

### Backup plūsma

GitHub Repo
↓
Lejupielādē ZIP (GitHub API)
↓
Šifrē (AES-GCM ar Master Key)
↓
Augšupielādē uz Arweave (Turbo SDK)
↓
Izveido manifestu (JSON)
↓
Augšupielādē manifestu uz Arweave
↓
Reģistrē uz Base (addBackup)
↓
✅ Permanentais Backups


## Tehnoloģijas

### Frontend

- React 18
- Vite
- ethers.js v6
- Turbo SDK
- JSZip
- Web Crypto API (AES-GCM)

### Backend

- Node.js 20+
- Express
- Redis (Upstash)
- ethers.js v6
- yauzl

### Blokķēde

- Base (L2)
- Solidity 0.8.35
- OpenZeppelin 5.x
- EIP-712

### Glabāšana

- Arweave (permanent)
- Turbo (augšupielādes serviss)

## Kā sākt?

### Priekšnosacījumi

- Node.js 20+
- Git
- MetaMask
- GitHub konts
- Upstash konts

### Uzstādīšana

```bash
# Klonē repozitoriju
git clone https://github.com/CasperLCasper/PermRepo-Virsburts-v3.git
cd PermRepo-Virsburts-v3

# Instalē dependencies
npm install

# Kopē vides paraugu
cp .env.example .env

# Rediģē .env ar savām vērtībām
nano .env

# Būvē frontend
npm run build

# Palaid serveri
node server.js

Vides mainīgie

Skatīt .env.example pilnu sarakstu.
Obligātie mainīgie

Mainīgais			Apraksts
GITHUB_CLIENT_ID			GitHub OAuth Client ID
GITHUB_CLIENT_SECRET			GitHub OAuth Client Secret
GITHUB_REDIRECT_URI			GitHub OAuth callback URL
SESSION_SECRET				Sesijas noslēpums (32+ rakstzīmes)
UPSTASH_REDIS_REST_URL			Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN		Upstash Redis Token
CHAIN_ID				Base ķēdes ID
RPC_URL					Base RPC URL
NFT_ADDRESS				PermRepoNFT kontrakta adrese
SUBSCRIPTION_ADDRESS			Subscription kontrakta adrese
USDC_ADDRESS				USDC kontrakta adrese
MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY	Backend maka privātā atslēga
ARWEAVE_GATEWAY				Arweave gateway URL
TURBO_UPLOAD_URL			Turbo upload URL
TURBO_PAYMENT_URL			Turbo payment URL

Viedie kontrakti
PermRepoNFT

ERC-721 NFT (nepārdodams) ar EIP-712 mint autorizāciju, EIP-712 backup autorizāciju un On-chain Deskriptoru katram repozitorijam.

Galvenās funkcijas:

function mintRepository(address recipient, string repository, uint256 deadline, bytes signature) external returns (uint256);
function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string manifestURI, uint256 deadline, bytes signature) external;
function migrateNFT(uint256 tokenId, address newOwner) external;

PermRepoSubscription

USDC abonements (2.5 USDC / mēnesī), balstīts uz GitHub (nevis maku).

Galvenās funkcijas:

function subscribe(bytes32 githubHash) external;
function isSubscribed(bytes32 githubHash) external view returns (bool);

API endpointi

GitHub OAuth

Metode	Endpoints			Apraksts
GET	/api/github/login		Sāk OAuth plūsmu
GET	/api/github/callback		OAuth callback
POST	/api/github/logout		Izrakstīties
GET	/api/github/user		Iegūst lietotāja info
GET	/api/github/repos		Saraksts ar lietotāja repo

Abonements

Metode	Endpoints			Apraksts
GET	/api/subscription/status	Iegūst abonementa statusu

Mint autorizācija

Metode	Endpoints			Apraksts
POST	/api/mint-authorization		Iegūst EIP-712 mint signature

Backups

Metode	Endpoints			Apraksts
POST	/api/prepare-backup		Sagatavo backupu (NDJSON straume)
GET	/api/job-status			Iegūst job statusu
POST	/api/start-zip-upload		Sāk ZIP augšupielādi
POST	/api/save-zip-tx		Saglabā ZIP transakciju
POST	/api/start-manifest-upload	Sāk manifesta augšupielādi
POST	/api/save-manifest-tx		Saglabā manifesta transakciju
POST	/api/start-blockchain-finalize	Sāk blockchain finalizāciju
POST	/api/save-backup-tx		Saglabā backup transakciju
POST	/api/complete-backup		Pabeidz backupu
POST	/api/fail-backup		Atzīmē backupu kā neizdevušos
POST	/api/retry-backup		Mēģina vēlreiz

Veselība

Metode	Endpoints			Apraksts
GET	/api/health			Veselības pārbaude
GET	/api/config			Iegūst konfigurāciju

Drošība

1. Nav privāto atslēgu serverī — tikai backend maks autorizāciju parakstīšanai
2. EIP-712 paraksti — tipizētu datu parakstīšana
3. Nonce aizsardzība — katram mint/backup ir unikāls nonce
4. Deadline ierobežojums — paraksti beidzas pēc 15 minūtēm
5. GitHub īpašumtiesību pārbaude — backend pārbauda repo īpašumtiesības
6. Šifrēti backupi — AES-GCM ar lietotāja Master Key
7. Tikai HTTPS — visi savienojumi šifrēti
8. CSP headers — Content Security Policy

Backend maks

Backend maks (MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY):

- Paraksta EIP-712 mint autorizācijas
- NEmaksā gas
- NEmintē NFT
- NEGlabā līdzekļus
- Tikai paraksta pēc GitHub īpašumtiesību pārbaudes

Master Key

Master Key:

- Ģenerēts pirmajā backupā
- Parādīts lietotājam vienreiz
- Nekad netiek sūtīts serverim
- Izmantots backupu šifrēšanai/dešifrēšanai
- Ja pazaudēts — backupus nevar atšifrēt

Licence

MIT License

Copyright (c) 2026 Virsburts PermRepo

🇬🇧 English
What is PermRepo?

PermRepo is a platform that creates permanent backups of GitHub repositories on Arweave and registers them on Base blockchain.

Each repository gets an On-chain Descriptor — a unique record on Base blockchain that:

    Links your wallet to a GitHub repository

    Stores backup metadata (backup count, last manifest, Merkle root)

    Enables permanent, verifiable backups

    Is non-transferable (can only be migrated, not sold)

Why PermRepo?

GitHub is great, but it's not permanent:

    ❌ GitHub can shut down

    ❌ GitHub can delete your repository

    ❌ GitHub can change terms of service

    ❌ You don't own your repository

PermRepo provides:

    ✅ Permanent backups on Arweave

    ✅ On-chain Descriptors on Base

    ✅ Verifiable backups (Merkle root)

    ✅ Decentralized storage

    ✅ You control your data

How It Works

User Flow

1. Connect GitHub (OAuth)
2. Connect Wallet (MetaMask on Base)
3. Buy Subscription (2.5 USDC / month)
4. Select Repository
5. Create On-chain Descriptor
6. Create Backup (ZIP + encrypt + upload to Arweave)
7. Verify (Merkle root on Base)
    
GitHub Repo
    ↓
Download ZIP (GitHub API)
    ↓
Encrypt (AES-GCM with Master Key)
    ↓
Upload to Arweave (Turbo SDK)
    ↓
Create Manifest (JSON)
    ↓
Upload Manifest to Arweave
    ↓
Register on Base (addBackup)
    ↓
✅ Permanent Backup

Tech Stack

Frontend

- React 18
- Vite
- ethers.js v6
- Turbo SDK
- JSZip
- Web Crypto API (AES-GCM

Backend

- Node.js 20+
- Express
- Redis (Upstash)
- ethers.js v6
- yauzl

Blockchain

- Base (L2)
- Solidity 0.8.35
- OpenZeppelin 5.x
- EIP-712

Storage

- Arweave (permanent)
- Turbo (upload service)

Getting Started

Prerequisites

- Node.js 20+
- Git
- MetaMask
- GitHub account
- Upstash account

Installation

# Clone repository
git clone https://github.com/CasperLCasper/PermRepo-Virsburts-v3.git
cd PermRepo-Virsburts-v3

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env

# Build frontend
npm run build

# Start server
node server.js

Environment Variables

See .env.example for full list.

Required Variables

Variable				Description
GITHUB_CLIENT_ID			GitHub OAuth Client ID
GITHUB_CLIENT_SECRET			GitHub OAuth Client Secret
GITHUB_REDIRECT_URI			GitHub OAuth callback URL
SESSION_SECRET				Session secret (32+ chars)
UPSTASH_REDIS_REST_URL	Upstash 	Redis URL
UPSTASH_REDIS_REST_TOKEN		Upstash Redis Token
CHAIN_ID				Base chain ID
RPC_URL					Base RPC URL
NFT_ADDRESS				PermRepoNFT contract address
SUBSCRIPTION_ADDRESS			Subscription contract address
USDC_ADDRESS				USDC contract address
MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY	Backend wallet private key
ARWEAVE_GATEWAY				Arweave gateway URL
TURBO_UPLOAD_URL			Turbo upload URL
TURBO_PAYMENT_URL			Turbo payment URL

Smart Contracts

PermRepoNFT

ERC-721 NFT (non-transferable) with EIP-712 mint authorization, EIP-712 backup authorization, and On-chain Descriptor per repository.

Key Functions:

function mintRepository(address recipient, string repository, uint256 deadline, bytes signature) external returns (uint256);
function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string manifestURI, uint256 deadline, bytes signature) external;
function migrateNFT(uint256 tokenId, address newOwner) external;

PermRepoSubscription

USDC subscription (2.5 USDC / month), GitHub-based (not wallet-based).

Key Functions:

function subscribe(bytes32 githubHash) external;
function isSubscribed(bytes32 githubHash) external view returns (bool);

API Endpoints

GitHub OAuth

Method	Endpoint			Description
GET	/api/github/login		Start OAuth flow
GET	/api/github/callback		OAuth callback
POST	/api/github/logout		Logout
GET	/api/github/user		Get user info
GET	/api/github/repos		List user repos

Subscription

Method	Endpoint			Description
GET	/api/subscription/status	Get subscription status

Mint Authorization

Method	Endpoint			Description
POST	/api/mint-authorization		Get EIP-712 mint signature

Backups

Method	Endpoint			Description
POST	/api/prepare-backup		Prepare backup (NDJSON stream)
GET	/api/job-status			Get job status
POST	/api/start-zip-upload		Start ZIP upload
POST	/api/save-zip-tx		Save ZIP transaction
POST	/api/start-manifest-upload	Start manifest upload
POST	/api/save-manifest-tx		Save manifest transaction
POST	/api/start-blockchain-finalize	Start blockchain finalization
POST	/api/save-backup-tx		Save backup transaction
POST	/api/complete-backup		Complete backup
POST	/api/fail-backup		Mark backup as failed
POST	/api/retry-backup		Retry failed backup

Health

Method	Endpoint			Description
GET	/api/health			Health check
GET	/api/config			Get configuration

Security

1. No private keys on server — only backend wallet for signing authorizations
2. EIP-712 signatures — typed data signing
3. Nonce-based replay protection — each mint/backup has unique nonce
4. Deadline-based expiration — signatures expire after 15 minutes
5. GitHub ownership verification — backend verifies repo ownership
6. Encrypted backups — AES-GCM with user's Master Key
7. HTTPS only — all connections encrypted
8. CSP headers — Content Security Policy

Backend Wallet

The backend wallet (MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY):

- Signs EIP-712 mint authorizations
- Does NOT pay gas
- Does NOT mint NFTs
- Does NOT hold funds
- Only signs after verifying GitHub ownership

Master Key

The Master Key:

- Generated on first backup
- Shown to user once
- Never sent to server
- Used to encrypt/decrypt backups
- If lost — backups cannot be decrypted

License

MIT License

Copyright (c) 2026 Virsburts PermRepo
    
🌐 Esperanto
Kio estas PermRepo?

PermRepo estas platformo, kiu kreas permanentajn sekurkopiojn de GitHub-deponejoj sur Arweave kaj registras ilin sur Base blokĉeno.

Ĉiu deponejo ricevas On-chain Deskriptoron — unikan registron sur Base blokĉeno, kiu:

- Ligas vian monujon al GitHub-deponejo
- Konservas sekurkopiajn metadatumojn (nombro de sekurkopioj, lasta manifesto, Merkle-radiko)
- Ebligas permanentajn, konfirmeblajn sekurkopiojn
- Estas nealienigebla (povas nur migri, ne vendi)

Kial PermRepo?

GitHub estas bonega, sed ĝi ne estas permanenta:

    ❌ GitHub povas fermiĝi

    ❌ GitHub povas forigi vian deponejon

    ❌ GitHub povas ŝanĝi kondiĉojn

    ❌ Vi ne posedas vian deponejon

PermRepo provizas:

    ✅ Permanentajn sekurkopiojn sur Arweave

    ✅ On-chain Deskriptorojn sur Base

    ✅ Konfirmeblajn sekurkopiojn (Merkle-radiko)

    ✅ Malcentralizitan konservadon

    ✅ Vi kontrolas viajn datumojn

Kiel ĝi funkcias?

Uzanta fluo

1. Konekti GitHub (OAuth)
2. Konekti monujon (MetaMask sur Base)
3. Aĉeti abonon (2.5 USDC / monato)
4. Elekti deponejon
5. Krei On-chain Deskriptoron
6. Krei sekurkopion (ZIP + ĉifri + alŝuti al Arweave)
7 Kontroli (Merkle-radiko sur Base)

Sekurkopia fluo

GitHub Deponejo
    ↓
Elŝuti ZIP (GitHub API)
    ↓
Ĉifri (AES-GCM kun Ĉefŝlosilo)
    ↓
Alŝuti al Arweave (Turbo SDK)
    ↓
Krei manifeston (JSON)
    ↓
Alŝuti manifeston al Arweave
    ↓
Registri sur Base (addBackup)
    ↓
✅ Permanentaj Sekurkopio

Teknologioj
Frontend

    React 18

    Vite

    ethers.js v6

    Turbo SDK

    JSZip

    Web Crypto API (AES-GCM)

Backend

    Node.js 20+

    Express

    Redis (Upstash)

    ethers.js v6

    yauzl

Blokĉeno

    Base (L2)

    Solidity 0.8.35

    OpenZeppelin 5.x

    EIP-712

Konservado

    Arweave (permanenta)

    Turbo (alŝuta servo)

Kiel komenci?
Antaŭkondiĉoj

    Node.js 20+

    Git

    MetaMask

    GitHub-konto

    Upstash-konto

Instalado

# Kloni deponejon
git clone https://github.com/CasperLCasper/PermRepo-Virsburts-v3.git
cd PermRepo-Virsburts-v3

# Instali dependecojn
npm install

# Kopiu median skizon
cp .env.example .env

# Redaktu .env kun viaj valoroj
nano .env

# Konstrui frontend
npm run build

# Lanĉi servilon
node server.js

Mediaj variabloj

Vidu .env.example por plena listo.
Devigaj variabloj

Variablo				Priskribo
GITHUB_CLIENT_ID			GitHub OAuth Klienta ID
GITHUB_CLIENT_SECRET			GitHub OAuth Klienta Sekreto
GITHUB_REDIRECT_URI			GitHub OAuth callback URL
SESSION_SECRET				Sesia sekreto (32+ signoj)
UPSTASH_REDIS_REST_URL			Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN		Upstash Redis Tokens
CHAIN_ID				Base ĉena ID
RPC_URL					Base RPC URL
NFT_ADDRESS				PermRepoNFT kontrakta adreso
SUBSCRIPTION_ADDRESS			Abona kontrakta adreso
USDC_ADDRESS				USDC-kontrakta adreso
MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY	Privata ŝlosilo de malantaŭa monujo
ARWEAVE_GATEWAY				Arweave-pordego URL
TURBO_UPLOAD_URL			Turbo alŝuta URL
TURBO_PAYMENT_URL			Turbo paga URL

Kontraktoj

PermRepoNFT

ERC-721 NFT (nealienigebla) kun EIP-712 mint-rauxo, EIP-712 sekurkopia rauxo, kaj On-chain Deskriptoro por ĉiu deponejo.

Ĉefaj funkcioj:

function mintRepository(address recipient, string repository, uint256 deadline, bytes signature) external returns (uint256);
function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string manifestURI, uint256 deadline, bytes signature) external;
function migrateNFT(uint256 tokenId, address newOwner) external;

PermRepoSubscription

USDC-abono (2.5 USDC / monato), bazita sur GitHub (ne sur monujo).

Ĉefaj funkcioj:

function subscribe(bytes32 githubHash) external;
function isSubscribed(bytes32 githubHash) external view returns (bool);

API-finaĵoj

GitHub OAuth

Metodo	Finaĵo				Priskribo
GET	/api/github/login		Komenci OAuth-fluon
GET	/api/github/callback		OAuth callback
POST	/api/github/logout		Elsaluti
GET	/api/github/user		Akiri uzantan informon
GET	/api/github/repos		Listo de uzantaj deponejoj

Abono

Metodo	Finaĵo				Priskribo
GET	/api/subscription/status	Akiri abonan staton

Mint-rauxo

Metodo	Finaĵo				Priskribo
POST	/api/mint-authorization		Akiri EIP-712 mint-subskribon

Sekurkopioj

Metodo	Finaĵo				Priskribo
POST	/api/prepare-backup		Prepari sekurkopion (NDJSON-fluo)
GET	/api/job-status			Akiri taskan staton
POST	/api/start-zip-upload		Komenci ZIP-alŝuton
POST	/api/save-zip-tx		Konservi ZIP-transakcion
POST	/api/start-manifest-upload	Komenci manifestan alŝuton
POST	/api/save-manifest-tx		Konservi manifestan transakcion
POST	/api/start-blockchain-finalize	Komenci blokĉenan finigon
POST	/api/save-backup-tx		Konservi sekurkopian transakcion
POST	/api/complete-backup		Fini sekurkopion
POST	/api/fail-backup		Marki sekurkopion kiel malsukcesan
POST	/api/retry-backup		Reprovi

Sano

Metodo	Finaĵo				Priskribo
GET	/api/health			Sana kontrolo
GET	/api/config			Akiri agordon

Sekureco

1. Neniuj privataj ŝlosiloj sur servilo — nur malantaŭa monujo por subskribi rauxojn
2. EIP-712 subskriboj — subskribo de tipigitaj datumoj
3. Nonce-bazita protekto — ĉiu mint/sekurkopio havas unikan nonce
4. Deadline-limigo — subskriboj finiĝas post 15 minutoj
5. GitHub-proprieta kontrolo — malantaŭo kontrolas deponejan proprieton
6. Ĉifritaj sekurkopioj — AES-GCM kun uzanta Ĉefŝlosilo
7. Nur HTTPS — ĉiuj konektoj ĉifritaj
8. CSP-kapoj — Content Security Policy

Malantaŭa monujo

La malantaŭa monujo (MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY):

- Subskribas EIP-712 mint-rauxojn
- NE pagas gas
- NE mintas NFT
- NE tenas monon
- Nur subskribas post kontrolo de GitHub-proprieto

Ĉefŝlosilo

La Ĉefŝlosilo:

- Generita ĉe unua sekurkopio
- Montrita al uzanto unufoje
- Neniam sendita al servilo
- Uzata por ĉifri/malĉifri sekurkopiojn
- Se perdita — sekurkopioj ne povas esti malĉifritaj

Licenco

MIT License

Copyright (c) 2026 Virsburts PermRepo

Links / Saites / Ligiloj

- Website:	https://permrepo-virsburts-v3.onrender.com

- GitHub:	https://github.com/CasperLCasper/PermRepo-Virsburts-v3

- Base:		https://base.org

- Arweave:	https://arweave.org

- Turbo:	https://ardrive.io/turbo

- ARIO:		
