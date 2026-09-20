// server.js - Express API
// PermRepo backend: GitHub OAuth + repo preparation + Redis job state.
// Nav privātas blockchain/Turbo atslēgas, nav server-side Turbo maksājumu wallet.

import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import yauzl from 'yauzl';

import {
    initRedis,
    getRedis,
    createJob,
    getJob,
    updateJob,
    acquireJobLock,
    releaseJobLock,
    extendJobLock
} from './accounting-redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY || '';
const CHAIN_ID = process.env.CHAIN_ID || '';
const RPC_URL = process.env.RPC_URL || '';
const NFT_ADDRESS = process.env.NFT_ADDRESS || '';
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS || '';
const USDC_ADDRESS = process.env.USDC_ADDRESS || '';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL || '';
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL || '';
const MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY =
    process.env.MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY || '';

const MAX_REPO_FILES = Number(process.env.MAX_REPO_FILES || 5000);
const MAX_REPO_BYTES = Number(process.env.MAX_REPO_BYTES || 524288000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 104857600);
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 629145600);
const RESOURCE_MEMORY_BUDGET_RATIO = Number(
    process.env.RESOURCE_MEMORY_BUDGET_RATIO || 0.60
);
const RESOURCE_MEMORY_OVERHEAD_BYTES = Number(
    process.env.RESOURCE_MEMORY_OVERHEAD_BYTES || 33554432
);
const RESOURCE_MEMORY_MULTIPLIER = Number(
    process.env.RESOURCE_MEMORY_MULTIPLIER || 2.60
);
const MIN_BACKUP_MEMORY_RESERVATION_BYTES = Number(
    process.env.MIN_BACKUP_MEMORY_RESERVATION_BYTES || 8388608
);
const MAX_BACKUP_QUEUE = Number(
    process.env.MAX_BACKUP_QUEUE || 200
);
const RESOURCE_QUEUE_HEARTBEAT_MS = Number(
    process.env.RESOURCE_QUEUE_HEARTBEAT_MS || 15000
);

const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || 7200);
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 3600);
const LOCK_HEARTBEAT_MS = Number(process.env.LOCK_HEARTBEAT_MS || 60000);
const DOWNLOAD_CONCURRENCY = 3;
const MAX_GITHUB_REPO_PAGES = 10;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MINT_AUTHORIZATION_TTL_SECONDS = 900; // 15 min

if (!CHAIN_ID) {
    console.error('❌ CHAIN_ID nav iestatīts!');
    process.exit(1);
}

if (!RPC_URL) {
    console.error('❌ RPC_URL nav iestatīts!');
    process.exit(1);
}

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error('❌ SESSION_SECRET nav iestatīts vai ir pārāk īss!');
    process.exit(1);
}

if (!MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY) {
    console.error('❌ MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY nav iestatīts!');
    process.exit(1);
}

if (!Number.isInteger(MAX_REPO_FILES) || MAX_REPO_FILES <= 0) {
    console.error('❌ MAX_REPO_FILES ir nederīgs!');
    process.exit(1);
}

