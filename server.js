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
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 629145600);

const BACKUP_MEMORY_BUDGET_BYTES = Number(
    process.env.BACKUP_MEMORY_BUDGET_BYTES ||
    5368709120
);

const BACKUP_MEMORY_HARD_LIMIT_BYTES = Number(
    process.env.BACKUP_MEMORY_HARD_LIMIT_BYTES ||
    6979321856
);

const BACKUP_MEMORY_BASE_BYTES = Number(
    process.env.BACKUP_MEMORY_BASE_BYTES ||
    33554432
);

const BACKUP_MEMORY_PER_FILE_MULTIPLIER = Number(
    process.env.BACKUP_MEMORY_PER_FILE_MULTIPLIER ||
    4.5
);

const BACKUP_QUEUE_POLL_MS = Number(
    process.env.BACKUP_QUEUE_POLL_MS ||
    1000
);

const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || 3600);
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 3600);
const DOWNLOAD_CONCURRENCY = 3;
const MAX_GITHUB_REPO_PAGES = 10;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

let activeBackups = 0;
let reservedBackupMemoryBytes = 0;
let backupSchedulerRunning = false;
let backupSchedulerTimer = null;
const backupQueue = [];

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
    !Number.isSafeInteger(BACKUP_MEMORY_BUDGET_BYTES) ||
    BACKUP_MEMORY_BUDGET_BYTES <= 0
) {
    console.error('❌ BACKUP_MEMORY_BUDGET_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(BACKUP_MEMORY_HARD_LIMIT_BYTES) ||
    BACKUP_MEMORY_HARD_LIMIT_BYTES <=
        BACKUP_MEMORY_BUDGET_BYTES
) {
    console.error('❌ BACKUP_MEMORY_HARD_LIMIT_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(BACKUP_MEMORY_BASE_BYTES) ||
    BACKUP_MEMORY_BASE_BYTES <= 0
) {
    console.error('❌ BACKUP_MEMORY_BASE_BYTES ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isFinite(BACKUP_MEMORY_PER_FILE_MULTIPLIER) ||
    BACKUP_MEMORY_PER_FILE_MULTIPLIER <= 1
) {
    console.error('❌ BACKUP_MEMORY_PER_FILE_MULTIPLIER ir nederīgs!');
    process.exit(1);
}

if (
    !Number.isSafeInteger(BACKUP_QUEUE_POLL_MS) ||
    BACKUP_QUEUE_POLL_MS < 100
) {
    console.error('❌ BACKUP_QUEUE_POLL_MS ir nederīgs!');
    process.exit(1);
}

initRedis();

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

function githubOwnerHash(login) {
    return ethers.keccak256(
        ethers.toUtf8Bytes(login)
    );
}

function repositoryHash(fullRepoName) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['string'],
            [fullRepoName]
        )
    );
}

function estimateBackupMemoryBytes(largestFileBytes) {
    const fileBytes = Math.max(
        0,
        Number(largestFileBytes) || 0
    );

    const estimate =
        BACKUP_MEMORY_BASE_BYTES +
        Math.ceil(
            fileBytes *
            BACKUP_MEMORY_PER_FILE_MULTIPLIER
        );

    return Math.max(
        BACKUP_MEMORY_BASE_BYTES,
        estimate
    );
}

function getLargestTreeFileBytes(blobs) {
    let largest = 0;

    for (const blob of blobs) {
        if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
            throw new Error(
                `Git Tree satur nederīgu faila izmēru: ${blob.path}`
            );
        }

        if (blob.size > MAX_FILE_BYTES) {
            throw new Error(
                `Fails ${blob.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`
            );
        }

        if (blob.size > largest) {
            largest = blob.size;
        }
    }

    return largest;
}

function getBackupMemoryState() {
    const rss = process.memoryUsage().rss;

    return {
        rssBytes: rss,
        reservedBytes: reservedBackupMemoryBytes,
        availableReservationBytes: Math.max(
            0,
            BACKUP_MEMORY_BUDGET_BYTES -
                reservedBackupMemoryBytes
        ),
        budgetBytes: BACKUP_MEMORY_BUDGET_BYTES,
        hardLimitBytes: BACKUP_MEMORY_HARD_LIMIT_BYTES
    };
}

function canReserveBackupMemory(requiredBytes) {
    const memory = getBackupMemoryState();

    return (
        memory.rssBytes <
            BACKUP_MEMORY_HARD_LIMIT_BYTES &&
        memory.reservedBytes + requiredBytes <=
            BACKUP_MEMORY_BUDGET_BYTES
    );
}

function removeQueuedBackup(task) {
    const index = backupQueue.indexOf(task);

    if (index !== -1) {
        backupQueue.splice(index, 1);
        return true;
    }

    return false;
}

function scheduleBackupPump() {
    if (backupSchedulerTimer !== null) {
        return;
    }

    backupSchedulerTimer = setTimeout(() => {
        backupSchedulerTimer = null;

        pumpBackupQueue().catch(error => {
            console.error(
                '❌ Backup scheduler kļūda:',
                error
            );
        });
    }, BACKUP_QUEUE_POLL_MS);
}

async function pumpBackupQueue() {
    if (backupSchedulerRunning) {
        return;
    }

    backupSchedulerRunning = true;

    try {
        let started = true;

        while (started) {
            started = false;

            const currentRss =
                process.memoryUsage().rss;

            if (
                currentRss >=
                BACKUP_MEMORY_HARD_LIMIT_BYTES
            ) {
                break;
            }

            for (
                let index = 0;
                index < backupQueue.length;
                index += 1
            ) {
                const task =
                    backupQueue[index];

                if (task.cancelled) {
                    backupQueue.splice(
                        index,
                        1
                    );

                    index -= 1;
                    continue;
                }

                if (
                    !canReserveBackupMemory(
                        task.memoryReservationBytes
                    )
                ) {
                    continue;
                }

                backupQueue.splice(
                    index,
                    1
                );

                reservedBackupMemoryBytes +=
                    task.memoryReservationBytes;

                activeBackups += 1;

                task.started = true;
                task.queuePosition = 0;

                started = true;

                Promise.resolve()
                    .then(task.run)
                    .then(task.resolve)
                    .catch(task.reject)
                    .finally(() => {
                        reservedBackupMemoryBytes =
                            Math.max(
                                0,
                                reservedBackupMemoryBytes -
                                    task.memoryReservationBytes
                            );

                        activeBackups =
                            Math.max(
                                0,
                                activeBackups - 1
                            );

                        scheduleBackupPump();
                    });

                break;
            }
        }
    } finally {
        backupSchedulerRunning = false;

        if (backupQueue.length > 0) {
            scheduleBackupPump();
        }
    }
}

