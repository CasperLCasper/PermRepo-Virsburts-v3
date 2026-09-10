// server.js - Express API, bez privātās atslēgas, ar ENV mainīgajiem

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';

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

const PORT = process.env.PORT || 3000;

const ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY;
const CHAIN_ID = process.env.CHAIN_ID;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL;
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL;

const MAX_REPO_FILES = Number(process.env.MAX_REPO_FILES || 5000);
const MAX_REPO_BYTES = Number(process.env.MAX_REPO_BYTES || 524288000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 104857600);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || 3600);
const DOWNLOAD_CONCURRENCY = 3;

// Validācija - pārbauda obligātos ENV mainīgos
if (!CHAIN_ID) {
    console.error('❌ CHAIN_ID nav iestatīts!');
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
    if (error && typeof error.message === 'string') return error.message;
    return String(error);
}

function parseChainId(value) {
    if (typeof value === 'string' && value.startsWith('0x')) return Number.parseInt(value, 16);
    return Number(value);
}

const EXPECTED_CHAIN_ID = parseChainId(CHAIN_ID);

function safeWallet(address) {
    try { return ethers.getAddress(address); } catch { return null; }
}

function validateJobId(jobId) {
    return typeof jobId === 'string' && /^[a-f0-9-]{20,100}$/i.test(jobId);
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; " +
        "font-src 'self'; " +
        "connect-src 'self' https://ar-io.dev https://arweave.net https://api.github.com https://github.com https://sepolia.base.org https://base-sepolia-rpc.publicnode.com https://upload.services.ar-io.dev https://payment.services.ar-io.dev; " +
        "form-action 'self' https://github.com; " +
        "frame-ancestors 'none'; " +
        "object-src 'none';"
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
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,
        httpOnly: true, 
        sameSite: 'lax',
        maxAge: 3600000 
    }
}));

const githubApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, error: 'Pārāk daudz GitHub operāciju — mēģini vēlāk.' },
    keyGenerator: (req) => req.session.githubUser || req.ip
});

class GitHubRateLimiter {
    constructor() {
        this.remaining = 5000;
        this.resetTime = null;
        this.lastRequestTime = 0;
        this.minInterval = 100;
    }

    async checkRateLimit() {
        if (this.remaining < 100) {
            const waitTime = this.resetTime 
                ? this.resetTime - Date.now() + 1000 
                : 60 * 60 * 1000;
            
            if (waitTime > 0) {
                console.warn(`⏳ GitHub rate limit zems (${this.remaining}), gaidu ${Math.ceil(waitTime / 1000)}s`);
                
                if (waitTime > 5 * 60 * 1000) {
                    throw new Error(`GitHub rate limit gandrīz sasniegts. Atgriezies pēc ${Math.ceil(waitTime / 60000)} minūtēm.`);
                }
                
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }

    async makeRequest(url, options) {
        await this.checkRateLimit();
        
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < this.minInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLast));
        }
        
        this.lastRequestTime = Date.now();
        const response = await fetch(url, options);
        
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = response.headers.get('x-ratelimit-reset');
        
        // ✅ LABOTS: Number.parseInt vietā parseInt
        if (remaining) this.remaining = Number.parseInt(remaining, 10);
        if (reset) this.resetTime = Number.parseInt(reset, 10) * 1000;
        
        return response;
    }
}

const githubRateLimiterInstance = new GitHubRateLimiter();