if (!Number.isSafeInteger(MAX_REPO_BYTES) || MAX_REPO_BYTES <= 0) {
    console.error('❌ MAX_REPO_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(MAX_FILE_BYTES) ||
    MAX_FILE_BYTES <= 0 ||
    MAX_FILE_BYTES > MAX_REPO_BYTES
) {
    console.error('❌ MAX_FILE_BYTES ir nederīgs!');
    process.exit(1);
}

if (!Number.isSafeInteger(MAX_ZIP_BYTES) || MAX_ZIP_BYTES <= 0) {
    console.error('❌ MAX_ZIP_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isFinite(RESOURCE_MEMORY_BUDGET_RATIO) ||
    RESOURCE_MEMORY_BUDGET_RATIO <= 0 ||
    RESOURCE_MEMORY_BUDGET_RATIO >= 1
) {
    console.error('❌ RESOURCE_MEMORY_BUDGET_RATIO ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(RESOURCE_MEMORY_OVERHEAD_BYTES) ||
    RESOURCE_MEMORY_OVERHEAD_BYTES < 0
) {
    console.error('❌ RESOURCE_MEMORY_OVERHEAD_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isFinite(RESOURCE_MEMORY_MULTIPLIER) ||
    RESOURCE_MEMORY_MULTIPLIER <= 0
) {
    console.error('❌ RESOURCE_MEMORY_MULTIPLIER ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(MIN_BACKUP_MEMORY_RESERVATION_BYTES) ||
    MIN_BACKUP_MEMORY_RESERVATION_BYTES <= 0
) {
    console.error('❌ MIN_BACKUP_MEMORY_RESERVATION_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(MAX_BACKUP_QUEUE) ||
    MAX_BACKUP_QUEUE <= 0
) {
    console.error('❌ MAX_BACKUP_QUEUE ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(RESOURCE_QUEUE_HEARTBEAT_MS) ||
    RESOURCE_QUEUE_HEARTBEAT_MS <= 0
) {
    console.error('❌ RESOURCE_QUEUE_HEARTBEAT_MS ir nederīgs!');
    process.exit(1);
}

initRedis();

class BackupResourceController {
    constructor() {
        this.totalMemoryBytes = os.totalmem();
        this.memoryBudgetBytes = Math.floor(
            this.totalMemoryBytes *
                RESOURCE_MEMORY_BUDGET_RATIO
        );
        this.reservedMemoryBytes = 0;
        this.activeBackups = 0;
        this.queue = [];
        this.sequence = 0;
    }

    estimateMemoryBytes(maxFileBytes) {
        const safeMaxFileBytes =
            Number.isSafeInteger(maxFileBytes) &&
            maxFileBytes >= 0
                ? maxFileBytes
                : 0;

        return Math.max(
            MIN_BACKUP_MEMORY_RESERVATION_BYTES,
            Math.ceil(
                RESOURCE_MEMORY_OVERHEAD_BYTES +
                safeMaxFileBytes *
                    RESOURCE_MEMORY_MULTIPLIER
            )
        );
    }

    getSnapshot() {
        const rssBytes =
            process.memoryUsage().rss;

        const availableBytes = Math.max(
            0,
            this.memoryBudgetBytes -
                rssBytes -
                this.reservedMemoryBytes
        );

        return {
            totalMemoryBytes: this.totalMemoryBytes,
            memoryBudgetBytes: this.memoryBudgetBytes,
            reservedMemoryBytes: this.reservedMemoryBytes,
            activeBackups: this.activeBackups,
            queuedBackups: this.queue.length,
            rssBytes,
            availableBytes
        };
    }

    canAcquire(reservationBytes) {
        const rssBytes =
            process.memoryUsage().rss;

        return (
            rssBytes +
                this.reservedMemoryBytes +
                reservationBytes <=
            this.memoryBudgetBytes
        );
    }

    acquire(reservationBytes, onQueued) {
        if (this.canAcquire(reservationBytes)) {
            this.reservedMemoryBytes += reservationBytes;
            this.activeBackups += 1;

            return {
                promise: Promise.resolve({
                    release: () => this.release(reservationBytes),
                    queued: false
                }),
                id: null
            };
        }

        if (this.queue.length >= MAX_BACKUP_QUEUE) {
            throw new Error(
                `Backup rinda ir pilna (${MAX_BACKUP_QUEUE}). Lūdzu, mēģiniet vēlāk.`
            );
        }

        const id = ++this.sequence;
        let resolveWaiter;
        let rejectWaiter;

        const promise = new Promise(
            (resolve, reject) => {
                resolveWaiter = resolve;
                rejectWaiter = reject;
            }
        );

        this.queue.push({
            id,
            reservationBytes,
            resolve: resolveWaiter,
            reject: rejectWaiter,
            cancelled: false,
            enqueuedAt: Date.now()
        });

        if (typeof onQueued === 'function') {
            onQueued(
                this.getQueuePosition(id),
                this.getSnapshot(),
                id
            );
        }

        this.pump();

        return { promise, id };
    }

    cancel(id) {
        if (!id) return false;

        const index = this.queue.findIndex(
            waiter => waiter.id === id
        );

        if (index === -1) return false;

        const [waiter] = this.queue.splice(index, 1);

        waiter.cancelled = true;
        waiter.reject(new Error('Backup pieprasījums tika atcelts.'));

        this.pump();

        return true;
    }

    release(reservationBytes) {
        this.reservedMemoryBytes = Math.max(
            0,
            this.reservedMemoryBytes - reservationBytes
        );

        this.activeBackups = Math.max(0, this.activeBackups - 1);

        this.pump();
    }

    pump() {
        let started = true;

        while (started && this.queue.length > 0) {
            started = false;

            for (let index = 0; index < this.queue.length; index += 1) {
                const waiter = this.queue[index];

                if (waiter.cancelled) {
                    this.queue.splice(index, 1);
                    started = true;
                    break;
                }

                if (!this.canAcquire(waiter.reservationBytes)) {
                    continue;
                }

                this.queue.splice(index, 1);

                this.reservedMemoryBytes += waiter.reservationBytes;
                this.activeBackups += 1;

                waiter.resolve({
                    release: () => this.release(waiter.reservationBytes),
                    queued: true
                });

                started = true;
                break;
            }
        }
    }

    getQueuePosition(id) {
        const index = this.queue.findIndex(waiter => waiter.id === id);
        return index === -1 ? 0 : index + 1;
    }
}

const backupResourceController = new BackupResourceController();

const resourcePumpTimer = setInterval(
    () => { backupResourceController.pump(); },
    5000
);

resourcePumpTimer.unref();

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
}

function logInfo(label, value) {
    const safeValue = String(value)
        .replace(/[\r\n\t]/g, ' ')
        .substring(0, 100);

    console.log(`   ${label}: ${safeValue}`);
}

function errorMessage(error) {
    if (error && typeof error.message === 'string') {
        return error.message.substring(0, 300);
    }
    return 'Nezināma kļūda.';
}

function parseChainId(value) {
    if (
        typeof value === 'string' &&
        /^0x[0-9a-f]+$/i.test(value)
    ) {
        return Number.parseInt(value, 16);
    }
    return Number(value);
}

const EXPECTED_CHAIN_ID = parseChainId(CHAIN_ID);

if (
    !Number.isInteger(EXPECTED_CHAIN_ID) ||
    EXPECTED_CHAIN_ID <= 0
) {
    console.error('❌ CHAIN_ID ir nederīgs!');
    process.exit(1);
}

function safeWallet(address) {
    try {
        return ethers.getAddress(address);
    } catch {
        return null;
    }
}

function validateJobId(jobId) {
    return (
        typeof jobId === 'string' &&
        /^[a-f0-9-]{20,100}$/i.test(jobId)
    );
}

function validateArweaveId(id) {
    return (
        typeof id === 'string' &&
        /^[a-zA-Z0-9_-]{43}$/.test(id)
    );
}

function validateTxHash(hash) {
    return (
        typeof hash === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(hash)
    );
}

function githubOwnerHash(login) {
    return ethers.keccak256(ethers.toUtf8Bytes(login));
}

function repositoryHash(fullRepoName) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['string'],
            [fullRepoName]
        )
    );
}

function calculateGitBlobSha(buffer) {
    const header = `blob ${buffer.length}\0`;
    const gitBlob = Buffer.concat([
        Buffer.from(header, 'utf8'),
        buffer
    ]);
    return crypto.createHash('sha1').update(gitBlob).digest('hex');
}

function getProvider() {
    return new ethers.JsonRpcProvider(RPC_URL, EXPECTED_CHAIN_ID);
}

// ✅ Mint authorization signer
const mintAuthorizationSigner = new ethers.Wallet(
    MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY
);

// ✅ Droša Arweave manifesta ielāde (servera pusē)
function getValidatedManifestUrl(manifestId) {
    if (!validateArweaveId(manifestId)) {
        throw new Error('Nederīgs manifesta ID.');
    }

    if (!ARWEAVE_GATEWAY) {
        throw new Error('ARWEAVE_GATEWAY nav iestatīts.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(ARWEAVE_GATEWAY);
    } catch {
        throw new Error('Nederīgs ARWEAVE_GATEWAY URL.');
    }

    if (parsedUrl.protocol !== 'https:') {
        throw new Error('ARWEAVE_GATEWAY jābūt https.');
    }

    return `${parsedUrl.origin}/raw/${encodeURIComponent(manifestId)}`;
}

async function loadPreviousManifest(lastManifest) {
    if (
        typeof lastManifest !== 'string' ||
        !lastManifest.startsWith('ar://')
    ) {
        return null;
    }

    const prevManifestId = lastManifest.slice(5);

    if (!validateArweaveId(prevManifestId)) {
        console.warn('Nederīgs iepriekšējā manifesta ID:', prevManifestId);
        return null;
    }

    try {
        const manifestUrl = getValidatedManifestUrl(prevManifestId);
        const response = await fetch(manifestUrl, {
            cache: 'no-store',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            console.warn(
                'Neizdevās ielādēt iepriekšējo manifestu:',
                response.status
            );
            return null;
        }

        const manifest = await response.json();

        if (
            !manifest ||
            typeof manifest !== 'object' ||
            Array.isArray(manifest)
        ) {
            return null;
        }

        return manifest;
    } catch (error) {
        console.warn(
            'Kļūda, ielādējot iepriekšējo manifestu:',
            errorMessage(error)
        );
        return null;
    }
}

const NFT_ABI = [
    'function repositoryTokens(bytes32 repoHash) external view returns (uint256)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function getBackupCount(uint256 tokenId) external view returns (uint256)',
    'function getManifestURI(uint256 tokenId) external view returns (string)',
    'function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)',
    'function mintNonces(address) external view returns (uint256)',
    'function defaultURI() external view returns (string)',
    'function mintSigner() external view returns (address)'
];

const SUBSCRIPTION_ABI = [
    'function isSubscribed(bytes32 githubHash) external view returns (bool)',
    'function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)',
    'function getRemainingTime(bytes32 githubHash) external view returns (uint256)',
    'function subscriptionPrice() external view returns (uint256)'
];

// ✅ BackupAdded event ABI
const BACKUP_ADDED_EVENT_ABI = [
    'event BackupAdded(uint256 indexed tokenId, uint256 indexed backupNumber, bytes32 indexed merkleRoot, bytes32 manifestHash, string manifestURI, uint256 nonce)'
];

function getAllowedConnectOrigins() {
    const origins = new Set([
        'https://api.github.com',
        'https://github.com',
        'https://arweave.net',
        'https://ar-io.dev',
        'https://gateway.arweave.net',
        'https://sepolia.base.org',
        'https://base-sepolia-rpc.publicnode.com',
        'https://upload.services.ar-io.dev',
        'https://payment.services.ar-io.dev'
    ]);

    for (const value of [
        ARWEAVE_GATEWAY,
        RPC_URL,
        TURBO_UPLOAD_URL,
        TURBO_PAYMENT_URL
    ]) {
        try {
            if (value) {
                origins.add(new URL(value).origin);
            }
        } catch {}
    }

    return [...origins].join(' ');
}

async function withJobLock(jobId, fn) {
    const token = await acquireJobLock(jobId);

    if (!token) {
        throw new Error('Job jau tiek apstrādāts.');
    }

    let heartbeatActive = true;
    const heartbeat = setInterval(async () => {
        if (!heartbeatActive) return;

        try {
            const extended = await extendJobLock(jobId, token);
            if (!extended) {
                console.warn(`⚠️ Lock ${jobId} vairs nepieder mums — heartbeat apturēts`);
                heartbeatActive = false;
                clearInterval(heartbeat);
            }
        } catch (error) {
            console.error('Lock heartbeat kļūda:', error);
        }
    }, LOCK_HEARTBEAT_MS);

    heartbeat.unref();

    try {
        return await fn();
    } finally {
        heartbeatActive = false;
        clearInterval(heartbeat);
        await releaseJobLock(jobId, token);
    }
}

// -----------------------------------------------------------------------------
// Redis-backed express-session store.
// -----------------------------------------------------------------------------

class UpstashSessionStore extends session.Store {
    constructor(redisClient, ttlSeconds) {
        super();
        this.redis = redisClient;
        this.ttlSeconds = ttlSeconds;
    }

    key(sid) { return `permrepo:session:${sid}`; }

    get(sid, callback) {
        this.redis.get(this.key(sid))
            .then(value => {
                if (!value) return callback(null, null);
                if (typeof value === 'object') return callback(null, value);
                return callback(null, JSON.parse(String(value)));
            })
            .catch(error => callback(error));
    }

    set(sid, sess, callback = () => {}) {
        this.redis.set(
            this.key(sid),
            JSON.stringify(sess),
            { ex: this.ttlSeconds }
        )
            .then(() => callback(null))
            .catch(error => callback(error));
    }

    destroy(sid, callback = () => {}) {
        this.redis.del(this.key(sid))
            .then(() => callback(null))
            .catch(error => callback(error));
    }

    touch(sid, sess, callback = () => {}) {
        this.redis.expire(this.key(sid), this.ttlSeconds)
            .then(() => callback(null))
            .catch(error => callback(error));
    }
}

const redisClient = getRedis();

if (!redisClient) {
    console.error('❌ Redis ir obligāts PermRepo serverim.');
    process.exit(1);
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
    const connectOrigins = getAllowedConnectOrigins();

    res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; ` +
        `script-src 'self' 'wasm-unsafe-eval'; ` +
        `style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data: blob:; ` +
        `font-src 'self'; ` +
        `connect-src 'self' ${connectOrigins}; ` +
        `form-action 'self' https://github.com; ` +
        `frame-ancestors 'none'; ` +
        `object-src 'none'; ` +
        `base-uri 'self';`
    );

    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    next();
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new UpstashSessionStore(redisClient, SESSION_TTL_SECONDS),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS * 1000
    }
}));

const githubApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Pārāk daudz GitHub operāciju — mēģini vēlāk.' },
    keyGenerator: req => req.session.githubUser || req.ip
});

const backupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Pārāk daudz backup operāciju — mēģini vēlāk.' },
    keyGenerator: req => req.session.githubUser || req.ip
});

const mintAuthorizationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Pārāk daudz mint operāciju — mēģini vēlāk.' },
    keyGenerator: req => req.session.githubUser || req.ip
});

class GitHubRateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.minInterval = 100;
    }

    async makeRequest(url, options) {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;

        if (timeSinceLast < this.minInterval) {
            await new Promise(resolve =>
                setTimeout(resolve, this.minInterval - timeSinceLast)
            );
        }

        this.lastRequestTime = Date.now();
        return fetch(url, options);
    }
}

const githubRateLimiterInstance = new GitHubRateLimiter();

async function fetchWithRetry(url, options, retries = 3) {
    let lastStatus = null;

    for (let attempt = 0; attempt < retries; attempt++) {
        const response = await githubRateLimiterInstance.makeRequest(url, options);
        lastStatus = response.status;

        if (response.status === 401) {
            throw new Error('GitHub autorizācija ir beigusies.');
        }

        if (response.status === 403 || response.status === 429) {
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfter = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;
            const backoff = retryAfter > 0 ? retryAfter : Math.pow(2, attempt) * 1000;

            if (attempt < retries - 1) {
                await new Promise(resolve =>
                    setTimeout(resolve, Math.min(backoff, 30000))
                );
                continue;
            }
        }

        if (!response.ok) {
            throw new Error(`GitHub API kļūda: ${response.status}`);
        }

        return response;
    }

    throw new Error(
        `GitHub API pieprasījums neizdevās (${lastStatus || 'nezināms statuss'}).`
    );
}

function createOAuthState() {
    return crypto.randomBytes(32).toString('hex');
}

function requireGithubSession(req, res) {
    if (!req.session.githubToken || !req.session.githubUser) {
        res.status(401).json({
            success: false,
            error: 'Nav GitHub autorizācijas'
        });
        return false;
    }
    return true;
}

async function getGitHubRepository(githubToken, owner, repo) {
    const response = await fetchWithRetry(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }
    );

    const data = await response.json();

    if (!data || typeof data !== 'object') {
        throw new Error('GitHub repo dati nav derīgi.');
    }

    if (data.archived) {
        throw new Error('Arhivēts GitHub repozitorijs nav pieejams backupam.');
    }

    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id)) {
        throw new Error('GitHub repo ID nav derīgs.');
    }

    if (typeof data.default_branch !== 'string' || !data.default_branch) {
        throw new Error('GitHub default branch nav atrasts.');
    }

    const canonicalOwner = data.owner?.login;
    const fullName = data.full_name;

    if (canonicalOwner !== owner || fullName !== `${owner}/${repo}`) {
        throw new Error('GitHub repozitorija identitāte nesakrīt ar autorizēto lietotāju.');
    }

    return {
        id: data.id,
        fullName,
        defaultBranch: data.default_branch,
        private: Boolean(data.private),
        permissions: data.permissions || null
    };
}

async function getBranchCommitSha(githubToken, owner, repo, branch) {
    const url =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `git/ref/heads/` +
        `${encodeURIComponent(branch)}`;

    const response = await fetchWithRetry(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    const data = await response.json();
    const sha = data?.object?.sha;

    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error('GitHub branch commit SHA nav derīgs.');
    }

    return sha;
}

async function getGitTree(githubToken, owner, repo, ref) {
    const encodedRef = encodeURIComponent(ref);

    const url =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `git/trees/${encodedRef}?recursive=1`;

    const response = await fetchWithRetry(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    const data = await response.json();

    if (!data || !Array.isArray(data.tree)) {
        throw new Error('GitHub Git Tree dati nav derīgi.');
    }

    if (data.truncated) {
        throw new Error(
            'GitHub repozitorijs ir pārāk liels, lai to droši nolasītu vienā Git Tree pieprasījumā.'
        );
    }

    const blobs = data.tree.filter(item => item.type === 'blob');

    if (blobs.length > MAX_REPO_FILES) {
        throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
    }

    return { sha: data.sha || null, blobs };
}

async function downloadGitHubZipToTempFile(response, tempPath) {
    const contentLengthHeader = response.headers.get('content-length');

    if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader);

        if (Number.isSafeInteger(contentLength) && contentLength > MAX_ZIP_BYTES) {
            throw new Error(`GitHub ZIP pārsniedz ${MAX_ZIP_BYTES} bytes limitu.`);
        }
    }

    if (!response.body) {
        throw new Error('GitHub ZIP atbilde nesatur datu streamu.');
    }

    let receivedBytes = 0;

    const byteLimitTransform = new Transform({
        transform(chunk, encoding, callback) {
            try {
                const buffer = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk, encoding);

                receivedBytes += buffer.length;

                if (receivedBytes > MAX_ZIP_BYTES) {
                    callback(new Error(`GitHub ZIP pārsniedz ${MAX_ZIP_BYTES} bytes limitu.`));
                    return;
                }

                callback(null, buffer);
            } catch (error) {
                callback(error);
            }
        }
    });

    await pipeline(
        Readable.fromWeb(response.body),
        byteLimitTransform,
        fs.createWriteStream(tempPath, { flags: 'wx' })
    );

    if (receivedBytes === 0) {
        throw new Error('GitHub ZIP atbilde ir tukša.');
    }

    return receivedBytes;
}

async function getRepoArchiveMetadata(githubToken, owner, repo, defaultBranch) {
    const repository = await getGitHubRepository(githubToken, owner, repo);

    const commitSha = await getBranchCommitSha(
        githubToken, owner, repo,
        defaultBranch || repository.defaultBranch
    );

    const tree = await getGitTree(githubToken, owner, repo, commitSha);

    return {
        repository,
        commitSha,
        treeSha: tree.sha,
        blobs: tree.blobs
    };
}