setInterval(() => {
    if (backupQueue.length > 0) {
        pumpBackupQueue().catch(error => {
            console.error(
                '❌ Backup scheduler kļūda:',
                error
            );
        });
    }
}, BACKUP_QUEUE_POLL_MS).unref();

function calculateGitBlobSha(buffer) {
    const header = `blob ${buffer.length}\0`;

    const gitBlob = Buffer.concat([
        Buffer.from(header, 'utf8'),
        buffer
    ]);

    return crypto
        .createHash('sha1')
        .update(gitBlob)
        .digest('hex');
}

function getProvider() {
    return new ethers.JsonRpcProvider(
        RPC_URL,
        EXPECTED_CHAIN_ID
    );
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
        'https://github.com'
    ]);

    if (GITHUB_REDIRECT_URI) {
        try {
            origins.add(
                new URL(
                    GITHUB_REDIRECT_URI
                ).origin
            );
        } catch {
            // Nederīgs redirect URI tiks noraidīts OAuth konfigurācijas laikā.
        }
    }

    return origins;
}

function assertSameOrigin(req) {
    const origin =
        req.get('origin');

    const host =
        req.get('host');

    if (!origin) {
        return;
    }

    let originUrl;

    try {
        originUrl =
            new URL(origin);
    } catch {
        throw new Error(
            'Nederīgs Origin.'
        );
    }

    const expectedOrigins =
        getAllowedConnectOrigins();

    const requestOrigin =
        `${req.protocol}://${host}`;

    if (
        originUrl.origin !==
            requestOrigin &&
        !expectedOrigins.has(
            originUrl.origin
        )
    ) {
        throw new Error(
            'Origin nav atļauts.'
        );
    }
}

app.use(
    express.json({
        limit: '2mb'
    })
);

app.use(
    express.urlencoded({
        extended: false,
        limit: '100kb'
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            'dist'
        ),
        {
            index: false
        }
    )
);

const sessionMiddleware =
    session({
        secret:
            SESSION_SECRET,
        resave:
            false,
        saveUninitialized:
            false,
        cookie: {
            httpOnly:
                true,
            secure:
                process.env.NODE_ENV ===
                'production',
            sameSite:
                'lax',
            maxAge:
                SESSION_TTL_SECONDS *
                1000
        }
    });

app.use(
    sessionMiddleware
);

const backupLimiter =
    rateLimit({
        windowMs:
            15 * 60 * 1000,
        max:
            30,
        standardHeaders:
            true,
        legacyHeaders:
            false,
        message: {
            success:
                false,
            error:
                'Pārāk daudz pieprasījumu. Lūdzu, mēģiniet vēlāk.'
        }
    });

const apiLimiter =
    rateLimit({
        windowMs:
            15 * 60 * 1000,
        max:
            120,
        standardHeaders:
            true,
        legacyHeaders:
            false
    });

async function githubRequest(
    url,
    options = {}
) {
    const response =
        await fetch(
            url,
            {
                ...options,
                headers: {
                    Accept:
                        'application/vnd.github+json',
                    'X-GitHub-Api-Version':
                        '2022-11-28',
                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            `GitHub API kļūda ${response.status}: ` +
            text.substring(0, 300)
        );
    }

    return response;
}

async function fetchWithRetry(
    url,
    options = {},
    attempts = 3
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= attempts;
        attempt += 1
    ) {
        try {
            return await githubRequest(
                url,
                options
            );
        } catch (error) {
            lastError =
                error;

            if (
                attempt >=
                attempts
            ) {
                break;
            }

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        500 *
                            attempt
                    )
            );
        }
    }

    throw lastError ||
        new Error(
            'Pieprasījums neizdevās.'
        );
}

async function getGitHubRepository(
    githubToken,
    owner,
    repo
) {
    const response =
        await fetchWithRetry(
            `https://api.github.com/repos/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${githubToken}`
                }
            }
        );

    const repository =
        await response.json();

    if (
        !repository ||
        typeof repository.id !==
            'number'
    ) {
        throw new Error(
            'GitHub neatgrieza derīgu repozitoriju.'
        );
    }

    return {
        id:
            repository.id,
        defaultBranch:
            repository.default_branch ||
            'main',
        private:
            Boolean(
                repository.private
            )
    };
}

async function getBranchCommitSha(
    githubToken,
    owner,
    repo,
    branch
) {
    const response =
        await fetchWithRetry(
            `https://api.github.com/repos/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}/commits/` +
            `${encodeURIComponent(branch)}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${githubToken}`
                }
            }
        );

    const data =
        await response.json();

    if (
        !data?.sha ||
        !/^[a-f0-9]{40}$/i.test(
            data.sha
        )
    ) {
        throw new Error(
            'GitHub neatgrieza derīgu commit SHA.'
        );
    }

    return data.sha;
}

