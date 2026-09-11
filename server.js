// server.js - Express API
// PermRepo backend: GitHub OAuth + repo preparation + Redis job state.
// Nav privātas blockchain/Turbo atslēgas, nav server-side Turbo maksājumu wallet.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import JSZip from 'jszip';

import {
    initRedis,
    getRedis,
    createJob,
    getJob,
    updateJob,
    acquireJobLock,
    releaseJobLock
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

const MAX_REPO_FILES = Number(process.env.MAX_REPO_FILES || 5000);
const MAX_REPO_BYTES = Number(process.env.MAX_REPO_BYTES || 524288000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 104857600);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || 3600);
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 3600);
const DOWNLOAD_CONCURRENCY = 3;
const MAX_GITHUB_REPO_PAGES = 10;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

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

if (!Number.isInteger(MAX_REPO_FILES) || MAX_REPO_FILES <= 0) {
    console.error('❌ MAX_REPO_FILES ir nederīgs!');
    process.exit(1);
}

if (!Number.isSafeInteger(MAX_REPO_BYTES) || MAX_REPO_BYTES <= 0) {
    console.error('❌ MAX_REPO_BYTES ir nederīgs!');
    process.exit(1);
}

if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES <= 0 || MAX_FILE_BYTES > MAX_REPO_BYTES) {
    console.error('❌ MAX_FILE_BYTES ir nederīgs!');
    process.exit(1);
}

initRedis();

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
}

function logInfo(label, value) {
    const safeValue = String(value).replace(/[\r\n\t]/g, ' ').substring(0, 100);
    console.log(`   ${label}: ${safeValue}`);
}

function errorMessage(error) {
    if (error && typeof error.message === 'string') return error.message.substring(0, 300);
    return 'Nezināma kļūda.';
}

function parseChainId(value) {
    if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
        return Number.parseInt(value, 16);
    }
    return Number(value);
}

const EXPECTED_CHAIN_ID = parseChainId(CHAIN_ID);

if (!Number.isInteger(EXPECTED_CHAIN_ID) || EXPECTED_CHAIN_ID <= 0) {
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
    return typeof jobId === 'string' && /^[a-f0-9-]{20,100}$/i.test(jobId);
}

function validateArweaveId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(id);
}

function githubOwnerHash(login) {
    return ethers.keccak256(ethers.toUtf8Bytes(login));
}

function repositoryHash(fullRepoName) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName])
    );
}

function getProvider() {
    return new ethers.JsonRpcProvider(RPC_URL, EXPECTED_CHAIN_ID);
}

const NFT_ABI = [
    'function repositoryTokens(bytes32 repoHash) external view returns (uint256)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function getBackupCount(uint256 tokenId) external view returns (uint256)',
    'function getManifestURI(uint256 tokenId) external view returns (string)',
    'function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)'
];

const SUBSCRIPTION_ABI = [
    'function isSubscribed(bytes32 githubHash) external view returns (bool)',
    'function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)',
    'function getRemainingTime(bytes32 githubHash) external view returns (uint256)',
    'function subscriptionPrice() external view returns (uint256)'
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
            if (value) origins.add(new URL(value).origin);
        } catch {
            // Invalid optional public config is reported by /api/config consumers.
        }
    }

    return [...origins].join(' ');
}

async function withJobLock(jobId, fn) {
    const token = await acquireJobLock(jobId);

    if (!token) {
        throw new Error('Job jau tiek apstrādāts.');
    }

    try {
        return await fn();
    } finally {
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

    key(sid) {
        return `permrepo:session:${sid}`;
    }

    get(sid, callback) {
        this.redis.get(this.key(sid))
            .then(value => {
                if (!value) return callback(null, null);

                if (typeof value === 'object') {
                    return callback(null, value);
                }

                return callback(null, JSON.parse(String(value)));
            })
            .catch(error => callback(error));
    }

    set(sid, sess, callback = () => {}) {
        this.redis
            .set(
                this.key(sid),
                JSON.stringify(sess),
                { ex: this.ttlSeconds }
            )
            .then(() => callback(null))
            .catch(error => callback(error));
    }

    destroy(sid, callback = () => {}) {
        this.redis
            .del(this.key(sid))
            .then(() => callback(null))
            .catch(error => callback(error));
    }

    touch(sid, sess, callback = () => {}) {
        this.redis
            .expire(this.key(sid), this.ttlSeconds)
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

// ✅ LABOTS: CSP ar 'wasm-unsafe-eval' — nepieciešams Turbo SDK WASM moduļiem
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

    res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
    );

    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    res.setHeader(
        'X-Frame-Options',
        'DENY'
    );

    res.setHeader(
        'Referrer-Policy',
        'strict-origin-when-cross-origin'
    );

    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()'
    );

    next();
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new UpstashSessionStore(
        redisClient,
        SESSION_TTL_SECONDS
    ),
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
    message: {
        success: false,
        error: 'Pārāk daudz GitHub operāciju — mēģini vēlāk.'
    },
    keyGenerator: req => req.session.githubUser || req.ip
});

const backupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Pārāk daudz backup operāciju — mēģini vēlāk.'
    },
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
                setTimeout(
                    resolve,
                    this.minInterval - timeSinceLast
                )
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
        const response = await githubRateLimiterInstance.makeRequest(
            url,
            options
        );

        lastStatus = response.status;

        if (response.status === 401) {
            throw new Error('GitHub autorizācija ir beigusies.');
        }

        if (response.status === 403 || response.status === 429) {
            const retryAfterHeader = response.headers.get('retry-after');

            const retryAfter = retryAfterHeader
                ? Number(retryAfterHeader) * 1000
                : 0;

            const backoff = retryAfter > 0
                ? retryAfter
                : Math.pow(2, attempt) * 1000;

            if (attempt < retries - 1) {
                await new Promise(resolve =>
                    setTimeout(
                        resolve,
                        Math.min(backoff, 30000)
                    )
                );

                continue;
            }
        }

        if (!response.ok) {
            throw new Error(
                `GitHub API kļūda: ${response.status}`
            );
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

async function getGitHubRepository(
    githubToken,
    owner,
    repo
) {
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
        throw new Error(
            'GitHub repo dati nav derīgi.'
        );
    }

    if (data.archived) {
        throw new Error(
            'Arhivēts GitHub repozitorijs nav pieejams backupam.'
        );
    }

    if (
        typeof data.id !== 'number' ||
        !Number.isSafeInteger(data.id)
    ) {
        throw new Error(
            'GitHub repo ID nav derīgs.'
        );
    }

    if (
        typeof data.default_branch !== 'string' ||
        !data.default_branch
    ) {
        throw new Error(
            'GitHub default branch nav atrasts.'
        );
    }

    const canonicalOwner = data.owner?.login;
    const fullName = data.full_name;

    if (
        canonicalOwner !== owner ||
        fullName !== `${owner}/${repo}`
    ) {
        throw new Error(
            'GitHub repozitorija identitāte nesakrīt ar autorizēto lietotāju.'
        );
    }

    return {
        id: data.id,
        fullName,
        defaultBranch: data.default_branch,
        private: Boolean(data.private)
    };
}

async function getBranchCommitSha(
    githubToken,
    owner,
    repo,
    branch
) {
    const url =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `git/ref/heads/` +
        `${encodeURIComponent(branch)}`;

    const response = await fetchWithRetry(
        url,
        {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }
    );

    const data = await response.json();

    const sha = data?.object?.sha;

    if (
        !sha ||
        !/^[0-9a-f]{40}$/i.test(sha)
    ) {
        throw new Error(
            'GitHub branch commit SHA nav derīgs.'
        );
    }

    return sha;
}

async function getGitTree(
    githubToken,
    owner,
    repo,
    ref
) {
    const encodedRef = encodeURIComponent(ref);

    const url =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `git/trees/${encodedRef}?recursive=1`;

    const response = await fetchWithRetry(
        url,
        {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }
    );

    const data = await response.json();

    if (
        !data ||
        !Array.isArray(data.tree)
    ) {
        throw new Error(
            'GitHub Git Tree dati nav derīgi.'
        );
    }

    if (data.truncated) {
        throw new Error(
            'GitHub repozitorijs ir pārāk liels, lai to droši nolasītu vienā Git Tree pieprasījumā.'
        );
    }

    const blobs = data.tree.filter(
        item => item.type === 'blob'
    );

    if (blobs.length > MAX_REPO_FILES) {
        throw new Error(
            `Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`
        );
    }

    return {
        sha: data.sha || null,
        blobs
    };
}