async function openRepoArchive(githubToken, owner, repo, metadata) {
    const { repository, commitSha, treeSha, blobs } = metadata;

    if (blobs.length === 0) {
        return {
            repository, commitSha, treeSha, blobs,
            tempPath: null, zipfile: null
        };
    }

    const zipUrl =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `zipball/${encodeURIComponent(commitSha)}`;

    const response = await fetchWithRetry(zipUrl, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    const tempPath = path.join(
        os.tmpdir(),
        `permrepo-${crypto.randomUUID()}.zip`
    );

    try {
        await downloadGitHubZipToTempFile(response, tempPath);

        const zipfile = await yauzl.openPromise(tempPath, {
            lazyEntries: true,
            decodeStrings: true,
            validateEntrySizes: true
        });

        return {
            repository, commitSha, treeSha, blobs,
            tempPath, zipfile
        };
    } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function processRepoArchive(archive, onFile) {
    const { blobs, zipfile } = archive;

    if (!zipfile) {
        return { files: [], totalBytes: 0 };
    }

    const treeByPath = new Map(blobs.map(blob => [blob.path, blob]));
    const seenPaths = new Set();

    let entries = 0;
    let totalBytes = 0;

    try {
        for await (const entry of zipfile.eachEntry()) {
            if (entry.fileName.endsWith('/')) continue;

            entries += 1;

            if (entries > MAX_REPO_FILES) {
                throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
            }

            const parts = entry.fileName.split('/');
            const filePath = parts.length > 1 ? parts.slice(1).join('/') : parts[0];

            if (
                !filePath ||
                filePath.length > 1000 ||
                filePath.split('/').some(part => part === '' || part === '.' || part === '..')
            ) {
                throw new Error(`GitHub arhīvā atrasts nederīgs faila ceļš: ${entry.fileName}`);
            }

            if (seenPaths.has(filePath)) {
                throw new Error(`GitHub arhīvā atrasts dublēts fails: ${filePath}`);
            }

            seenPaths.add(filePath);

            const treeEntry = treeByPath.get(filePath);

            if (!treeEntry) {
                throw new Error(`GitHub arhīvā nav atrasts fails: ${filePath}`);
            }

            if (
                !Number.isSafeInteger(entry.uncompressedSize) ||
                entry.uncompressedSize < 0
            ) {
                throw new Error(`ZIP ierakstam ${filePath} ir nederīgs nekompresētais izmērs.`);
            }

            if (entry.uncompressedSize > MAX_FILE_BYTES) {
                throw new Error(`Fails ${filePath} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`);
            }

            if (treeEntry.size !== entry.uncompressedSize) {
                throw new Error(
                    `Faila ${filePath} izmērs nesakrīt: ` +
                    `Git Tree ${treeEntry.size} vs ZIP ${entry.uncompressedSize}`
                );
            }

            const fileBuffer = Buffer.allocUnsafe(entry.uncompressedSize);

            const gitSha1 = crypto.createHash('sha1');
            gitSha1.update(
                Buffer.from(`blob ${entry.uncompressedSize}\0`, 'utf8')
            );

            const sha256 = crypto.createHash('sha256');

            const fileStream = await zipfile.openReadStreamPromise(entry);
            let offset = 0;

            for await (const chunk of fileStream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

                if (offset + buffer.length > fileBuffer.length) {
                    throw new Error(`ZIP fails ${filePath} pārsniedz deklarēto izmēru.`);
                }

                buffer.copy(fileBuffer, offset);
                offset += buffer.length;
                gitSha1.update(buffer);
                sha256.update(buffer);
            }

            if (offset !== fileBuffer.length) {
                throw new Error(
                    `Faila ${filePath} faktiskais izmērs nesakrīt ar ZIP deklarēto izmēru.`
                );
            }

            const calculatedGitSha = gitSha1.digest('hex');

            if (treeEntry.sha !== calculatedGitSha) {
                throw new Error(
                    `Faila ${filePath} Git SHA nesakrīt: ` +
                    `Git Tree ${treeEntry.sha} vs aprēķināts ${calculatedGitSha}`
                );
            }

            totalBytes += fileBuffer.length;

            if (totalBytes > MAX_REPO_BYTES) {
                throw new Error(`Repo pārsniedz maksimālo izmēru (${MAX_REPO_BYTES} bytes).`);
            }

            const file = {
                path: filePath,
                size: fileBuffer.length,
                content: fileBuffer.toString('base64'),
                hash: sha256.digest('hex')
            };

            await onFile(file);
        }

        if (entries !== blobs.length || seenPaths.size !== blobs.length) {
            throw new Error('GitHub repo arhīva failu skaits nesakrīt ar Git Tree.');
        }

        return { files: null, totalBytes };
    } finally {
        try { zipfile.close(); } catch {}
    }
}

async function verifySubscription(githubUser) {
    const provider = getProvider();

    const subscriptionContract = new ethers.Contract(
        SUBSCRIPTION_ADDRESS,
        SUBSCRIPTION_ABI,
        provider
    );

    const githubHash = githubOwnerHash(githubUser);

    const isSubscribed = await subscriptionContract.isSubscribed(githubHash);

    if (!isSubscribed) {
        throw new Error('Abonements nav aktīvs.');
    }

    return true;
}

function assertSameOrigin(req) {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const expected = `${req.protocol}://${req.get('host')}`;

    if (origin) {
        if (origin !== expected) {
            throw new Error('Nederīgs pieprasījuma origin.');
        }
        return;
    }

    if (referer) {
        try {
            const refererOrigin = new URL(referer).origin;
            if (refererOrigin !== expected) {
                throw new Error('Nederīgs pieprasījuma referer.');
            }
        } catch (error) {
            if (
                error instanceof Error &&
                error.message === 'Nederīgs pieprasījuma referer.'
            ) {
                throw error;
            }
            throw new Error('Nederīgs pieprasījuma referer.');
        }
    }
}

function validateJobTxInput(jobId, txId) {
    if (!validateJobId(jobId)) {
        throw new Error('Nederīgs job ID.');
    }
    if (!validateArweaveId(txId)) {
        throw new Error('Nederīgs transakcijas ID.');
    }
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifests nav derīgs objekts.');
    }

    const serialized = JSON.stringify(manifest);

    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
        throw new Error('Manifests pārsniedz maksimālo izmēru.');
    }

    if (manifest.manifest !== 'arweave/paths') {
        throw new Error('Nederīgs manifesta tips.');
    }

    if (manifest.version !== '0.2.0') {
        throw new Error('Nederīga manifesta versija.');
    }

    if (!manifest.paths || typeof manifest.paths !== 'object' || Array.isArray(manifest.paths)) {
        throw new Error('Manifesta paths nav derīgs objekts.');
    }

    for (const [filePath, info] of Object.entries(manifest.paths)) {
        if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 1000) {
            throw new Error('Manifests satur nederīgu faila ceļu.');
        }

        if (!info || typeof info !== 'object') {
            throw new Error(`Manifesta ieraksts ${filePath} nav derīgs.`);
        }

        const id = info.id || info.zipId;

        if (!validateArweaveId(id)) {
            throw new Error(`Manifesta ierakstam ${filePath} ir nederīgs ID.`);
        }

        if (typeof info.hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(info.hash)) {
            throw new Error(`Manifesta ierakstam ${filePath} ir nederīgs SHA-256 hash.`);
        }
    }

    return true;
}

async function verifyJobAuthorization(req, job) {
    if (!job) throw new Error('Backup job nav atrasts.');

    if (!req.session.githubToken || !req.session.githubUser) {
        throw new Error('Nav GitHub autorizācijas.');
    }

    if (req.session.githubUser !== job.githubUser) {
        throw new Error('GitHub lietotājs nesakrīt ar backup job.');
    }

    const wallet = safeWallet(job.walletAddress);

    if (!wallet) {
        throw new Error('Backup job satur nederīgu maka adresi.');
    }

    return wallet;
}

async function verifyJobNFTAuthorization(job) {
    const provider = getProvider();
    const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
    const tokenId = BigInt(job.tokenId);
    const owner = await nftContract.ownerOf(tokenId);

    if (owner.toLowerCase() !== job.walletAddress.toLowerCase()) {
        throw new Error('Backup job maka adrese vairs nepieder NFT.');
    }

    return owner;
}

async function prepareOAuthLogin(req, res) {
    if (!GITHUB_CLIENT_ID || !GITHUB_REDIRECT_URI) {
        return res.status(500).send('GitHub OAuth nav konfigurēts.');
    }

    const state = createOAuthState();
    req.session.oauthState = state;

    const scope = 'repo';

    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: GITHUB_REDIRECT_URI,
        scope,
        state
    });

    return res.redirect(
        `https://github.com/login/oauth/authorize?${params.toString()}`
    );
}

// =============================================================================
// GitHub OAuth endpoints
// =============================================================================

app.get('/api/github/login', githubApiLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        return await prepareOAuthLogin(req, res);
    } catch (error) {
        return res.status(400).send(errorMessage(error));
    }
});

app.get('/api/github/callback', githubApiLimiter, async (req, res) => {
    const { code, state } = req.query;
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (typeof expectedState !== 'string' || typeof state !== 'string') {
        return res.redirect('/?error=oauth_state');
    }

    const expectedBuffer = Buffer.from(expectedState, 'utf8');
    const suppliedBuffer = Buffer.from(state, 'utf8');

    if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
        return res.redirect('/?error=oauth_state');
    }

    try {
        const tokenResponse = await fetch(
            'https://github.com/login/oauth/access_token',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    client_id: GITHUB_CLIENT_ID,
                    client_secret: GITHUB_CLIENT_SECRET,
                    code,
                    redirect_uri: GITHUB_REDIRECT_URI
                })
            }
        );

        if (!tokenResponse.ok) {
            return res.redirect('/?error=token');
        }

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            return res.redirect('/?error=token');
        }

        const userResponse = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        if (!userResponse.ok) {
            return res.redirect('/?error=user');
        }

        const userData = await userResponse.json();

        if (!userData.login || typeof userData.login !== 'string') {
            return res.redirect('/?error=user');
        }

        await new Promise((resolve, reject) => {
            req.session.regenerate(error => {
                if (error) {
                    reject(error);
                    return;
                }

                req.session.githubToken = tokenData.access_token;
                req.session.githubUser = userData.login;
                req.session.githubAvatar = userData.avatar_url || null;

                resolve();
            });
        });

        return res.redirect('/');
    } catch (error) {
        console.error('GitHub OAuth callback error:', error);
        return res.redirect('/?error=oauth');
    }
});