async function getGitTree(
    githubToken,
    owner,
    repo,
    commitSha
) {
    const response =
        await fetchWithRetry(
            `https://api.github.com/repos/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}/git/trees/` +
            `${encodeURIComponent(commitSha)}` +
            '?recursive=1',
            {
                headers: {
                    Authorization:
                        `Bearer ${githubToken}`
                }
            }
        );

    const data =
        await response.json();

    if (
        !data ||
        !Array.isArray(
            data.tree
        )
    ) {
        throw new Error(
            'GitHub Tree dati nav derīgi.'
        );
    }

    if (
        data.truncated
    ) {
        throw new Error(
            'GitHub Tree ir pārāk liels un tika saīsināts.'
        );
    }

    const blobs =
        data.tree
            .filter(
                entry =>
                    entry.type ===
                    'blob'
            )
            .map(
                entry => {
                    if (
                        typeof entry.path !==
                            'string' ||
                        typeof entry.sha !==
                            'string' ||
                        !/^[a-f0-9]{40}$/i.test(
                            entry.sha
                        ) ||
                        !Number.isSafeInteger(
                            entry.size
                        ) ||
                        entry.size < 0
                    ) {
                        throw new Error(
                            'GitHub Tree satur nederīgu faila ierakstu.'
                        );
                    }

                    return {
                        path:
                            entry.path,
                        sha:
                            entry.sha,
                        size:
                            entry.size
                    };
                }
            );

    if (
        blobs.length >
        MAX_REPO_FILES
    ) {
        throw new Error(
            `Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`
        );
    }

    let totalBytes = 0;

    for (const blob of blobs) {
        if (
            blob.size >
            MAX_FILE_BYTES
        ) {
            throw new Error(
                `Fails ${blob.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`
            );
        }

        totalBytes +=
            blob.size;

        if (
            totalBytes >
            MAX_REPO_BYTES
        ) {
            throw new Error(
                `Repo pārsniedz maksimālo kopējo izmēru (${MAX_REPO_BYTES} bytes).`
            );
        }
    }

    return {
        sha:
            data.sha,
        blobs
    };
}

async function verifySubscription(
    githubUser
) {
    const provider =
        getProvider();

    const contract =
        new ethers.Contract(
            SUBSCRIPTION_ADDRESS,
            SUBSCRIPTION_ABI,
            provider
        );

    const hash =
        githubOwnerHash(
            githubUser
        );

    const subscribed =
        await contract.isSubscribed(
            hash
        );

    if (!subscribed) {
        throw new Error(
            'Abonements nav aktīvs.'
        );
    }

    return true;
}

function requireGithubSession(
    req,
    res
) {
    if (
        !req.session ||
        !req.session.githubToken ||
        !req.session.githubUser
    ) {
        res.status(401).json({
            success:
                false,
            error:
                'GitHub sesija nav derīga.'
        });

        return false;
    }

    return true;
}

function validateManifest(
    manifest
) {
    if (
        !manifest ||
        typeof manifest !==
            'object' ||
        Array.isArray(manifest)
    ) {
        throw new Error(
            'Nederīgs manifests.'
        );
    }

    const serialized =
        JSON.stringify(
            manifest
        );

    if (
        Buffer.byteLength(
            serialized,
            'utf8'
        ) >
        MAX_MANIFEST_BYTES
    ) {
        throw new Error(
            'Manifests ir pārāk liels.'
        );
    }

    if (
        typeof manifest.archive !==
            'object' ||
        !manifest.archive
    ) {
        throw new Error(
            'Manifests nesatur archive informāciju.'
        );
    }

    if (
        typeof manifest.archive.id !==
            'string' ||
        !validateArweaveId(
            manifest.archive.id
        )
    ) {
        throw new Error(
            'Manifests satur nederīgu archive ID.'
        );
    }
}

async function verifyJobAuthorization(
    req,
    job
) {
    if (
        !job ||
        typeof job !==
            'object'
    ) {
        throw new Error(
            'Backup job nav derīgs.'
        );
    }

    if (
        job.githubUser !==
        req.session.githubUser
    ) {
        throw new Error(
            'Backup job nepieder šai GitHub sesijai.'
        );
    }

    const wallet =
        safeWallet(
            job.walletAddress
        );

    if (!wallet) {
        throw new Error(
            'Backup job satur nederīgu maka adresi.'
        );
    }

    return wallet;
}

async function verifyJobNFTAuthorization(
    job
) {
    const provider =
        getProvider();

    const contract =
        new ethers.Contract(
            NFT_ADDRESS,
            NFT_ABI,
            provider
        );

    const tokenId =
        BigInt(
            job.tokenId
        );

    const owner =
        await contract.ownerOf(
            tokenId
        );

    if (
        owner.toLowerCase() !==
        job.walletAddress.toLowerCase()
    ) {
        throw new Error(
            'Backup NFT vairs nepieder autorizētajam makam.'
        );
    }

    return true;
}

async function withJobLock(
    jobId,
    fn
) {
    const token =
        await acquireJobLock(
            jobId
        );

    if (!token) {
        throw new Error(
            'Backup job pašlaik apstrādā cits pieprasījums.'
        );
    }

    try {
        return await fn();
    } finally {
        await releaseJobLock(
            jobId,
            token
        );
    }
}

async function downloadGitHubZipToTempFile(
    response,
    tempPath
) {
    const contentLengthHeader =
        response.headers.get(
            'content-length'
        );

    if (
        contentLengthHeader !==
        null
    ) {
        const contentLength =
            Number(
                contentLengthHeader
            );

        if (
            Number.isSafeInteger(
                contentLength
            ) &&
            contentLength >
                MAX_ZIP_BYTES
        ) {
            throw new Error(
                `GitHub ZIP pārsniedz ${MAX_ZIP_BYTES} bytes limitu.`
            );
        }
    }

    if (!response.body) {
        throw new Error(
            'GitHub ZIP atbilde nesatur datu streamu.'
        );
    }

    let receivedBytes = 0;

    const byteLimitTransform =
        new Transform({
            transform(
                chunk,
                encoding,
                callback
            ) {
                try {
                    const buffer =
                        Buffer.isBuffer(
                            chunk
                        )
                            ? chunk
                            : Buffer.from(
                                  chunk,
                                  encoding
                              );

                    receivedBytes +=
                        buffer.length;

                    if (
                        receivedBytes >
                        MAX_ZIP_BYTES
                    ) {
                        callback(
                            new Error(
                                `GitHub ZIP pārsniedz ${MAX_ZIP_BYTES} bytes limitu.`
                            )
                        );

                        return;
                    }

                    callback(
                        null,
                        buffer
                    );
                } catch (error) {
                    callback(error);
                }
            }
        });

    await pipeline(
        Readable.fromWeb(
            response.body
        ),
        byteLimitTransform,
        fs.createWriteStream(
            tempPath,
            {
                flags: 'wx'
            }
        )
    );

    if (receivedBytes === 0) {
        throw new Error(
            'GitHub ZIP atbilde ir tukša.'
        );
    }

    return receivedBytes;
}