async function getRepoFiles(
    githubToken,
    owner,
    repo,
    defaultBranch
) {
    const repository = await getGitHubRepository(
        githubToken,
        owner,
        repo
    );

    const commitSha = await getBranchCommitSha(
        githubToken,
        owner,
        repo,
        defaultBranch
    );

    const tree = await getGitTree(
        githubToken,
        owner,
        repo,
        commitSha
    );

    if (tree.blobs.length === 0) {
        return {
            repository,
            treeSha: tree.sha,
            files: [],
            totalBytes: 0
        };
    }

    // GitHub zipball ļauj iegūt visu repo vienā authenticated pieprasījumā,
    // nevis veikt vienu API request par katru failu. Tas novērš 1000 ierakstu
    // Contents API limitu un neizdedzina GitHub API rate limitu lieliem repo.

    const zipUrl =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `zipball/${encodeURIComponent(commitSha)}`;

    const response = await fetchWithRetry(
        zipUrl,
        {
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }
    );

    const archiveBuffer = Buffer.from(
        await response.arrayBuffer()
    );

    const zip = await JSZip.loadAsync(
        archiveBuffer,
        {
            checkCRC32: true
        }
    );

    const entries = Object.values(zip.files)
        .filter(entry => !entry.dir);

    if (entries.length !== tree.blobs.length) {
        // GitHub archive var saturēt īpašus ierakstus citādi nekā Git Tree.
        // Drošības labad neizveidojam backup no potenciāli nepilna failu komplekta.

        throw new Error(
            'GitHub repo arhīva failu skaits nesakrīt ar Git Tree.'
        );
    }

    if (entries.length > MAX_REPO_FILES) {
        throw new Error(
            `Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`
        );
    }

    const treeByPath = new Map(
        tree.blobs.map(blob => [
            blob.path,
            blob
        ])
    );

    const files = [];
    let totalBytes = 0;

    for (const entry of entries) {
        const parts = entry.name.split('/');

        const filePath =
            parts.length > 1
                ? parts.slice(1).join('/')
                : parts[0];

        const treeEntry = treeByPath.get(
            filePath
        );

        if (!treeEntry) {
            throw new Error(
                `GitHub arhīvā nav atrasts fails: ${filePath}`
            );
        }

        const fileBuffer = await entry.async(
            'nodebuffer'
        );

        if (fileBuffer.length > MAX_FILE_BYTES) {
            throw new Error(
                `Fails ${filePath} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`
            );
        }

        totalBytes += fileBuffer.length;

        if (totalBytes > MAX_REPO_BYTES) {
            throw new Error(
                `Repo pārsniedz maksimālo izmēru (${MAX_REPO_BYTES} bytes).`
            );
        }

        files.push({
            path: filePath,
            size: fileBuffer.length,
            content: fileBuffer.toString('base64'),
            hash: crypto
                .createHash('sha256')
                .update(fileBuffer)
                .digest('hex')
        });
    }

    files.sort(
        (a, b) =>
            a.path.localeCompare(b.path)
    );

    return {
        repository,
        commitSha,
        treeSha: tree.sha,
        files,
        totalBytes
    };
}

async function verifySubscription(
    githubUser
) {
    if (!SUBSCRIPTION_ADDRESS) {
        throw new Error(
            'Subscription kontrakts nav konfigurēts.'
        );
    }

    const provider = getProvider();

    const contract = new ethers.Contract(
        SUBSCRIPTION_ADDRESS,
        SUBSCRIPTION_ABI,
        provider
    );

    const githubHash =
        githubOwnerHash(githubUser);

    const isSubscribed =
        await contract.isSubscribed(
            githubHash
        );

    if (!isSubscribed) {
        throw new Error(
            'Abonements nav aktīvs.'
        );
    }

    return true;
}