app.post('/api/github/logout', async (req, res) => {
    try {
        assertSameOrigin(req);

        await new Promise((resolve, reject) => {
            req.session.destroy(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });

        res.clearCookie('connect.sid');

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: errorMessage(error)
        });
    }
});

app.get('/api/github/user', async (req, res) => {
    if (!req.session.githubUser) {
        return res.json({ success: false });
    }

    return res.json({
        success: true,
        user: req.session.githubUser,
        avatar: req.session.githubAvatar || null
    });
});

app.get('/api/github/repos', githubApiLimiter, async (req, res) => {
    try {
        if (!requireGithubSession(req, res)) return;

        const user = req.session.githubUser;
        const token = req.session.githubToken;
        const repos = [];

        for (let page = 1; page <= MAX_GITHUB_REPO_PAGES; page++) {
            const response = await fetchWithRetry(
                `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28'
                    }
                }
            );

            const data = await response.json();

            if (!Array.isArray(data)) {
                throw new Error('GitHub repo saraksts nav derīgs.');
            }

            for (const repo of data) {
                if (repo?.owner?.login === user) {
                    repos.push({
                        id: repo.id,
                        name: repo.name,
                        full_name: repo.full_name,
                        private: Boolean(repo.private),
                        archived: Boolean(repo.archived),
                        default_branch: repo.default_branch || 'main'
                    });
                }
            }

            if (data.length < 100) break;
        }

        return res.json({ success: true, repos });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: errorMessage(error)
        });
    }
});

app.get('/api/config', async (req, res) => {
    return res.json({
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        usdcAddress: USDC_ADDRESS,
        arweaveGateway: ARWEAVE_GATEWAY,
        turboUploadUrl: TURBO_UPLOAD_URL,
        turboPaymentUrl: TURBO_PAYMENT_URL
    });
});

app.get('/api/subscription/status', async (req, res) => {
    try {
        if (!requireGithubSession(req, res)) return;

        const provider = getProvider();
        const subscriptionContract = new ethers.Contract(
            SUBSCRIPTION_ADDRESS,
            SUBSCRIPTION_ABI,
            provider
        );

        const githubHash = githubOwnerHash(req.session.githubUser);

        const [isSubscribed, expiry, remainingTime, price] = await Promise.all([
            subscriptionContract.isSubscribed(githubHash),
            subscriptionContract.getSubscriptionExpiry(githubHash),
            subscriptionContract.getRemainingTime(githubHash),
            subscriptionContract.subscriptionPrice()
        ]);

        return res.json({
            success: true,
            isSubscribed,
            expiry: expiry.toString(),
            remainingTime: remainingTime.toString(),
            price: price.toString(),
            githubUser: req.session.githubUser
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: errorMessage(error)
        });
    }
});

// =============================================================================
// Mint authorization (EIP-712)
// =============================================================================

app.post('/api/mint-authorization', mintAuthorizationLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { repository, walletAddress } = req.body;
        const githubUser = req.session.githubUser;
        const githubToken = req.session.githubToken;
        const normalizedWallet = safeWallet(walletAddress);

        if (!normalizedWallet) {
            return res.status(400).json({
                success: false,
                error: 'Nederīga maka adrese.'
            });
        }

        if (
            typeof repository !== 'string' ||
            !/^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs repo nosaukums.'
            });
        }

        const [owner, repo] = repository.split('/');

        if (owner !== githubUser) {
            return res.status(403).json({
                success: false,
                error: 'Repozitorijs nepieder šim GitHub lietotājam.'
            });
        }

        // ✅ Pārbauda GitHub repo ownership
        const repoData = await getGitHubRepository(
            githubToken,
            owner,
            repo
        );

        if (
            !repoData.permissions ||
            (!repoData.permissions.admin && !repoData.permissions.push)
        ) {
            return res.status(403).json({
                success: false,
                error: 'Tev nav tiesību uz šo repozitoriju.'
            });
        }

        // ✅ Iegūst nonce un defaultURI no kontrakta
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);

        let currentNonce;
        let defaultURI;

        try {
            [currentNonce, defaultURI] = await Promise.all([
                nftContract.mintNonces(normalizedWallet),
                nftContract.defaultURI()
            ]);
        } catch (rpcError) {
            console.error('RPC kļūda mint authorization:', rpcError);
            return res.status(500).json({
                success: false,
                error: 'Neizdevās nolasīt kontrakta stāvokli.'
            });
        }

        if (!defaultURI || defaultURI.length === 0) {
            return res.status(500).json({
                success: false,
                error: 'defaultURI nav iestatīts kontraktā.'
            });
        }

        const deadline = Math.floor(Date.now() / 1000) + MINT_AUTHORIZATION_TTL_SECONDS;

        // ✅ EIP-712 domain
        const domain = {
            name: 'PermRepo',
            version: '1',
            chainId: EXPECTED_CHAIN_ID,
            verifyingContract: NFT_ADDRESS
        };

        // ✅ EIP-712 types
        const types = {
            MintRepository: [
                { name: 'recipient', type: 'address' },
                { name: 'repository', type: 'string' },
                { name: 'uri', type: 'string' },
                { name: 'deadline', type: 'uint256' },
                { name: 'nonce', type: 'uint256' }
            ]
        };

        // ✅ EIP-712 value
        const value = {
            recipient: normalizedWallet,
            repository: repository,
            uri: defaultURI,
            deadline: deadline,
            nonce: currentNonce
        };

        // ✅ Paraksta ar backend wallet
        let signature;
        try {
            signature = await mintAuthorizationSigner.signTypedData(
                domain,
                types,
                value
            );
        } catch (signError) {
            console.error('Mint signature kļūda:', signError);
            return res.status(500).json({
                success: false,
                error: 'Neizdevās parakstīt mint autorizāciju.'
            });
        }

        return res.json({
            success: true,
            signature,
            deadline,
            nonce: currentNonce.toString()
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nepieder|nav tiesību/i.test(message) ? 403 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// Backup preparation (NDJSON)
// =============================================================================

async function writeNdjson(res, payload) {
    if (res.destroyed || res.writableEnded) {
        throw new Error('Klienta savienojums tika pārtraukts.');
    }

    const line = `${JSON.stringify(payload)}\n`;

    if (res.write(line)) return;

    await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => {
            cleanup();
            reject(new Error('Klienta savienojums tika pārtraukts.'));
        };
        const cleanup = () => {
            res.off('drain', onDrain);
            res.off('close', onClose);
        };

        res.once('drain', onDrain);
        res.once('close', onClose);
    });
}

app.post('/api/prepare-backup', backupLimiter, async (req, res) => {
    let resourceLease = null;
    let resourceQueueId = null;
    let archive = null;
    let streamStarted = false;
    let queueHeartbeat = null;
    let clientClosed = false;

    const onResponseClose = () => {
        clientClosed = true;

        if (!resourceLease && resourceQueueId) {
            backupResourceController.cancel(resourceQueueId);
        }
    };

    res.once('close', onResponseClose);

    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        const githubUser = req.session.githubUser;
        const normalizedWallet = safeWallet(walletAddress);

        if (
            typeof repoName !== 'string' ||
            !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs repo nosaukums.'
            });
        }

        if (!normalizedWallet) {
            return res.status(400).json({
                success: false,
                error: 'Nederīga maka adrese.'
            });
        }

        logSection('📥 PREPARE BACKUP');
        logInfo('Repo', `${githubUser}/${repoName}`);
        logInfo('Wallet', normalizedWallet);

        await verifySubscription(githubUser);

        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const fullRepoName = `${githubUser}/${repoName}`;
        const repoHash = repositoryHash(fullRepoName);
        const tokenId = await nftContract.repositoryTokens(repoHash);

        if (tokenId === 0n) {
            return res.status(400).json({
                success: false,
                error: 'Šim repozitorijam nav PermRepo NFT.'
            });
        }

        const nftOwner = await nftContract.ownerOf(tokenId);

        if (nftOwner.toLowerCase() !== normalizedWallet.toLowerCase()) {
            return res.status(403).json({
                success: false,
                error: 'Savienotajam makam nepieder šī repozitorija NFT.'
            });
        }

        const [backupCount, lastManifest, lastMerkleRoot] = await Promise.all([
            nftContract.getBackupCount(tokenId),
            nftContract.getManifestURI(tokenId),
            nftContract.getLastMerkleRoot(tokenId)
        ]);

        const archiveMetadata = await getRepoArchiveMetadata(
            githubToken, githubUser, repoName,
            req.body.defaultBranch || undefined
        );

        if (archiveMetadata.blobs.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Repozitorijā nav failu.'
            });
        }

        let maxFileBytes = 0;

        for (const blob of archiveMetadata.blobs) {
            if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
                throw new Error(`Git Tree failam ${blob.path} ir nederīgs izmērs.`);
            }

            if (blob.size > MAX_FILE_BYTES) {
                throw new Error(`Fails ${blob.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`);
            }

            maxFileBytes = Math.max(maxFileBytes, blob.size);
        }

        // ✅ #1 LABOJUMS: Serveris ielādē iepriekšējo manifestu un sadala changed/unchanged
        const previousManifest = await loadPreviousManifest(lastManifest);
        const previousPaths =
            previousManifest &&
            previousManifest.paths &&
            typeof previousManifest.paths === 'object' &&
            !Array.isArray(previousManifest.paths)
                ? previousManifest.paths
                : {};

        const reservationBytes = backupResourceController.estimateMemoryBytes(maxFileBytes);
        const jobId = crypto.randomUUID();
        const now = Date.now();

        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.flushHeaders();

        streamStarted = true;

        const acquireResult = backupResourceController.acquire(
            reservationBytes,
            (queuePosition, snapshot, queueId) => {
                resourceQueueId = queueId;

                void writeNdjson(res, {
                    type: 'queued',
                    success: true,
                    jobId,
                    queuePosition,
                    reservationBytes,
                    memoryBudgetBytes: snapshot.memoryBudgetBytes,
                    availableBytes: snapshot.availableBytes
                }).catch(() => {});
            }
        );

        resourceQueueId = acquireResult.id;

        if (acquireResult.id) {
            queueHeartbeat = setInterval(() => {
                if (clientClosed || resourceLease) return;

                const snapshot = backupResourceController.getSnapshot();

                void writeNdjson(res, {
                    type: 'queue-status',
                    success: true,
                    jobId,
                    queuePosition: backupResourceController.getQueuePosition(acquireResult.id),
                    activeBackups: snapshot.activeBackups,
                    queuedBackups: snapshot.queuedBackups,
                    availableBytes: snapshot.availableBytes,
                    reservedMemoryBytes: snapshot.reservedMemoryBytes,
                    rssBytes: snapshot.rssBytes
                }).catch(() => {});
            }, RESOURCE_QUEUE_HEARTBEAT_MS);
        }

        resourceLease = await acquireResult.promise;

        if (queueHeartbeat) {
            clearInterval(queueHeartbeat);
            queueHeartbeat = null;
        }

        resourceQueueId = null;

        if (clientClosed) {
            throw new Error('Klienta savienojums tika pārtraukts.');
        }

        await writeNdjson(res, {
            type: 'started',
            success: true,
            jobId
        });

        archive = await openRepoArchive(
            githubToken, githubUser, repoName, archiveMetadata
        );

        const jobFiles = [];
        const changedFileMetadata = [];
        const unchangedFiles = {};
        let totalBytes = 0;

        await writeNdjson(res, {
            type: 'meta',
            success: true,
            jobId,
            repoName: fullRepoName,
            githubRepositoryId: String(archive.repository.id),
            githubDefaultBranch: archive.repository.defaultBranch,
            githubCommitSha: archive.commitSha,
            githubTreeSha: archive.treeSha,
            tokenId: tokenId.toString(),
            backupCount: backupCount.toString(),
            lastManifest: lastManifest || null,
            lastMerkleRoot: lastMerkleRoot || null,
            reservationBytes
        });

        await processRepoArchive(archive, async file => {
            jobFiles.push({
                path: file.path,
                hash: file.hash,
                size: file.size
            });

            // ✅ #1 LABOJUMS: Sadala changed/unchanged servera pusē
            const previousFile = previousPaths[file.path];

            if (
                previousFile &&
                previousFile.hash === file.hash &&
                validateArweaveId(previousFile.id || previousFile.zipId)
            ) {
                unchangedFiles[file.path] = {
                    id: previousFile.id || previousFile.zipId,
                    hash: file.hash
                };
            } else {
                changedFileMetadata.push({
                    path: file.path,
                    hash: file.hash,
                    size: file.size
                });
            }

            totalBytes += file.size;

            await writeNdjson(res, {
                type: 'file',
                file
            });
        });

        // ✅ Job satur TIKAI metadata (bez base64 satura)
        // ✅ #1 LABOJUMS: changedFileMetadata satur TIKAI changed failus
        const job = {
            version: 7,
            jobId,
            githubUser,
            repoName,
            fullRepoName,
            githubRepositoryId: String(archive.repository.id),
            githubDefaultBranch: archive.repository.defaultBranch,
            githubCommitSha: archive.commitSha,
            githubTreeSha: archive.treeSha,
            walletAddress: normalizedWallet,
            tokenId: tokenId.toString(),
            onChainBackupCount: backupCount.toString(),
            lastManifest: lastManifest || null,
            lastMerkleRoot: lastMerkleRoot || null,
            // ✅ TIKAI changed failu metadata
            changedFileMetadata,
            unchangedFiles,
            status: 'prepared',
            zipTxId: null,
            zipIv: null,
            zipMerkleRoot: null,
            manifestTxId: null,
            manifest: null,
            backupNumber: null,
            manifestHash: null,
            merkleRoot: null,
            manifestURI: null,
            deadline: null,
            backupTxHash: null,
            completionTxHash: null,
            createdAt: now,
            updatedAt: now
        };

        await createJob(jobId, job, JOB_TTL_SECONDS);

        await writeNdjson(res, {
            type: 'complete',
            success: true,
            jobId,
            repoName: fullRepoName,
            githubRepositoryId: String(archive.repository.id),
            githubDefaultBranch: archive.repository.defaultBranch,
            githubCommitSha: archive.commitSha,
            githubTreeSha: archive.treeSha,
            tokenId: tokenId.toString(),
            backupCount: backupCount.toString(),
            lastManifest: lastManifest || null,
            lastMerkleRoot: lastMerkleRoot || null,
            fileCount: jobFiles.length,
            changedFileCount: changedFileMetadata.length,
            unchangedFileCount: Object.keys(unchangedFiles).length,
            totalBytes
        });

        if (!res.writableEnded) {
            res.end();
        }
    } catch (error) {
        logSection('❌ BACKUP PREPARE ERROR');
        console.error(error);

        if (queueHeartbeat) {
            clearInterval(queueHeartbeat);
            queueHeartbeat = null;
        }

        if (streamStarted && !res.writableEnded && !res.destroyed) {
            try {
                await writeNdjson(res, {
                    type: 'error',
                    success: false,
                    error: errorMessage(error)
                });
            } catch {}

            if (!res.writableEnded) {
                res.end();
            }
            return;
        }

        const status = /abonements nav aktīvs/i.test(errorMessage(error)) ? 403 : 500;

        if (!res.headersSent) {
            return res.status(status).json({
                success: false,
                error: errorMessage(error)
            });
        }
    } finally {
        if (queueHeartbeat) {
            clearInterval(queueHeartbeat);
        }

        if (!resourceLease && resourceQueueId) {
            backupResourceController.cancel(resourceQueueId);
        }

        if (archive?.zipfile) {
            try { archive.zipfile.close(); } catch {}
        }

        if (archive?.tempPath) {
            await fs.promises.unlink(archive.tempPath).catch(() => {});
        }

        if (resourceLease) {
            resourceLease.release();
            resourceLease = null;
        }

        res.off('close', onResponseClose);
    }
});

// =============================================================================
// Job status — browser reload recovery
// =============================================================================

app.get('/api/job-status', async (req, res) => {
    try {
        if (!requireGithubSession(req, res)) return;

        const { jobId } = req.query;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        const job = await getJob(jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'Job nav atrasts vai ir beidzies.'
            });
        }

        await verifyJobAuthorization(req, job);

        // ✅ Drošā versija: iegūst on-chain backupCount tikai ja tokenId eksistē
        let backupCount = null;

        if (job.tokenId != null) {
            try {
                const provider = getProvider();
                const nftContract = new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

                const onChainBackupCount = await nftContract.getBackupCount(
                    BigInt(job.tokenId)
                );

                backupCount = onChainBackupCount.toString();
            } catch (rpcError) {
                console.warn('Neizdevās iegūt on-chain backupCount:', rpcError);
                backupCount = null;
            }
        }

        // ✅ Atgriež metadata (bez base64 satura)
        return res.json({
            success: true,
            jobId: job.jobId,
            status: job.status,
            repoName: job.repoName,
            fullRepoName: job.fullRepoName,
            tokenId: job.tokenId,
            walletAddress: job.walletAddress,
            zipTxId: job.zipTxId || null,
            zipIv: job.zipIv || null,
            zipMerkleRoot: job.zipMerkleRoot || null,
            manifestTxId: job.manifestTxId || null,
            backupCount,
            backupNumber: job.backupNumber || null,
            manifestHash: job.manifestHash || null,
            merkleRoot: job.merkleRoot || null,
            manifestURI: job.manifestURI || null,
            lastManifest: job.lastManifest || null,
            lastMerkleRoot: job.lastMerkleRoot || null,
            deadline: job.deadline || null,
            backupTxHash: job.backupTxHash || null,
            completionTxHash: job.completionTxHash || null,
            changedFileMetadata: job.changedFileMetadata || [],
            unchangedFiles: job.unchangedFiles || {},
            error: job.error || null,
            failedAt: job.failedAt || null
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nepieder/i.test(message) ? 404 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// ZIP upload state transitions
// =============================================================================

app.post('/api/start-zip-upload', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            if (job.status === 'prepared') {
                await updateJob(jobId, {
                    status: 'zip-uploading',
                    zipUploadStartedAt: Date.now(),
                    updatedAt: Date.now()
                }, JOB_TTL_SECONDS);
            } else if (job.status !== 'zip-uploading') {
                throw new Error(
                    `Nevar sākt ZIP augšupielādi no statusa: ${job.status}`
                );
            }

            return res.json({
                success: true,
                status: 'zip-uploading'
            });
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            error: errorMessage(error)
        });
    }
});

app.post('/api/save-zip-tx', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId, zipTxId, iv, merkleRoot } = req.body;

        validateJobTxInput(jobId, zipTxId);

        // IV validācija (ja padots)
        let normalizedIV = null;
        if (iv !== undefined && iv !== null) {
            if (!Array.isArray(iv) || iv.length !== 12) {
                return res.status(400).json({
                    success: false,
                    error: 'Nederīgs IV (jābūt 12 baitu masīvam).'
                });
            }
            normalizedIV = iv.map(b => Number(b) & 0xff);
        }

        // Merkle root validācija (ja padots)
        let normalizedMerkleRoot = null;
        if (merkleRoot !== undefined && merkleRoot !== null) {
            if (
                typeof merkleRoot !== 'string' ||
                !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Nederīgs Merkle root.'
                });
            }
            normalizedMerkleRoot = merkleRoot;
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            // ✅ Idempotence
            if (
                job.status === 'zip-uploaded' ||
                job.status === 'manifest-uploading' ||
                job.status === 'manifest-uploaded' ||
                job.status === 'blockchain-finalizing' ||
                job.status === 'completed'
            ) {
                if (job.zipTxId === zipTxId) {
                    return res.json({
                        success: true,
                        idempotent: true,
                        status: job.status
                    });
                }
                throw new Error(
                    `Nevar mainīt ZIP pēc statusa: ${job.status}.`
                );
            }

            if (job.status !== 'zip-uploading') {
                throw new Error(
                    `ZIP var saglabāt tikai no 'zip-uploading' statusa, nevis '${job.status}'`
                );
            }

            await updateJob(jobId, {
                zipTxId,
                zipIv: normalizedIV,
                zipMerkleRoot: normalizedMerkleRoot,
                status: 'zip-uploaded',
                zipUploadedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            return res.json({
                success: true,
                status: 'zip-uploaded'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nevar mainīt|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// Manifest upload state transitions
// =============================================================================

app.post('/api/start-manifest-upload', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            if (job.status === 'zip-uploaded') {
                await updateJob(jobId, {
                    status: 'manifest-uploading',
                    manifestUploadStartedAt: Date.now(),
                    updatedAt: Date.now()
                }, JOB_TTL_SECONDS);
            } else if (job.status !== 'manifest-uploading') {
                throw new Error(
                    `Nevar sākt manifesta augšupielādi no statusa: ${job.status}`
                );
            }

            return res.json({
                success: true,
                status: 'manifest-uploading'
            });
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            error: errorMessage(error)
        });
    }
});

app.post('/api/save-manifest-tx', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId, manifestTxId, manifest } = req.body;

        validateJobTxInput(jobId, manifestTxId);
        validateManifest(manifest);

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            if (!job.zipTxId) {
                throw new Error('ZIP transakcija vēl nav saglabāta.');
            }

            // ✅ Idempotence
            if (
                job.status === 'manifest-uploaded' ||
                job.status === 'blockchain-finalizing' ||
                job.status === 'completed'
            ) {
                if (job.manifestTxId === manifestTxId) {
                    return res.json({
                        success: true,
                        idempotent: true,
                        status: job.status
                    });
                }
                throw new Error(
                    `Nevar mainīt manifestu pēc statusa: ${job.status}.`
                );
            }

            if (job.status !== 'manifest-uploading') {
                throw new Error(
                    `Manifestu var saglabāt tikai no 'manifest-uploading' statusa, nevis '${job.status}'`
                );
            }

            if (manifest.archive?.id !== job.zipTxId) {
                throw new Error(
                    'Manifesta archive ID nesakrīt ar ZIP transakciju.'
                );
            }

            await updateJob(jobId, {
                manifestTxId,
                manifest,
                status: 'manifest-uploaded',
                manifestUploadedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            return res.json({
                success: true,
                status: 'manifest-uploaded'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nevar mainīt|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// Blockchain finalization state transitions
// =============================================================================

app.post('/api/start-blockchain-finalize', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const {
            jobId,
            backupNumber,
            manifestHash,
            merkleRoot,
            manifestURI,
            deadline
        } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        if (
            backupNumber === undefined ||
            !/^\d+$/.test(String(backupNumber))
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs backup number.'
            });
        }

        if (
            typeof manifestHash !== 'string' ||
            !/^0x[0-9a-fA-F]{64}$/.test(manifestHash)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs manifest hash.'
            });
        }

        if (
            typeof merkleRoot !== 'string' ||
            !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs Merkle root.'
            });
        }

        if (
            typeof manifestURI !== 'string' ||
            !manifestURI.startsWith('ar://')
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs manifest URI.'
            });
        }

        if (
            deadline === undefined ||
            !/^\d+$/.test(String(deadline))
        ) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs deadline.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            if (job.status !== 'manifest-uploaded') {
                throw new Error(
                    `Nevar sākt blockchain finalizāciju no statusa: ${job.status}`
                );
            }

            if (!job.zipTxId || !job.manifestTxId) {
                throw new Error('ZIP vai manifests vēl nav saglabāts.');
            }

            if (job.manifest?.archive?.id !== job.zipTxId) {
                throw new Error('Manifesta archive ID nesakrīt ar ZIP.');
            }

            const expectedManifestURI = `ar://${job.manifestTxId}`;
            if (manifestURI !== expectedManifestURI) {
                throw new Error(
                    `Manifest URI nesakrīt: sagaidīts ${expectedManifestURI}, saņemts ${manifestURI}`
                );
            }

            const expectedManifestHash = ethers.keccak256(
                ethers.toUtf8Bytes(manifestURI)
            );

            if (expectedManifestHash.toLowerCase() !== manifestHash.toLowerCase()) {
                throw new Error('Manifest hash nesakrīt ar manifest URI.');
            }

            const provider = getProvider();
            const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
            const onChainBackupCount = await nftContract.getBackupCount(
                BigInt(job.tokenId)
            );

            const expectedBackupNumber = (onChainBackupCount + 1n).toString();

            if (String(backupNumber) !== expectedBackupNumber) {
                throw new Error(
                    `Backup number nesakrīt: sagaidīts ${expectedBackupNumber}, saņemts ${backupNumber}`
                );
            }

            await updateJob(jobId, {
                status: 'blockchain-finalizing',
                backupNumber: String(backupNumber),
                manifestHash,
                merkleRoot,
                manifestURI,
                deadline: String(deadline),
                blockchainFinalizeStartedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            return res.json({
                success: true,
                status: 'blockchain-finalizing'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

app.post('/api/save-backup-tx', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId, txHash } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        if (!validateTxHash(txHash)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs transakcijas hash.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            if (job.status !== 'blockchain-finalizing') {
                throw new Error(
                    `Nevar saglabāt backup tx no statusa: ${job.status}`
                );
            }

            // ✅ Idempotence
            if (job.backupTxHash) {
                if (job.backupTxHash === txHash) {
                    return res.json({
                        success: true,
                        idempotent: true,
                        status: job.status
                    });
                }
                throw new Error(
                    'Backup transakcijas hash jau ir saglabāts.'
                );
            }

            await updateJob(jobId, {
                backupTxHash: txHash,
                backupTxSubmittedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            return res.json({
                success: true,
                status: 'blockchain-finalizing'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

app.post('/api/complete-backup', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId, txHash } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        if (!validateTxHash(txHash)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs transakcijas hash.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);
            const wallet = await verifyJobAuthorization(req, job);

            await verifyJobNFTAuthorization({
                ...job,
                walletAddress: wallet
            });

            // ✅ Idempotence
            if (job.status === 'completed') {
                if (job.completionTxHash === txHash) {
                    return res.json({
                        success: true,
                        status: 'completed',
                        alreadyCompleted: true
                    });
                }
                throw new Error(
                    'Job jau ir completed ar citu transakcijas hash.'
                );
            }

            if (job.status !== 'blockchain-finalizing') {
                throw new Error(
                    `Nevar pabeigt backup no statusa: ${job.status}`
                );
            }

            if (job.backupTxHash && job.backupTxHash !== txHash) {
                throw new Error(
                    'Transakcijas hash nesakrīt ar saglabāto backup tx hash.'
                );
            }

            const provider = getProvider();
            let receipt;

            try {
                receipt = await provider.getTransactionReceipt(txHash);
            } catch {
                throw new Error('Neizdevās iegūt transakcijas receipt.');
            }

            if (!receipt) {
                throw new Error('Transakcija vēl nav apstiprināta.');
            }

            if (receipt.status !== 1) {
                throw new Error('Transakcija neizdevās.');
            }

            if (receipt.to?.toLowerCase() !== NFT_ADDRESS.toLowerCase()) {
                throw new Error('Transakcija nav uz NFT līgumu.');
            }

            if (receipt.from?.toLowerCase() !== wallet.toLowerCase()) {
                throw new Error('Transakcija nav no backup maka.');
            }

            // ✅ Pārbauda BackupAdded event no receipt logs
            const iface = new ethers.Interface(BACKUP_ADDED_EVENT_ABI);
            let backupAddedEvent = null;

            for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== NFT_ADDRESS.toLowerCase()) {
                    continue;
                }
                
                try {
                    const parsed = iface.parseLog(log);
                    if (parsed && parsed.name === 'BackupAdded') {
                        backupAddedEvent = parsed;
                        break;
                    }
                } catch {}
            }

            if (!backupAddedEvent) {
                throw new Error(
                    'Transakcijā nav atrasts BackupAdded event.'
                );
            }

            // ✅ Salīdzina event ar Redis job
            if (backupAddedEvent.args.tokenId.toString() !== String(job.tokenId)) {
                throw new Error('BackupAdded tokenId nesakrīt.');
            }

            if (backupAddedEvent.args.backupNumber.toString() !== String(job.backupNumber)) {
                throw new Error('BackupAdded backupNumber nesakrīt.');
            }

            if (backupAddedEvent.args.manifestHash.toLowerCase() !== job.manifestHash.toLowerCase()) {
                throw new Error('BackupAdded manifestHash nesakrīt.');
            }

            if (backupAddedEvent.args.merkleRoot.toLowerCase() !== job.merkleRoot.toLowerCase()) {
                throw new Error('BackupAdded merkleRoot nesakrīt.');
            }

            if (backupAddedEvent.args.manifestURI !== job.manifestURI) {
                throw new Error('BackupAdded manifestURI nesakrīt.');
            }

            await updateJob(jobId, {
                status: 'completed',
                completionTxHash: txHash,
                completedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            logSection('✅ BACKUP COMPLETED');
            logInfo('Job ID', jobId);
            logInfo('Tx Hash', txHash);
            logInfo('Token ID', job.tokenId);
            logInfo('Backup Number', job.backupNumber);
            logInfo('Merkle Root', job.merkleRoot);

            return res.json({
                success: true,
                status: 'completed',
                jobId,
                txHash
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nav saglabāts|neizdevās|nav apstiprināta|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// Failed / Retry
// =============================================================================

app.post('/api/fail-backup', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId, error: jobError } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);

            await verifyJobAuthorization(req, job);

            if (job.status === 'completed') {
                return res.json({
                    success: true,
                    alreadyCompleted: true,
                    status: 'completed'
                });
            }

            if (job.status === 'failed') {
                return res.json({
                    success: true,
                    idempotent: true,
                    status: 'failed'
                });
            }

            // ✅ Neļauj failed no blockchain-finalizing ar backupTxHash
            if (
                job.status === 'blockchain-finalizing' &&
                job.backupTxHash
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Blockchain transaction exists — recovery required, not failed.',
                    recoveryRequired: true,
                    backupTxHash: job.backupTxHash
                });
            }

            await updateJob(jobId, {
                status: 'failed',
                error: String(jobError || 'Unknown error').substring(0, 500),
                failedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            logSection('⚠️ BACKUP FAILED');
            logInfo('Job ID', jobId);
            logInfo('Error', jobError);

            return res.json({
                success: true,
                status: 'failed'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nepieder|nederīgs|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

app.post('/api/retry-backup', backupLimiter, async (req, res) => {
    try {
        assertSameOrigin(req);
        if (!requireGithubSession(req, res)) return;

        const { jobId } = req.body;

        if (!validateJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs job ID.'
            });
        }

        return await withJobLock(jobId, async () => {
            const job = await getJob(jobId);

            await verifyJobAuthorization(req, job);

            if (job.status !== 'failed') {
                throw new Error(
                    `Retry iespējams tikai no 'failed' statusa, nevis '${job.status}'`
                );
            }

            await updateJob(jobId, {
                status: 'prepared',
                error: null,
                failedAt: null,
                zipTxId: null,
                zipIv: null,
                zipMerkleRoot: null,
                manifestTxId: null,
                manifest: null,
                backupNumber: null,
                manifestHash: null,
                merkleRoot: null,
                manifestURI: null,
                deadline: null,
                backupTxHash: null,
                completionTxHash: null,
                retriedAt: Date.now(),
                updatedAt: Date.now()
            }, JOB_TTL_SECONDS);

            logSection('🔄 BACKUP RETRY');
            logInfo('Job ID', jobId);

            return res.json({
                success: true,
                status: 'prepared'
            });
        });
    } catch (error) {
        const message = errorMessage(error);
        const status = /nav atrasts|nav github|nepieder|nederīgs|nederīga state/i.test(message) ? 400 : 500;

        return res.status(status).json({
            success: false,
            error: message
        });
    }
});

// =============================================================================
// Health check
// =============================================================================

app.get('/api/health', async (req, res) => {
    return res.json({
        success: true,
        redis: Boolean(redisClient),
        rpc: Boolean(RPC_URL),
        nft: Boolean(NFT_ADDRESS),
        subscription: Boolean(SUBSCRIPTION_ADDRESS),
        github: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_REDIRECT_URI),
        turboUpload: Boolean(TURBO_UPLOAD_URL),
        turboPayment: Boolean(TURBO_PAYMENT_URL),
        mintAuthorization: Boolean(MINT_AUTHORIZATION_SIGNER_PRIVATE_KEY)
    });
});

// =============================================================================
// Frontend fallback
// =============================================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    logSection('🚀 PermRepo server started');

    logInfo('Port', PORT);
    logInfo('Chain ID', CHAIN_ID);
    logInfo('Max repo files', MAX_REPO_FILES);
    logInfo('Max repo bytes', MAX_REPO_BYTES);
    logInfo('Max file bytes', MAX_FILE_BYTES);
    logInfo('Max ZIP bytes', MAX_ZIP_BYTES);
    logInfo('Resource memory budget', `${Math.round(RESOURCE_MEMORY_BUDGET_RATIO * 100)}% (${backupResourceController.memoryBudgetBytes} bytes)`);
    logInfo('Resource memory multiplier', RESOURCE_MEMORY_MULTIPLIER);
    logInfo('Max backup queue', MAX_BACKUP_QUEUE);
    logInfo('Lock heartbeat', `${LOCK_HEARTBEAT_MS}ms`);
    logInfo('Job TTL', `${JOB_TTL_SECONDS}s (${JOB_TTL_SECONDS / 3600}h)`);
    logInfo('Redis', '✅ IR');
    logInfo('RPC', RPC_URL);
    logInfo('NFT', NFT_ADDRESS || '❌ NAV');
    logInfo('Subscription', SUBSCRIPTION_ADDRESS || '❌ NAV');
    logInfo('Turbo Upload', TURBO_UPLOAD_URL || '❌ NAV');
    logInfo('Turbo Payment', TURBO_PAYMENT_URL || '❌ NAV');
    logInfo('Mint authorization signer', mintAuthorizationSigner.address);

    console.log('='.repeat(60) + '\n');
});