async function getRepoArchiveMetadata(
    githubToken,
    owner,
    repo,
    defaultBranch
) {
    const repository =
        await getGitHubRepository(
            githubToken,
            owner,
            repo
        );

    const commitSha =
        await getBranchCommitSha(
            githubToken,
            owner,
            repo,
            defaultBranch ||
                repository.defaultBranch
        );

    const tree =
        await getGitTree(
            githubToken,
            owner,
            repo,
            commitSha
        );

    return {
        repository,
        commitSha,
        treeSha:
            tree.sha,
        blobs:
            tree.blobs
    };
}

async function openRepoArchive(
    githubToken,
    owner,
    repo,
    commitSha,
    metadata
) {
    const zipUrl =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `zipball/${encodeURIComponent(commitSha)}`;

    const response =
        await fetchWithRetry(
            zipUrl,
            {
                headers: {
                    Authorization:
                        `Bearer ${githubToken}`,
                    Accept:
                        'application/vnd.github+json',
                    'X-GitHub-Api-Version':
                        '2022-11-28'
                }
            }
        );

    const tempPath =
        path.join(
            os.tmpdir(),
            `permrepo-${crypto.randomUUID()}.zip`
        );

    try {
        await downloadGitHubZipToTempFile(
            response,
            tempPath
        );

        const zipfile =
            await yauzl.openPromise(
                tempPath,
                {
                    lazyEntries:
                        true,
                    decodeStrings:
                        true,
                    validateEntrySizes:
                        true
                }
            );

        return {
            ...metadata,
            tempPath,
            zipfile
        };
    } catch (error) {
        await fs.promises
            .unlink(
                tempPath
            )
            .catch(() => {});

        throw error;
    }
}

async function processRepoArchive(
    archive,
    onFile
) {
    const {
        blobs,
        zipfile
    } = archive;

    if (!zipfile) {
        return {
            files: [],
            totalBytes: 0
        };
    }

    const treeByPath =
        new Map(
            blobs.map(
                blob => [
                    blob.path,
                    blob
                ]
            )
        );

    const seenPaths =
        new Set();

    let entries = 0;
    let totalBytes = 0;

    try {
        for await (
            const entry of
            zipfile.eachEntry()
        ) {
            if (
                entry.fileName.endsWith(
                    '/'
                )
            ) {
                continue;
            }

            entries += 1;

            if (
                entries >
                MAX_REPO_FILES
            ) {
                throw new Error(
                    `Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`
                );
            }

            const parts =
                entry.fileName.split(
                    '/'
                );

            const filePath =
                parts.length > 1
                    ? parts
                          .slice(1)
                          .join('/')
                    : parts[0];

            if (
                !filePath ||
                filePath.length >
                    1000 ||
                filePath
                    .split('/')
                    .some(
                        part =>
                            part === '' ||
                            part === '.' ||
                            part === '..'
                    )
            ) {
                throw new Error(
                    `GitHub arhīvā atrasts nederīgs faila ceļš: ${entry.fileName}`
                );
            }

            if (
                seenPaths.has(
                    filePath
                )
            ) {
                throw new Error(
                    `GitHub arhīvā atrasts dublēts fails: ${filePath}`
                );
            }

            seenPaths.add(
                filePath
            );

            const treeEntry =
                treeByPath.get(
                    filePath
                );

            if (!treeEntry) {
                throw new Error(
                    `GitHub arhīvā nav atrasts fails: ${filePath}`
                );
            }

            if (
                !Number.isSafeInteger(
                    entry.uncompressedSize
                ) ||
                entry.uncompressedSize <
                    0
            ) {
                throw new Error(
                    `ZIP ierakstam ${filePath} ir nederīgs nekompresētais izmērs.`
                );
            }

            if (
                entry.uncompressedSize >
                MAX_FILE_BYTES
            ) {
                throw new Error(
                    `Fails ${filePath} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`
                );
            }

            if (
                treeEntry.size !==
                entry.uncompressedSize
            ) {
                throw new Error(
                    `Faila ${filePath} izmērs nesakrīt: ` +
                    `Git Tree ${treeEntry.size} vs ZIP ${entry.uncompressedSize}`
                );
            }

            const fileBuffer =
                Buffer.allocUnsafe(
                    entry.uncompressedSize
                );

            const gitSha1 =
                crypto.createHash(
                    'sha1'
                );

            gitSha1.update(
                Buffer.from(
                    `blob ${entry.uncompressedSize}\0`,
                    'utf8'
                )
            );

            const sha256 =
                crypto.createHash(
                    'sha256'
                );

            const fileStream =
                await zipfile.openReadStreamPromise(
                    entry
                );

            let offset = 0;

            for await (
                const chunk of
                fileStream
            ) {
                const buffer =
                    Buffer.isBuffer(
                        chunk
                    )
                        ? chunk
                        : Buffer.from(
                              chunk
                          );

                if (
                    offset +
                        buffer.length >
                    fileBuffer.length
                ) {
                    throw new Error(
                        `ZIP fails ${filePath} pārsniedz deklarēto izmēru.`
                    );
                }

                buffer.copy(
                    fileBuffer,
                    offset
                );

                offset +=
                    buffer.length;

                gitSha1.update(
                    buffer
                );

                sha256.update(
                    buffer
                );
            }

            if (
                offset !==
                fileBuffer.length
            ) {
                throw new Error(
                    `Faila ${filePath} faktiskais izmērs nesakrīt ar ZIP deklarēto izmēru.`
                );
            }

            const calculatedGitSha =
                gitSha1.digest(
                    'hex'
                );

            if (
                treeEntry.sha !==
                calculatedGitSha
            ) {
                throw new Error(
                    `Faila ${filePath} Git SHA nesakrīt: ` +
                    `Git Tree ${treeEntry.sha} vs aprēķināts ${calculatedGitSha}`
                );
            }

            totalBytes +=
                fileBuffer.length;

            if (
                totalBytes >
                MAX_REPO_BYTES
            ) {
                throw new Error(
                    `Repo pārsniedz maksimālo kopējo izmēru (${MAX_REPO_BYTES} bytes).`
                );
            }

            const file = {
                path:
                    filePath,
                size:
                    fileBuffer.length,
                content:
                    fileBuffer.toString(
                        'base64'
                    ),
                hash:
                    sha256.digest(
                        'hex'
                    )
            };

            await onFile(
                file
            );
        }

        if (
            entries !==
            blobs.length
        ) {
            throw new Error(
                `GitHub ZIP failu skaits nesakrīt ar Git Tree: ` +
                `ZIP ${entries} vs Tree ${blobs.length}`
            );
        }

        if (
            seenPaths.size !==
            blobs.length
        ) {
            throw new Error(
                'GitHub ZIP un Git Tree failu kopas nesakrīt.'
            );
        }

        return {
            files: [],
            totalBytes
        };
    } finally {
        try {
            zipfile.close();
        } catch {
            // ZIP jau var būt aizvērts.
        }
    }
}