async function verifyJobAuthorization(
    req,
    job
) {
    if (!job) {
        throw new Error(
            'Backup jobs nav atrasts vai ir beidzies.'
        );
    }

    if (
        !req.session.githubUser ||
        !req.session.githubToken
    ) {
        throw new Error(
            'Nav GitHub autorizācijas.'
        );
    }

    if (
        req.session.githubUser !==
        job.githubUser
    ) {
        throw new Error(
            'Backup jobs nepieder šim GitHub lietotājam.'
        );
    }

    const requestWallet =
        safeWallet(job.walletAddress);

    if (!requestWallet) {
        throw new Error(
            'Job wallet ir nederīgs.'
        );
    }

    return requestWallet;
}

async function verifyJobNFTAuthorization(
    job,
    walletAddress
) {
    if (!NFT_ADDRESS) {
        throw new Error(
            'NFT kontrakts nav konfigurēts.'
        );
    }

    if (
        !job.tokenId ||
        !/^\d+$/.test(
            String(job.tokenId)
        )
    ) {
        throw new Error(
            'Job NFT token ID nav derīgs.'
        );
    }

    const provider = getProvider();

    const nftContract = new ethers.Contract(
        NFT_ADDRESS,
        NFT_ABI,
        provider
    );

    const owner =
        await nftContract.ownerOf(
            BigInt(job.tokenId)
        );

    if (
        owner.toLowerCase() !==
        walletAddress.toLowerCase()
    ) {
        throw new Error(
            'NFT vairs nepieder backup makam.'
        );
    }

    return owner;
}

function assertSameOrigin(req) {
    const origin = req.get('origin');

    if (origin) {
        const host = req.get('host');
        const expected =
            `${req.protocol}://${host}`;

        if (origin !== expected) {
            throw new Error(
                'Nederīgs pieprasījuma origin.'
            );
        }
    }

    const referer = req.get('referer');

    if (!origin && referer) {
        try {
            const refererUrl =
                new URL(referer);

            const expected =
                `${req.protocol}://${req.get('host')}`;

            if (
                refererUrl.origin !==
                expected
            ) {
                throw new Error(
                    'Nederīgs pieprasījuma referer.'
                );
            }
        } catch {
            throw new Error(
                'Nederīgs pieprasījuma avots.'
            );
        }
    }
}

function validateJobTxInput(
    jobId,
    txId
) {
    if (!validateJobId(jobId)) {
        throw new Error(
            'Nederīgs jobId.'
        );
    }

    if (!validateArweaveId(txId)) {
        throw new Error(
            'Nederīgs Arweave/Turbo transakcijas ID.'
        );
    }
}

function validateManifest(manifest) {
    if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest)
    ) {
        throw new Error(
            'Manifests nav derīgs objekts.'
        );
    }

    const serialized =
        JSON.stringify(manifest);

    if (
        !serialized ||
        Buffer.byteLength(
            serialized,
            'utf8'
        ) > MAX_MANIFEST_BYTES
    ) {
        throw new Error(
            'Manifests pārsniedz atļauto izmēru.'
        );
    }

    if (
        manifest.manifest !==
            'arweave/paths' ||
        manifest.version !==
            '0.2.0'
    ) {
        throw new Error(
            'Neatbalstīts manifesta formāts.'
        );
    }

    if (
        !manifest.paths ||
        typeof manifest.paths !==
            'object' ||
        Array.isArray(manifest.paths)
    ) {
        throw new Error(
            'Manifesta paths nav derīgs objekts.'
        );
    }

    for (
        const [filePath, info]
        of Object.entries(manifest.paths)
    ) {
        if (
            typeof filePath !== 'string' ||
            filePath.length === 0 ||
            filePath.length > 1000
        ) {
            throw new Error(
                'Manifests satur nederīgu faila ceļu.'
            );
        }

        if (
            !info ||
            typeof info !== 'object' ||
            !validateArweaveId(info.id) ||
            !/^[0-9a-fA-F]{64}$/.test(
                info.hash
            )
        ) {
            throw new Error(
                'Manifests satur nederīgu faila ierakstu.'
            );
        }
    }

    return manifest;
}

// -----------------------------------------------------------------------------
// GitHub OAuth
// -----------------------------------------------------------------------------