async function fetchWithRetry(url, options, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        const response = await githubRateLimiterInstance.makeRequest(url, options);
        
        if (response.status === 403 || response.status === 429) {
            const backoff = Math.pow(2, attempt) * 1000;
            console.warn(`HTTP ${response.status} — mēģina pēc ${backoff}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            continue;
        }
        
        if (!response.ok) {
            throw new Error(`GitHub API kļūda: ${response.status}`);
        }
        
        return response;
    }
    
    throw new Error('GitHub API pieprasījums neizdevās pēc vairākiem mēģinājumiem.');
}

function createOAuthState() {
    return crypto.randomBytes(32).toString('hex');
}

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.status(500).json({ success: false, error: 'GitHub OAuth nav konfigurēts' });
    const state = createOAuthState();
    req.session.oauthState = state;
    const scope = 'repo read:org';
    const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope, redirect_uri: GITHUB_REDIRECT_URI, state });
    return res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/api/github/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.redirect('/?error=no_code');
    if (!state || !req.session.oauthState || !crypto.timingSafeEqual(Buffer.from(String(state)), Buffer.from(String(req.session.oauthState)))) {
        return res.redirect('/?error=oauth_state');
    }
    delete req.session.oauthState;
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.redirect('/?error=token');
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        if (!userResponse.ok) return res.redirect('/?error=github_user');
        const userData = await userResponse.json();
        req.session.regenerate(regenerateError => {
            if (regenerateError) return res.redirect('/?error=session');
            req.session.githubToken = tokenData.access_token;
            req.session.githubUser = userData.login;
            req.session.githubAvatar = userData.avatar_url;
            return res.redirect('/?auth=success');
        });
    } catch {
        return res.redirect('/?error=oauth');
    }
});

app.get('/api/github/logout', (req, res) => {
    req.session.destroy(() => { res.json({ success: true }); });
});

app.get('/api/github/user', (req, res) => {
    if (req.session.githubUser) {
        return res.json({ success: true, user: req.session.githubUser, avatar: req.session.githubAvatar || null });
    }
    return res.json({ success: false });
});

app.get('/api/github/repos', githubApiLimiter, async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts' });
    try {
        const response = await fetchWithRetry('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        const repos = await response.json();
        return res.json({ success: true, repos });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        chainId: CHAIN_ID,
        nftAddress: process.env.NFT_ADDRESS,
        subscriptionAddress: process.env.SUBSCRIPTION_ADDRESS,
        usdcAddress: process.env.USDC_ADDRESS,
        arweaveGateway: ARWEAVE_GATEWAY,
        rpcUrl: process.env.RPC_URL,
        turboUploadUrl: TURBO_UPLOAD_URL,
        turboPaymentUrl: TURBO_PAYMENT_URL
    });
});

const SUBSCRIPTION_ABI = [
    "function isSubscribed(bytes32 githubHash) external view returns (bool)",
    "function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)",
    "function getRemainingTime(bytes32 githubHash) external view returns (uint256)",
    "function subscriptionPrice() external view returns (uint256)"
];

app.get('/api/subscription/status', async (req, res) => {
    try {
        const githubUser = req.session.githubUser;
        if (!githubUser) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        
        const subscriptionAddress = process.env.SUBSCRIPTION_ADDRESS;
        if (!subscriptionAddress) {
            return res.json({ success: true, isSubscribed: false, expiry: '0', remainingTime: '0', price: '0', githubUser });
        }
        
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, EXPECTED_CHAIN_ID);
        const subscriptionContract = new ethers.Contract(subscriptionAddress, SUBSCRIPTION_ABI, provider);
        const githubHash = ethers.keccak256(ethers.toUtf8Bytes(githubUser));
        
        const isSubscribed = await subscriptionContract.isSubscribed(githubHash);
        const expiry = await subscriptionContract.getSubscriptionExpiry(githubHash);
        const remainingTime = await subscriptionContract.getRemainingTime(githubHash);
        const price = await subscriptionContract.subscriptionPrice();
        
        return res.json({ 
            success: true, 
            isSubscribed, 
            expiry: expiry.toString(), 
            remainingTime: remainingTime.toString(), 
            price: price.toString(), 
            githubUser 
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

async function downloadSingleFile(githubToken, file) {
    if (file.size > MAX_FILE_BYTES) {
        throw new Error(`Fails ${file.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`);
    }
    
    const fileResponse = await fetchWithRetry(file.download_url, {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/octet-stream' }
    });
    
    const contentLength = fileResponse.headers.get('content-length');
    // ✅ LABOTS: Number.parseInt vietā parseInt
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_BYTES) {
        throw new Error(`Fails ${file.path} pārsniedz izmēra limitu.`);
    }
    
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    if (fileBuffer.length > MAX_FILE_BYTES) {
        throw new Error(`Fails ${file.path} pārsniedz izmēra limitu.`);
    }
    
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    return { path: file.path, size: fileBuffer.length, content: fileBuffer.toString('base64'), hash };
}

async function getRepoFiles(githubToken, owner, repo, repoPath = '', state = null) {
    const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
    const repoRegex = /^[a-zA-Z0-9_.-]{1,100}$/;
    const pathRegex = /^[a-zA-Z0-9_./-]*$/;
    
    if (!state) {
        state = { files: [], totalBytes: 0, visited: new Set() };
    }
    
    if (!owner || !repo) throw new Error('Nederīgs owner vai repo');
    if (!ownerRegex.test(owner)) throw new Error('Nederīgs owner nosaukums');
    if (!repoRegex.test(repo)) throw new Error('Nederīgs repo nosaukums');
    if (repoPath && !pathRegex.test(repoPath)) throw new Error('Nederīgs repo ceļš');
    
    const encodedPath = repoPath ? repoPath.split('/').map(part => encodeURIComponent(part)).join('/') : '';
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    const url = encodedPath ? `${baseUrl}/${encodedPath}` : baseUrl;
    
    if (state.visited.has(url)) return state.files;
    state.visited.add(url);
    
    const response = await fetchWithRetry(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    
    const contents = await response.json();
    if (!Array.isArray(contents)) return state.files;
    
    const filesToDownload = [];
    const subDirs = [];
    
    for (const item of contents) {
        if (state.files.length >= MAX_REPO_FILES) {
            throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
        }
        if (item.type === 'file') {
            const size = Number(item.size || 0);
            if (size > MAX_FILE_BYTES) {
                throw new Error(`Fails ${item.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`);
            }
            if (item.download_url) {
                filesToDownload.push(item);
            }
        } else if (item.type === 'dir') {
            subDirs.push(item);
        }
    }
    
    for (let i = 0; i < filesToDownload.length; i += DOWNLOAD_CONCURRENCY) {
        const batch = filesToDownload.slice(i, i + DOWNLOAD_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(file => downloadSingleFile(githubToken, file))
        );
        for (const result of batchResults) {
            state.totalBytes += result.size;
            if (state.totalBytes > MAX_REPO_BYTES) {
                throw new Error(`Repo pārsniedz maksimālo izmēru (${MAX_REPO_BYTES} bytes).`);
            }
            state.files.push(result);
            if (state.files.length >= MAX_REPO_FILES) {
                throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
            }
        }
    }
    
    for (const dir of subDirs) {
        await getRepoFiles(githubToken, owner, repo, dir.path, state);
    }
    
    return state.files;
}

app.post('/api/prepare-backup', githubApiLimiter, async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        const githubUser = req.session.githubUser;
        
        logSection('📥 PREPARE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (typeof repoName !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName)) {
            return res.status(400).json({ success: false, error: 'Nederīgs repo nosaukums' });
        }
        if (!githubToken) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        if (!githubUser) return res.status(401).json({ success: false, error: 'Nav GitHub lietotāja' });
        
        const currentFiles = await getRepoFiles(githubToken, githubUser, repoName);
        if (currentFiles.length === 0) return res.status(400).json({ success: false, error: 'Nav failu repo' });
        
        const jobId = crypto.randomUUID();
        
        const job = {
            version: 2,
            jobId,
            githubUser,
            repoName,
            fullRepoName: `${githubUser}/${repoName}`,
            walletAddress,
            changedFiles: currentFiles.map(file => ({ path: file.path, hash: file.hash, size: file.size })),
            status: 'prepared',
            zipTxId: null,
            manifestTxId: null,
            manifest: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        await createJob(jobId, job, JOB_TTL_SECONDS);
        
        return res.json({
            success: true,
            jobId,
            repoName: `${githubUser}/${repoName}`,
            files: currentFiles,
            fileCount: currentFiles.length,
            totalBytes: currentFiles.reduce((sum, file) => sum + Number(file.size), 0)
        });
    } catch (error) {
        logSection('❌ BACKUP PREPARE ERROR');
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.post('/api/save-zip-tx', async (req, res) => {
    const { jobId, zipTxId } = req.body;
    
    try {
        if (!validateJobId(jobId)) return res.status(400).json({ success: false, error: 'Nederīgs jobId' });
        if (!zipTxId || typeof zipTxId !== 'string') return res.status(400).json({ success: false, error: 'Nav zipTxId' });
        
        await updateJob(jobId, {
            zipTxId,
            status: 'zip_uploaded',
            updatedAt: Date.now()
        });
        
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.post('/api/save-manifest-tx', async (req, res) => {
    const { jobId, manifestTxId, manifest } = req.body;
    
    try {
        if (!validateJobId(jobId)) return res.status(400).json({ success: false, error: 'Nederīgs jobId' });
        if (!manifestTxId || typeof manifestTxId !== 'string') return res.status(400).json({ success: false, error: 'Nav manifestTxId' });
        
        await updateJob(jobId, {
            manifestTxId,
            manifest,
            status: 'manifest_uploaded',
            updatedAt: Date.now()
        });
        
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        configured: {
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_REDIRECT_URI),
            redis: !!getRedis()
        }
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    logSection('🚀 PERMAREPO SERVERIS (Vite + React)');
    logInfo('Ports', PORT);
    logInfo('Chain ID', CHAIN_ID);
    logInfo('Redis', getRedis() ? '✅ IR' : '❌ NAV');
    logInfo('Turbo Upload', TURBO_UPLOAD_URL || '❌ NAV');
    logInfo('Turbo Payment', TURBO_PAYMENT_URL || '❌ NAV');
    console.log('='.repeat(60) + '\n');
});