async function writeNdjson(
    res,
    payload
) {
    if (
        res.destroyed ||
        res.writableEnded
    ) {
        throw new Error(
            'Klienta savienojums tika pārtraukts.'
        );
    }

    const line =
        `${JSON.stringify(payload)}\n`;

    if (
        res.write(line)
    ) {
        return;
    }

    await new Promise(
        (
            resolve,
            reject
        ) => {
            const onDrain =
                () => {
                    cleanup();
                    resolve();
                };

            const onClose =
                () => {
                    cleanup();
                    reject(
                        new Error(
                            'Klienta savienojums tika pārtraukts.'
                        )
                    );
                };

            const cleanup =
                () => {
                    res.off(
                        'drain',
                        onDrain
                    );

                    res.off(
                        'close',
                        onClose
                    );
                };

            res.once(
                'drain',
                onDrain
            );

            res.once(
                'close',
                onClose
            );
        }
    );
}

app.get(
    '/api/config',
    apiLimiter,
    async (
        req,
        res
    ) => {
        return res.json({
            success:
                true,
            chainId:
                CHAIN_ID,
            rpcUrl:
                RPC_URL,
            nftAddress:
                NFT_ADDRESS,
            subscriptionAddress:
                SUBSCRIPTION_ADDRESS,
            usdcAddress:
                USDC_ADDRESS,
            arweaveGateway:
                ARWEAVE_GATEWAY
        });
    }
);