app.get(
    '/api/github/login',
    (req, res) => {
        if (
            !GITHUB_CLIENT_ID ||
            !GITHUB_REDIRECT_URI
        ) {
            return res.status(500).json({
                success: false,
                error: 'GitHub OAuth nav konfigurēts.'
            });
        }

        const state =
            createOAuthState();

        req.session.oauthState =
            state;

        const scope =
            'repo';

        const params =
            new URLSearchParams({
                client_id:
                    GITHUB_CLIENT_ID,
                scope,
                redirect_uri:
                    GITHUB_REDIRECT_URI,
                state
            });

        return res.redirect(
            `https://github.com/login/oauth/authorize?${params.toString()}`
        );
    }
);

app.get(
    '/api/github/callback',
    async (req, res) => {
        const {
            code,
            state
        } = req.query;

        if (
            typeof code !== 'string' ||
            !code
        ) {
            return res.redirect(
                '/?error=no_code'
            );
        }

        const expectedState =
            req.session.oauthState;

        delete req.session.oauthState;

        if (
            typeof state !== 'string' ||
            typeof expectedState !== 'string'
        ) {
            return res.redirect(
                '/?error=oauth_state'
            );
        }

        const suppliedBuffer =
            Buffer.from(state);

        const expectedBuffer =
            Buffer.from(expectedState);

        if (
            suppliedBuffer.length !==
                expectedBuffer.length ||
            !crypto.timingSafeEqual(
                suppliedBuffer,
                expectedBuffer
            )
        ) {
            return res.redirect(
                '/?error=oauth_state'
            );
        }

        try {
            const tokenResponse =
                await fetch(
                    'https://github.com/login/oauth/access_token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json',
                            Accept:
                                'application/json'
                        },
                        body: JSON.stringify({
                            client_id:
                                GITHUB_CLIENT_ID,
                            client_secret:
                                GITHUB_CLIENT_SECRET,
                            code,
                            redirect_uri:
                                GITHUB_REDIRECT_URI
                        })
                    }
                );

            if (!tokenResponse.ok) {
                return res.redirect(
                    '/?error=token'
                );
            }

            const tokenData =
                await tokenResponse.json();

            if (
                !tokenData.access_token
            ) {
                return res.redirect(
                    '/?error=token'
                );
            }

            const userResponse =
                await fetch(
                    'https://api.github.com/user',
                    {
                        headers: {
                            Authorization:
                                `Bearer ${tokenData.access_token}`,
                            Accept:
                                'application/vnd.github+json',
                            'X-GitHub-Api-Version':
                                '2022-11-28'
                        }
                    }
                );

            if (!userResponse.ok) {
                return res.redirect(
                    '/?error=github_user'
                );
            }

            const userData =
                await userResponse.json();

            if (
                !userData.login ||
                !/^[a-zA-Z0-9-]{1,39}$/.test(
                    userData.login
                )
            ) {
                return res.redirect(
                    '/?error=github_user'
                );
            }

            req.session.regenerate(
                regenerateError => {
                    if (regenerateError) {
                        return res.redirect(
                            '/?error=session'
                        );
                    }

                    req.session.githubToken =
                        tokenData.access_token;

                    req.session.githubUser =
                        userData.login;

                    req.session.githubAvatar =
                        userData.avatar_url ||
                        null;

                    return res.redirect(
                        '/?auth=success'
                    );
                }
            );
        } catch {
            return res.redirect(
                '/?error=oauth'
            );
        }
    }
);

app.post(
    '/api/github/logout',
    (req, res) => {
        req.session.destroy(() => {
            res.clearCookie(
                'connect.sid',
                {
                    secure: true,
                    httpOnly: true,
                    sameSite: 'lax'
                }
            );

            res.json({
                success: true
            });
        });
    }
);

app.get(
    '/api/github/user',
    (req, res) => {
        if (req.session.githubUser) {
            return res.json({
                success: true,
                user:
                    req.session.githubUser,
                avatar:
                    req.session.githubAvatar ||
                    null
            });
        }

        return res.json({
            success: false
        });
    }
);

app.get(
    '/api/github/repos',
    githubApiLimiter,
    async (req, res) => {
        if (!requireGithubSession(req, res)) {
            return;
        }

        try {
            const repos = [];

            for (
                let page = 1;
                page <= MAX_GITHUB_REPO_PAGES;
                page++
            ) {
                const response =
                    await fetchWithRetry(
                        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`,
                        {
                            headers: {
                                Authorization:
                                    `Bearer ${req.session.githubToken}`,
                                Accept:
                                    'application/vnd.github+json',
                                'X-GitHub-Api-Version':
                                    '2022-11-28'
                            }
                        }
                    );

                const pageRepos =
                    await response.json();

                if (
                    !Array.isArray(pageRepos)
                ) {
                    throw new Error(
                        'GitHub repozitoriju saraksts nav derīgs.'
                    );
                }

                const ownedRepos =
                    pageRepos.filter(
                        repo =>
                            repo?.owner?.login ===
                            req.session.githubUser
                    );

                repos.push(
                    ...ownedRepos
                );

                if (
                    pageRepos.length < 100
                ) {
                    break;
                }
            }

            return res.json({
                success: true,
                repos
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

app.get(
    '/api/config',
    (req, res) => {
        return res.json({
            chainId: CHAIN_ID,
            nftAddress:
                NFT_ADDRESS,
            subscriptionAddress:
                SUBSCRIPTION_ADDRESS,
            usdcAddress:
                USDC_ADDRESS,
            arweaveGateway:
                ARWEAVE_GATEWAY,
            rpcUrl:
                RPC_URL,
            turboUploadUrl:
                TURBO_UPLOAD_URL,
            turboPaymentUrl:
                TURBO_PAYMENT_URL
        });
    }
);

app.get(
    '/api/subscription/status',
    async (req, res) => {
        try {
            if (
                !req.session.githubUser
            ) {
                return res.status(401).json({
                    success: false,
                    error:
                        'Nav GitHub autorizācijas'
                });
            }

            if (
                !SUBSCRIPTION_ADDRESS
            ) {
                return res.status(500).json({
                    success: false,
                    error:
                        'Subscription kontrakts nav konfigurēts.'
                });
            }

            const provider =
                getProvider();

            const subscriptionContract =
                new ethers.Contract(
                    SUBSCRIPTION_ADDRESS,
                    SUBSCRIPTION_ABI,
                    provider
                );

            const githubHash =
                githubOwnerHash(
                    req.session.githubUser
                );

            const [
                isSubscribed,
                expiry,
                remainingTime,
                price
            ] = await Promise.all([
                subscriptionContract.isSubscribed(
                    githubHash
                ),
                subscriptionContract.getSubscriptionExpiry(
                    githubHash
                ),
                subscriptionContract.getRemainingTime(
                    githubHash
                ),
                subscriptionContract.subscriptionPrice()
            ]);

            return res.json({
                success: true,
                isSubscribed,
                expiry:
                    expiry.toString(),
                remainingTime:
                    remainingTime.toString(),
                price:
                    price.toString(),
                githubUser:
                    req.session.githubUser
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

// -----------------------------------------------------------------------------
// Backup preparation.
// -----------------------------------------------------------------------------

app.post(
    '/api/prepare-backup',
    backupLimiter,
    async (req, res) => {
        try {
            assertSameOrigin(req);

            if (
                !requireGithubSession(
                    req,
                    res
                )
            ) {
                return;
            }

            const {
                repoName,
                walletAddress
            } = req.body;

            const githubToken =
                req.session.githubToken;

            const githubUser =
                req.session.githubUser;

            const normalizedWallet =
                safeWallet(walletAddress);

            if (
                typeof repoName !==
                    'string' ||
                !/^[a-zA-Z0-9_.-]{1,100}$/.test(
                    repoName
                )
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nederīgs repo nosaukums.'
                });
            }

            if (!normalizedWallet) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nederīga maka adrese.'
                });
            }

            logSection(
                '📥 PREPARE BACKUP'
            );

            logInfo(
                'Repo',
                `${githubUser}/${repoName}`
            );

            logInfo(
                'Wallet',
                normalizedWallet
            );

            await verifySubscription(
                githubUser
            );

            const provider =
                getProvider();

            const nftContract =
                new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

            const fullRepoName =
                `${githubUser}/${repoName}`;

            const repoHash =
                repositoryHash(
                    fullRepoName
                );

            const tokenId =
                await nftContract.repositoryTokens(
                    repoHash
                );

            if (tokenId === 0n) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Šim repozitorijam nav PermRepo NFT.'
                });
            }

            const nftOwner =
                await nftContract.ownerOf(
                    tokenId
                );

            if (
                nftOwner.toLowerCase() !==
                normalizedWallet.toLowerCase()
            ) {
                return res.status(403).json({
                    success: false,
                    error:
                        'Savienotajam makam nepieder šī repozitorija NFT.'
                });
            }

            const [
                backupCount,
                lastManifest,
                lastMerkleRoot
            ] = await Promise.all([
                nftContract.getBackupCount(
                    tokenId
                ),
                nftContract.getManifestURI(
                    tokenId
                ),
                nftContract.getLastMerkleRoot(
                    tokenId
                )
            ]);

            const repository =
                await getGitHubRepository(
                    githubToken,
                    githubUser,
                    repoName
                );

            const repoData =
                await getRepoFiles(
                    githubToken,
                    githubUser,
                    repoName,
                    repository.defaultBranch
                );

            if (
                repoData.files.length ===
                0
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Repozitorijā nav failu.'
                });
            }

            const jobId =
                crypto.randomUUID();

            const now =
                Date.now();

            const job = {
                version: 3,
                jobId,
                githubUser,
                repoName,
                fullRepoName,
                githubRepositoryId:
                    String(repository.id),
                githubDefaultBranch:
                    repository.defaultBranch,
                githubCommitSha:
                    repoData.commitSha,
                githubTreeSha:
                    repoData.treeSha,
                walletAddress:
                    normalizedWallet,
                tokenId:
                    tokenId.toString(),
                onChainBackupCount:
                    backupCount.toString(),
                lastManifest:
                    lastManifest || null,
                lastMerkleRoot:
                    lastMerkleRoot || null,
                changedFiles:
                    repoData.files.map(
                        file => ({
                            path:
                                file.path,
                            hash:
                                file.hash,
                            size:
                                file.size
                        })
                    ),
                status:
                    'prepared',
                zipTxId:
                    null,
                manifestTxId:
                    null,
                manifest:
                    null,
                createdAt:
                    now,
                updatedAt:
                    now
            };

            await createJob(
                jobId,
                job,
                JOB_TTL_SECONDS
            );

            return res.json({
                success: true,
                jobId,
                repoName:
                    fullRepoName,
                githubRepositoryId:
                    String(repository.id),
                githubDefaultBranch:
                    repository.defaultBranch,
                githubCommitSha:
                    repoData.commitSha,
                githubTreeSha:
                    repoData.treeSha,
                tokenId:
                    tokenId.toString(),
                backupCount:
                    backupCount.toString(),
                lastManifest:
                    lastManifest || null,
                lastMerkleRoot:
                    lastMerkleRoot || null,
                files:
                    repoData.files,
                fileCount:
                    repoData.files.length,
                totalBytes:
                    repoData.totalBytes
            });
        } catch (error) {
            logSection(
                '❌ BACKUP PREPARE ERROR'
            );

            console.error(error);

            const status =
                /abonements nav aktīvs/i.test(
                    errorMessage(error)
                )
                    ? 403
                    : 500;

            return res.status(status).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

// -----------------------------------------------------------------------------
// Upload transaction persistence. These endpoints never accept arbitrary job
// mutation: the GitHub session must own the job and the NFT must still be owned
// by the wallet recorded in the job.
// -----------------------------------------------------------------------------

app.post(
    '/api/save-zip-tx',
    backupLimiter,
    async (req, res) => {
        try {
            assertSameOrigin(req);

            if (
                !requireGithubSession(
                    req,
                    res
                )
            ) {
                return;
            }

            const {
                jobId,
                zipTxId
            } = req.body;

            validateJobTxInput(
                jobId,
                zipTxId
            );

            return await withJobLock(
                jobId,
                async () => {
                    const job =
                        await getJob(
                            jobId
                        );

                    const wallet =
                        await verifyJobAuthorization(
                            req,
                            job
                        );

                    await verifyJobNFTAuthorization(
                        job,
                        wallet
                    );

                    if (
                        job.zipTxId &&
                        job.zipTxId !==
                            zipTxId
                    ) {
                        throw new Error(
                            'Šim jobam ZIP transakcija jau ir saglabāta.'
                        );
                    }

                    await updateJob(
                        jobId,
                        {
                            zipTxId,
                            status:
                                job.status ===
                                    'manifest_uploaded'
                                    ? job.status
                                    : 'zip_uploaded'
                        }
                    );

                    return res.json({
                        success: true
                    });
                }
            );
        } catch (error) {
            return res.status(400).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

app.post(
    '/api/save-manifest-tx',
    backupLimiter,
    async (req, res) => {
        try {
            assertSameOrigin(req);

            if (
                !requireGithubSession(
                    req,
                    res
                )
            ) {
                return;
            }

            const {
                jobId,
                manifestTxId,
                manifest
            } = req.body;

            validateJobTxInput(
                jobId,
                manifestTxId
            );

            const validatedManifest =
                validateManifest(
                    manifest
                );

            return await withJobLock(
                jobId,
                async () => {
                    const job =
                        await getJob(
                            jobId
                        );

                    const wallet =
                        await verifyJobAuthorization(
                            req,
                            job
                        );

                    await verifyJobNFTAuthorization(
                        job,
                        wallet
                    );

                    if (!job.zipTxId) {
                        throw new Error(
                            'ZIP transakcija vēl nav saglabāta.'
                        );
                    }

                    if (
                        job.manifestTxId &&
                        job.manifestTxId !==
                            manifestTxId
                    ) {
                        throw new Error(
                            'Šim jobam manifesta transakcija jau ir saglabāta.'
                        );
                    }

                    if (
                        validatedManifest
                            .archive?.id !==
                        job.zipTxId
                    ) {
                        throw new Error(
                            'Manifesta arhīva ID nesakrīt ar job ZIP transakciju.'
                        );
                    }

                    await updateJob(
                        jobId,
                        {
                            manifestTxId:
                                manifestTxId,
                            manifest:
                                validatedManifest,
                            status:
                                'manifest_uploaded'
                        }
                    );

                    return res.json({
                        success: true
                    });
                }
            );
        } catch (error) {
            return res.status(400).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

app.get(
    '/api/health',
    async (req, res) => {
        const redisOk =
            Boolean(getRedis());

        return res.json({
            status:
                redisOk
                    ? 'ok'
                    : 'degraded',
            configured: {
                githubOAuth:
                    !!(
                        GITHUB_CLIENT_ID &&
                        GITHUB_CLIENT_SECRET &&
                        GITHUB_REDIRECT_URI
                    ),
                redis:
                    redisOk,
                rpc:
                    !!RPC_URL,
                nft:
                    !!NFT_ADDRESS,
                subscription:
                    !!SUBSCRIPTION_ADDRESS,
                turbo:
                    !!(
                        TURBO_UPLOAD_URL &&
                        TURBO_PAYMENT_URL
                    ),
                arweaveGateway:
                    !!ARWEAVE_GATEWAY
            }
        });
    }
);

app.get(
    '*',
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                'dist',
                'index.html'
            )
        );
    }
);

app.listen(
    PORT,
    () => {
        logSection(
            '🚀 PERMAREPO SERVERIS'
        );

        logInfo(
            'Port',
            PORT
        );

        logInfo(
            'Chain ID',
            CHAIN_ID
        );

        logInfo(
            'Redis',
            '✅ IR'
        );

        logInfo(
            'RPC',
            RPC_URL
        );

        logInfo(
            'NFT',
            NFT_ADDRESS ||
                '❌ NAV'
        );

        logInfo(
            'Subscription',
            SUBSCRIPTION_ADDRESS ||
                '❌ NAV'
        );

        logInfo(
            'Turbo Upload',
            TURBO_UPLOAD_URL ||
                '❌ NAV'
        );

        logInfo(
            'Turbo Payment',
            TURBO_PAYMENT_URL ||
                '❌ NAV'
        );

        console.log(
            '='.repeat(60) +
            '\n'
        );
    }
);