app.get(
    '/api/github/user',
    apiLimiter,
    async (
        req,
        res
    ) => {
        try {
            if (
                !req.session ||
                !req.session.githubToken
            ) {
                return res.json({
                    success:
                        false
                });
            }

            const response =
                await fetchWithRetry(
                    'https://api.github.com/user',
                    {
                        headers: {
                            Authorization:
                                `Bearer ${req.session.githubToken}`
                        }
                    }
                );

            const user =
                await response.json();

            if (
                !user ||
                !user.login
            ) {
                throw new Error(
                    'GitHub lietotāja dati nav derīgi.'
                );
            }

            req.session.githubUser =
                user.login;

            return res.json({
                success:
                    true,
                user: {
                    login:
                        user.login,
                    id:
                        user.id,
                    avatar_url:
                        user.avatar_url
                }
            });
        } catch (error) {
            req.session.destroy(
                () => {}
            );

            return res.status(401).json({
                success:
                    false,
                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

app.get(
    '/api/github/login',
    apiLimiter,
    (
        req,
        res
    ) => {
        if (
            !GITHUB_CLIENT_ID ||
            !GITHUB_REDIRECT_URI
        ) {
            return res.status(500).send(
                'GitHub OAuth nav konfigurēts.'
            );
        }

        const scope =
            'repo';

        const state =
            crypto.randomBytes(
                32
            ).toString(
                'hex'
            );

        req.session.oauthState =
            state;

        const params =
            new URLSearchParams({
                client_id:
                    GITHUB_CLIENT_ID,
                redirect_uri:
                    GITHUB_REDIRECT_URI,
                scope,
                state
            });

        return res.redirect(
            `https://github.com/login/oauth/authorize?${params.toString()}`
        );
    }
);

app.get(
    '/api/github/callback',
    apiLimiter,
    async (
        req,
        res
    ) => {
        try {
            const {
                code,
                state
            } = req.query;

            if (
                typeof code !==
                    'string' ||
                typeof state !==
                    'string' ||
                state !==
                    req.session.oauthState
            ) {
                throw new Error(
                    'OAuth state nav derīgs.'
                );
            }

            delete req.session.oauthState;

            const tokenResponse =
                await fetch(
                    'https://github.com/login/oauth/access_token',
                    {
                        method:
                            'POST',
                        headers: {
                            Accept:
                                'application/json',
                            'Content-Type':
                                'application/json'
                        },
                        body:
                            JSON.stringify({
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

            if (
                !tokenResponse.ok
            ) {
                throw new Error(
                    'GitHub OAuth token pieprasījums neizdevās.'
                );
            }

            const tokenData =
                await tokenResponse.json();

            if (
                !tokenData.access_token
            ) {
                throw new Error(
                    'GitHub neatgrieza access token.'
                );
            }

            req.session.githubToken =
                tokenData.access_token;

            const userResponse =
                await fetchWithRetry(
                    'https://api.github.com/user',
                    {
                        headers: {
                            Authorization:
                                `Bearer ${tokenData.access_token}`
                        }
                    }
                );

            const user =
                await userResponse.json();

            if (
                !user?.login
            ) {
                throw new Error(
                    'GitHub lietotājs nav derīgs.'
                );
            }

            req.session.githubUser =
                user.login;

            return res.redirect(
                '/'
            );
        } catch (error) {
            console.error(
                'GitHub OAuth callback kļūda:',
                error
            );

            return res.status(400).send(
                errorMessage(
                    error
                )
            );
        }
    }
);

app.post(
    '/api/github/logout',
    apiLimiter,
    (
        req,
        res
    ) => {
        req.session.destroy(
            () => {
                res.json({
                    success:
                        true
                });
            }
        );
    }
);

app.get(
    '/api/github/repos',
    apiLimiter,
    async (
        req,
        res
    ) => {
        try {
            if (
                !requireGithubSession(
                    req,
                    res
                )
            ) {
                return;
            }

            const repositories =
                [];

            for (
                let page = 1;
                page <=
                    MAX_GITHUB_REPO_PAGES;
                page += 1
            ) {
                const response =
                    await fetchWithRetry(
                        `https://api.github.com/user/repos?` +
                        new URLSearchParams({
                            per_page:
                                '100',
                            page:
                                String(
                                    page
                                ),
                            sort:
                                'updated',
                            direction:
                                'desc'
                        }),
                        {
                            headers: {
                                Authorization:
                                    `Bearer ${req.session.githubToken}`
                            }
                        }
                    );

                const pageData =
                    await response.json();

                if (
                    !Array.isArray(
                        pageData
                    )
                ) {
                    throw new Error(
                        'GitHub repo dati nav derīgi.'
                    );
                }

                repositories.push(
                    ...pageData
                );

                if (
                    pageData.length <
                    100
                ) {
                    break;
                }
            }

            return res.json({
                success:
                    true,
                repositories:
                    repositories.map(
                        repo => ({
                            id:
                                repo.id,
                            name:
                                repo.name,
                            full_name:
                                repo.full_name,
                            private:
                                Boolean(
                                    repo.private
                                ),
                            default_branch:
                                repo.default_branch ||
                                'main'
                        })
                    )
            });
        } catch (error) {
            return res.status(500).json({
                success:
                    false,
                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

app.post(
    '/api/prepare-backup',
    backupLimiter,
    async (
        req,
        res
    ) => {
        let archive = null;
        let streamStarted = false;
        let queuedTask = null;

        try {
            assertSameOrigin(
                req
            );

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
                safeWallet(
                    walletAddress
                );

            if (
                typeof repoName !==
                    'string' ||
                !/^[a-zA-Z0-9_.-]{1,100}$/.test(
                    repoName
                )
            ) {
                return res.status(400).json({
                    success:
                        false,
                    error:
                        'Nederīgs repo nosaukums.'
                });
            }

            if (
                !normalizedWallet
            ) {
                return res.status(400).json({
                    success:
                        false,
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

            if (
                tokenId ===
                0n
            ) {
                return res.status(400).json({
                    success:
                        false,
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
                    success:
                        false,
                    error:
                        'Savienotajam makam nepieder šī repozitorija NFT.'
                });
            }

            const [
                backupCount,
                lastManifest,
                lastMerkleRoot
            ] =
                await Promise.all([
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

            const archiveMetadata =
                await getRepoArchiveMetadata(
                    githubToken,
                    githubUser,
                    repoName,
                    req.body.defaultBranch ||
                        undefined
                );

            if (
                archiveMetadata.blobs.length ===
                0
            ) {
                return res.status(400).json({
                    success:
                        false,
                    error:
                        'Repozitorijā nav failu.'
                });
            }

            const largestFileBytes =
                getLargestTreeFileBytes(
                    archiveMetadata.blobs
                );

            const memoryReservationBytes =
                estimateBackupMemoryBytes(
                    largestFileBytes
                );

            if (
                memoryReservationBytes >
                BACKUP_MEMORY_BUDGET_BYTES
            ) {
                throw new Error(
                    'Šis backup ir pārāk liels servera RAM budžetam.'
                );
            }

            const jobId =
                crypto.randomUUID();

            const now =
                Date.now();

            const job = {
                version:
                    5,
                jobId,
                githubUser,
                repoName,
                fullRepoName,
                githubRepositoryId:
                    String(
                        archiveMetadata.repository.id
                    ),
                githubDefaultBranch:
                    archiveMetadata.repository.defaultBranch,
                githubCommitSha:
                    archiveMetadata.commitSha,
                githubTreeSha:
                    archiveMetadata.treeSha,
                walletAddress:
                    normalizedWallet,
                tokenId:
                    tokenId.toString(),
                onChainBackupCount:
                    backupCount.toString(),
                lastManifest:
                    lastManifest ||
                    null,
                lastMerkleRoot:
                    lastMerkleRoot ||
                    null,
                changedFiles:
                    [],
                status:
                    'queued',
                zipTxId:
                    null,
                manifestTxId:
                    null,
                manifest:
                    null,
                memoryReservationBytes,
                largestFileBytes,
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

            res.status(
                200
            );

            res.setHeader(
                'Content-Type',
                'application/x-ndjson; charset=utf-8'
            );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            res.setHeader(
                'X-Content-Type-Options',
                'nosniff'
            );

            res.flushHeaders();

            streamStarted =
                true;

            const queuePosition =
                backupQueue.length +
                1;

            await writeNdjson(
                res,
                {
                    type:
                        'queued',
                    success:
                        true,
                    jobId,
                    queuePosition,
                    memoryReservationBytes,
                    largestFileBytes,
                    activeBackups,
                    reservedMemoryBytes:
                        reservedBackupMemoryBytes,
                    memoryBudgetBytes:
                        BACKUP_MEMORY_BUDGET_BYTES
                }
            );

            let resolveTask;
            let rejectTask;

            const slotPromise =
                new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        resolveTask =
                            resolve;
                        rejectTask =
                            reject;
                    }
                );

            queuedTask = {
                memoryReservationBytes,
                started:
                    false,
                cancelled:
                    false,
                queuePosition,
                run:
                    async () => {
                        try {
                            await writeNdjson(
                                res,
                                {
                                    type:
                                        'started',
                                    success:
                                        true,
                                    jobId,
                                    activeBackups:
                                        activeBackups,
                                    reservedMemoryBytes:
                                        reservedBackupMemoryBytes,
                                    memoryBudgetBytes:
                                        BACKUP_MEMORY_BUDGET_BYTES
                                }
                            );

                            archive =
                                await openRepoArchive(
                                    githubToken,
                                    githubUser,
                                    repoName,
                                    archiveMetadata.commitSha,
                                    archiveMetadata
                                );

                            await writeNdjson(
                                res,
                                {
                                    type:
                                        'meta',
                                    success:
                                        true,
                                    jobId,
                                    repoName:
                                        fullRepoName,
                                    githubRepositoryId:
                                        String(
                                            archive.repository.id
                                        ),
                                    githubDefaultBranch:
                                        archive.repository.defaultBranch,
                                    githubCommitSha:
                                        archive.commitSha,
                                    githubTreeSha:
                                        archive.treeSha,
                                    tokenId:
                                        tokenId.toString(),
                                    backupCount:
                                        backupCount.toString(),
                                    lastManifest:
                                        lastManifest ||
                                        null,
                                    lastMerkleRoot:
                                        lastMerkleRoot ||
                                        null
                                }
                            );

                            const jobFiles =
                                [];

                            let totalBytes =
                                0;

                            await processRepoArchive(
                                archive,
                                async file => {
                                    jobFiles.push({
                                        path:
                                            file.path,
                                        hash:
                                            file.hash,
                                        size:
                                            file.size
                                    });

                                    totalBytes +=
                                        file.size;

                                    await writeNdjson(
                                        res,
                                        {
                                            type:
                                                'file',
                                            file
                                        }
                                    );
                                }
                            );

                            await updateJob(
                                jobId,
                                {
                                    changedFiles:
                                        jobFiles,
                                    status:
                                        'prepared',
                                    updatedAt:
                                        Date.now()
                                },
                                JOB_TTL_SECONDS
                            );

                            await writeNdjson(
                                res,
                                {
                                    type:
                                        'complete',
                                    success:
                                        true,
                                    jobId,
                                    repoName:
                                        fullRepoName,
                                    githubRepositoryId:
                                        String(
                                            archive.repository.id
                                        ),
                                    githubDefaultBranch:
                                        archive.repository.defaultBranch,
                                    githubCommitSha:
                                        archive.commitSha,
                                    githubTreeSha:
                                        archive.treeSha,
                                    tokenId:
                                        tokenId.toString(),
                                    backupCount:
                                        backupCount.toString(),
                                    lastManifest:
                                        lastManifest ||
                                        null,
                                    lastMerkleRoot:
                                        lastMerkleRoot ||
                                        null,
                                    fileCount:
                                        jobFiles.length,
                                    totalBytes
                                }
                            );

                            res.end();
                        } catch (error) {
                            await updateJob(
                                jobId,
                                {
                                    status:
                                        'prepare-failed',
                                    error:
                                        errorMessage(
                                            error
                                        )
                                },
                                JOB_TTL_SECONDS
                            ).catch(
                                () => {}
                            );

                            if (
                                !res.writableEnded
                            ) {
                                try {
                                    await writeNdjson(
                                        res,
                                        {
                                            type:
                                                'error',
                                            success:
                                                false,
                                            jobId,
                                            error:
                                                errorMessage(
                                                    error
                                                )
                                        }
                                    );
                                } catch {
                                    // Klients var būt jau atvienojies.
                                }

                                if (
                                    !res.writableEnded
                                ) {
                                    res.end();
                                }
                            }

                            throw error;
                        } finally {
                            if (
                                archive?.zipfile
                            ) {
                                try {
                                    archive.zipfile.close();
                                } catch {
                                    // ZIP jau var būt aizvērts.
                                }
                            }

                            if (
                                archive?.tempPath
                            ) {
                                await fs.promises
                                    .unlink(
                                        archive.tempPath
                                    )
                                    .catch(
                                        () => {}
                                    );
                            }

                            archive =
                                null;
                        }
                    },
                resolve:
                    resolveTask,
                reject:
                    rejectTask
            };

            const cancelQueuedTask =
                () => {
                    if (
                        queuedTask &&
                        !queuedTask.started
                    ) {
                        queuedTask.cancelled =
                            true;

                        removeQueuedBackup(
                            queuedTask
                        );

                        rejectTask(
                            new Error(
                                'Klienta savienojums tika pārtraukts.'
                            )
                        );

                        return;
                    }

                    if (
                        queuedTask &&
                        queuedTask.started &&
                        !res.writableEnded
                    ) {
                        rejectTask(
                            new Error(
                                'Klienta savienojums tika pārtraukts.'
                            )
                        );
                    }
                };

            queuedTask.cancelHandler =
                cancelQueuedTask;

            res.once(
                'close',
                queuedTask.cancelHandler
            );

            backupQueue.push(
                queuedTask
            );

            await pumpBackupQueue();
            await slotPromise;
        } catch (error) {
            logSection(
                '❌ BACKUP PREPARE ERROR'
            );

            console.error(
                error
            );

            if (
                queuedTask &&
                !queuedTask.started
            ) {
                queuedTask.cancelled =
                    true;

                removeQueuedBackup(
                    queuedTask
                );
            }

            if (
                streamStarted
            ) {
                if (
                    !res.writableEnded
                ) {
                    try {
                        await writeNdjson(
                            res,
                            {
                                type:
                                    'error',
                                success:
                                    false,
                                error:
                                    errorMessage(
                                        error
                                    )
                            }
                        );
                    } catch {
                        // Klients var būt jau atvienojies.
                    }

                    if (
                        !res.writableEnded
                    ) {
                        res.end();
                    }
                }

                return;
            }

            const status =
                /abonements nav aktīvs/i.test(
                    errorMessage(
                        error
                    )
                )
                    ? 403
                    : 500;

            return res
                .status(
                    status
                )
                .json({
                    success:
                        false,
                    error:
                        errorMessage(
                            error
                        )
                });
        } finally {
            if (
                queuedTask?.cancelHandler
            ) {
                res.off(
                    'close',
                    queuedTask.cancelHandler
                );
            }

            if (
                queuedTask &&
                !queuedTask.started
            ) {
                queuedTask.cancelled =
                    true;

                removeQueuedBackup(
                    queuedTask
                );
            }

            if (
                archive?.zipfile
            ) {
                try {
                    archive.zipfile.close();
                } catch {
                    // ZIP jau var būt aizvērts.
                }
            }

            if (
                archive?.tempPath
            ) {
                await fs.promises
                    .unlink(
                        archive.tempPath
                    )
                    .catch(
                        () => {}
                    );
            }
        }
    }
);

// -----------------------------------------------------------------------------
// Upload transaction persistence.
// -----------------------------------------------------------------------------

app.post(
    '/api/save-zip-tx',
    backupLimiter,
    async (
        req,
        res
    ) => {
        try {
            assertSameOrigin(
                req
            );

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

            if (
                !validateJobId(
                    jobId
                )
            ) {
                throw new Error(
                    'Nederīgs jobId.'
                );
            }

            if (
                typeof zipTxId !==
                    'string' ||
                !validateArweaveId(
                    zipTxId
                )
            ) {
                throw new Error(
                    'Nederīgs ZIP transakcijas ID.'
                );
            }

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
                        {
                            ...job,
                            walletAddress:
                                wallet
                        }
                    );

                    if (
                        job.zipTxId &&
                        job.zipTxId !==
                            zipTxId
                    ) {
                        throw new Error(
                            'ZIP transakcijas ID nevar mainīt.'
                        );
                    }

                    await updateJob(
                        jobId,
                        {
                            zipTxId,
                            status:
                                'zip-uploaded',
                            updatedAt:
                                Date.now()
                        },
                        JOB_TTL_SECONDS
                    );

                    return res.json({
                        success:
                            true
                    });
                }
            );
        } catch (error) {
            const message =
                errorMessage(
                    error
                );

            const status =
                /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nevar mainīt/i.test(
                    message
                )
                    ? 400
                    : 500;

            return res
                .status(
                    status
                )
                .json({
                    success:
                        false,
                    error:
                        message
                });
        }
    }
);

app.post(
    '/api/save-manifest-tx',
    backupLimiter,
    async (
        req,
        res
    ) => {
        try {
            assertSameOrigin(
                req
            );

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

            if (
                !validateJobId(
                    jobId
                )
            ) {
                throw new Error(
                    'Nederīgs jobId.'
                );
            }

            if (
                typeof manifestTxId !==
                    'string' ||
                !validateArweaveId(
                    manifestTxId
                )
            ) {
                throw new Error(
                    'Nederīgs manifesta transakcijas ID.'
                );
            }

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
                        {
                            ...job,
                            walletAddress:
                                wallet
                        }
                    );

                    if (
                        !job.zipTxId
                    ) {
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
                            'Manifesta transakcijas ID nevar mainīt.'
                        );
                    }

                    if (
                        manifest.archive?.id !==
                        job.zipTxId
                    ) {
                        throw new Error(
                            'Manifesta archive ID nesakrīt ar ZIP transakciju.'
                        );
                    }

                    await updateJob(
                        jobId,
                        {
                            manifestTxId,
                            manifest,
                            status:
                                'manifest-uploaded',
                            updatedAt:
                                Date.now()
                        },
                        JOB_TTL_SECONDS
                    );

                    return res.json({
                        success:
                            true
                    });
                }
            );
        } catch (error) {
            const message =
                errorMessage(
                    error
                );

            const status =
                /nav atrasts|nav github|nesakrīt|nepieder|nederīgs|nevar mainīt/i.test(
                    message
                )
                    ? 400
                    : 500;

            return res
                .status(
                    status
                )
                .json({
                    success:
                        false,
                    error:
                        message
                });
        }
    }
);

app.get(
    '/api/job/:jobId',
    backupLimiter,
    async (
        req,
        res
    ) => {
        try {
            assertSameOrigin(
                req
            );

            if (
                !requireGithubSession(
                    req,
                    res
                )
            ) {
                return;
            }

            const {
                jobId
            } = req.params;

            if (
                !validateJobId(
                    jobId
                )
            ) {
                return res.status(400).json({
                    success:
                        false,
                    error:
                        'Nederīgs jobId.'
                });
            }

            const job =
                await getJob(
                    jobId
                );

            if (
                !job ||
                job.githubUser !==
                    req.session.githubUser
            ) {
                return res.status(404).json({
                    success:
                        false,
                    error:
                        'Backup job nav atrasts.'
                });
            }

            return res.json({
                success:
                    true,
                job
            });
        } catch (error) {
            return res.status(500).json({
                success:
                    false,
                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

app.get(
    '*',
    (
        req,
        res
    ) => {
        return res.sendFile(
            path.join(
                __dirname,
                'dist',
                'index.html'
            )
        );
    }
);

const server =
    app.listen(
        PORT,
        () => {
            logSection(
                '🚀 PermRepo server started'
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
                'Max repo files',
                MAX_REPO_FILES
            );

            logInfo(
                'Max repo bytes',
                MAX_REPO_BYTES
            );

            logInfo(
                'Max file bytes',
                MAX_FILE_BYTES
            );

            logInfo(
                'Max ZIP bytes',
                MAX_ZIP_BYTES
            );

            logInfo(
                'Backup RAM budget',
                `${BACKUP_MEMORY_BUDGET_BYTES} bytes`
            );

            logInfo(
                'Backup RAM hard limit',
                `${BACKUP_MEMORY_HARD_LIMIT_BYTES} bytes`
            );

            logInfo(
                'Backup RAM multiplier',
                BACKUP_MEMORY_PER_FILE_MULTIPLIER
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

process.on(
    'SIGTERM',
    () => {
        server.close(
            () => {
                process.exit(
                    0
                );
            }
        );
    }
);

process.on(
    'SIGINT',
    () => {
        server.close(
            () => {
                process.exit(
                    0
                );
            }
        );
    }
);
