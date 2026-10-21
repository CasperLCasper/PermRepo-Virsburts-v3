import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useLanguage } from './LanguageContext';
import { TurboFactory } from '@ardrive/turbo-sdk/web';
import { InjectedEthereumSigner } from '@dha-team/arbundles';

const NFT_ABI = [
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

function Icon({ name }) {
    return <img src={`/icons/${name}.svg`} className="icon-inline" alt="" aria-hidden="true" />;
}

const ALLOWED_GATEWAY_HOSTS = [
    'arweave.net',
    'ar-io.dev',
    'turbo-gateway.com',
    'gateway.arweave.net'
];

const ALLOWED_SCHEMES = ['https:'];

function isValidManifestId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(id);
}

function getValidatedManifestUrl(gatewayUrl, manifestId, t) {
    if (!isValidManifestId(manifestId)) {
        throw new Error(t('invalid-manifest-id'));
    }
    
    let parsedUrl;
    try {
        parsedUrl = new URL(gatewayUrl);
    } catch (e) {
        throw new Error(t('invalid-gateway-url'));
    }
    
    if (!ALLOWED_SCHEMES.includes(parsedUrl.protocol)) {
        throw new Error(t('invalid-scheme'));
    }
    
    if (!ALLOWED_GATEWAY_HOSTS.includes(parsedUrl.hostname)) {
        throw new Error(t('invalid-gateway-host'));
    }
    
    return `${parsedUrl.origin}/raw/${encodeURIComponent(manifestId)}`;
}

function getSafeErrorMessage(error, t) {
    if (!error) return t('unknown-error');
    if (typeof error === 'string') return error.substring(0, 200);
    if (error.message && typeof error.message === 'string') {
        return error.message.substring(0, 200);
    }
    return t('unknown-error');
}

function BackupPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { currentLanguage, t, switchLanguage } = useLanguage();
    
    const [config, setConfig] = useState(null);
    const repoName = searchParams.get('repo');
    const repositoryId = searchParams.get('repoId');
    const repositoryFullName = searchParams.get('repoFullName');
    const repoStorageKey = repositoryId && /^\d+$/.test(repositoryId) ? repositoryId : repoName;
    const [githubUser, setGithubUser] = useState(null);
    const [githubUserId, setGithubUserId] = useState(null);
    const [userAddress, setUserAddress] = useState(null);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [backupCompleted, setBackupCompleted] = useState(false);
    const [recoveryRequired, setRecoveryRequired] = useState(false);
    const [lastManifestTxId, setLastManifestTxId] = useState(null);
    const [queuePosition, setQueuePosition] = useState(null);
    
    const [nftInfo, setNftInfo] = useState({
        tokenId: null,
        backupCount: null,
        lastManifest: null,
        lastMerkleRoot: null
    });
    
    const [currentUnchangedFiles, setCurrentUnchangedFiles] = useState(Object.create(null));
    const [currentPreviousHistory, setCurrentPreviousHistory] = useState([]);
    const [currentPreviousManifestId, setCurrentPreviousManifestId] = useState(null);
    const [currentPreviousBackupNumber, setCurrentPreviousBackupNumber] = useState(null);
    const [currentPreviousEncryptionIVs, setCurrentPreviousEncryptionIVs] = useState(Object.create(null));
    const [currentMerkleRoot, setCurrentMerkleRoot] = useState(null);
    const [currentIV, setCurrentIV] = useState(null);
    
    const [lastStatusData, setLastStatusData] = useState(null);
    
    const [fileInfo, setFileInfo] = useState({ count: 0, sizeText: '', loading: true });
    const [changedFilesForUpload, setChangedFilesForUpload] = useState([]);
    const [unchangedFilesForUpload, setUnchangedFilesForUpload] = useState(Object.create(null));
    const [preparedJobId, setPreparedJobId] = useState(null);
    const [recoveredJobData, setRecoveredJobData] = useState(null);

    const masterKeyRef = useRef(null);
    const uploadedZipRef = useRef({ txId: null, iv: null, merkleRoot: null });
    const uploadedManifestRef = useRef({ txId: null, manifest: null });
    const submittedBackupTxHashRef = useRef(null);
    const previousManifestRef = useRef(null);

    const apiJson = useCallback(async (url, options = {}) => {
        const response = await fetch(url, { credentials: 'same-origin', ...options });
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error(`${t('server-error')} ${response.status}`);
        }
        if (!response.ok && !result.success) {
            const err = new Error(result.error || `HTTP ${response.status}`);
            err.status = response.status;
            err.recoveryRequired = result.recoveryRequired;
            err.backupTxHash = result.backupTxHash;
            throw err;
        }
        return result;
    }, [t]);

    // Vienkāršs lokāls atkopšanas žurnāls: glabā tikai mazos kontrolpunktus,
    // nevis failu saturu vai pilnu manifestu.
    const recoveryJournalStorageKey = `permrepo-recovery-${repoStorageKey}`;

    const readRecoveryJournal = useCallback(() => {
        try {
            const raw = localStorage.getItem(recoveryJournalStorageKey);
            if (!raw) return null;
            const value = JSON.parse(raw);
            return value && typeof value === 'object' && !Array.isArray(value)
                ? value
                : null;
        } catch {
            return null;
        }
    }, [recoveryJournalStorageKey]);

    const updateRecoveryJournal = useCallback((patch) => {
        try {
            const previous = readRecoveryJournal() || {};
            const next = {
                ...previous,
                ...patch,
                updatedAt: Date.now()
            };
            localStorage.setItem(recoveryJournalStorageKey, JSON.stringify(next));
            return true;
        } catch (storageError) {
            console.warn('Neizdevās saglabāt lokālo atkopšanas kontrolpunktu:', storageError);
            return false;
        }
    }, [readRecoveryJournal, recoveryJournalStorageKey]);

    const clearRecoveryJournal = useCallback(() => {
        try { localStorage.removeItem(recoveryJournalStorageKey); } catch {}
    }, [recoveryJournalStorageKey]);

    // Redis kļūmes gadījumā mēģina atkārtoti tikai īslaicīgas/servera kļūmes.
    // Lokālais kontrolpunkts jau ir saglabāts pirms šīs funkcijas izsaukšanas.
    const apiJsonWithRetry = useCallback(async (url, options = {}, attempts = 3) => {
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await apiJson(url, options);
            } catch (err) {
                lastError = err;
                const retryable = !err.status || err.status >= 500;
                if (!retryable || attempt === attempts - 1) throw err;
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            }
        }
        throw lastError || new Error(t('unknown-error'));
    }, [apiJson, t]);

    const formatFileSize = useCallback((bytes) => {
        const value = Number(bytes || 0);
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
        if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
        return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }, []);

    const isValidMasterKey = useCallback((value) => {
        try {
            if (typeof value !== 'string') return false;
            const normalized = value.trim();
            if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) return false;
            return ethers.getBytes(normalized).length === 32;
        } catch { return false; }
    }, []);

    const calculateMerkleRoot = useCallback((files) => {
        const fileHashes = files.map(file => ethers.keccak256(ethers.toUtf8Bytes(file.hash || '')));
        if (fileHashes.length === 0) return '0x0000000000000000000000000000000000000000000000000000000000000000';
        return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes]));
    }, []);

    // One user-facing Master Key; HKDF-SHA-256 derives purpose-separated subkeys.
    // These protocol labels and salt are fixed for crypto format v1 and must match restore.js.
    const deriveSubkeyBytes = useCallback(async (keyHex, purpose) => {
        const keyBytes = ethers.getBytes(keyHex);
        if (keyBytes.length !== 32) throw new Error(t('encrypted-required'));
        const hkdfKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode('PermRepo HKDF salt v1'),
            info: new TextEncoder().encode(`PermRepo/v1/${purpose}`)
        }, hkdfKey, 256);
        return new Uint8Array(bits);
    }, [t]);

    const encryptData = useCallback(async (data, keyHex) => {
        const encryptionKeyBytes = await deriveSubkeyBytes(keyHex, 'aes-gcm');
        const cryptoKey = await crypto.subtle.importKey('raw', encryptionKeyBytes, 'AES-GCM', false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
        return { encrypted: new Uint8Array(encrypted), iv };
    }, [deriveSubkeyBytes]);

    // Verifier key is derived independently from the AES-GCM key.
    const createMasterKeyVerifier = useCallback(async (keyHex) => {
        const verifierKeyBytes = await deriveSubkeyBytes(keyHex, 'key-verifier');
        const hmacKey = await crypto.subtle.importKey(
            'raw', verifierKeyBytes,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const message = new TextEncoder().encode('PermRepo Master Key verifier v1');
        const signature = await crypto.subtle.sign('HMAC', hmacKey, message);
        return ethers.hexlify(new Uint8Array(signature));
    }, [deriveSubkeyBytes]);

    const promptMasterKey = useCallback(() => {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;z-index:1000;padding:20px;';
            const box = document.createElement('div');
            box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:100%;box-sizing:border-box;';
            const title = document.createElement('h2');
            title.textContent = t('key-title');
            title.style.cssText = 'color:#79c0ff;margin-bottom:16px;';
            const input = document.createElement('input');
            input.type = 'password';
            input.placeholder = t('enter-key');
            input.style.cssText = 'width:100%;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:16px;margin-bottom:16px;box-sizing:border-box;';
            const confirmButton = document.createElement('button');
            confirmButton.textContent = t('confirm-key');
            confirmButton.style.cssText = 'width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;';
            const cancelButton = document.createElement('button');
            cancelButton.textContent = t('cancel');
            cancelButton.style.cssText = 'width:100%;padding:12px;background:#30363d;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-top:8px;';
            box.appendChild(title);
            box.appendChild(input);
            box.appendChild(confirmButton);
            box.appendChild(cancelButton);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            
            const cleanup = () => { overlay.remove(); };
            const submit = () => {
                const value = input.value.trim();
                cleanup();
                resolve(value);
            };
            
            confirmButton.onclick = submit;
            cancelButton.onclick = () => { cleanup(); resolve(null); };
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                if (e.key === 'Escape') { cleanup(); resolve(null); }
            });
            input.focus();
        });
    }, [t]);

    const showMasterKey = useCallback((keyToShow) => {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;z-index:1000;padding:20px;';
            const box = document.createElement('div');
            box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:100%;box-sizing:border-box;';
            const title = document.createElement('h2');
            title.textContent = t('key-title');
            title.style.cssText = 'color:#79c0ff;margin-bottom:16px;';
            const description = document.createElement('p');
            description.textContent = t('key-description');
            description.style.cssText = 'color:#b0b8c4;margin-bottom:16px;';
            const keyBox = document.createElement('div');
            keyBox.textContent = keyToShow;
            keyBox.style.cssText = 'background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px;word-break:break-all;font-family:monospace;color:#e6edf3;';
            const copyButton = document.createElement('button');
            copyButton.textContent = t('copy-key');
            copyButton.style.cssText = 'width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-bottom:8px;';
            const downloadButton = document.createElement('button');
            downloadButton.textContent = t('download-key');
            downloadButton.style.cssText = 'width:100%;padding:12px;background:#21262d;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-bottom:8px;';
            const closeButton = document.createElement('button');
            closeButton.textContent = t('saving-key');
            closeButton.style.cssText = 'width:100%;padding:12px;background:#f85149;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;';
            box.appendChild(title);
            box.appendChild(description);
            box.appendChild(keyBox);
            box.appendChild(copyButton);
            box.appendChild(downloadButton);
            box.appendChild(closeButton);
            modal.appendChild(box);
            document.body.appendChild(modal);
            
            copyButton.onclick = async () => { 
                try { 
                    await navigator.clipboard.writeText(keyToShow); 
                    copyButton.textContent = '✅'; 
                } catch { 
                    copyButton.textContent = '❌'; 
                } 
            };
            
            downloadButton.onclick = () => {
                const blob = new Blob([keyToShow], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `permrepo-master-key-${repoName?.replace(/[^\w.-]/g, '_') || 'backup'}.txt`;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                URL.revokeObjectURL(url);
            };
            
            closeButton.onclick = () => { modal.remove(); resolve(true); };
        });
    }, [t, repoName]);

    const renderStatusFromData = useCallback(() => {
        if (!lastStatusData) return;
        
        const data = lastStatusData;
        
        switch(data.type) {
            case 'uploading':
                setStatus(t('uploading'));
                break;
            case 'success':
                setStatus(t(data.key));
                break;
            case 'simple':
                setStatus(t(data.key));
                break;
            case 'warning':
                setStatus(t(data.key));
                break;
            default:
                setStatus(t(data.key));
        }
    }, [lastStatusData, t]);

    useEffect(() => {
        if (lastStatusData) {
            renderStatusFromData();
        }
    }, [currentLanguage, lastStatusData, renderStatusFromData]);

    // ✅ Init ar browser reload recovery un localStorage tx hash
    useEffect(() => {
        let cancelled = false;
        let reader = null;

        const initPage = async () => {
            try {
                const configData = await apiJson('/api/config');
                if (cancelled) return;
                setConfig(configData);

                if (!repoName || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName) || !repositoryId || !/^\d+$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId)) || BigInt(repositoryId) <= 0n) {
                    setError(t('invalid-repo'));
                    setFileInfo({ count: 0, sizeText: '', loading: false });
                    return;
                }

                const userData = await apiJson('/api/github/user');
                if (!userData.success) {
                    window.location.href = '/api/github/login';
                    return;
                }
                setGithubUser(userData.user);
                setGithubUserId(String(userData.userId));

                if (!window.ethereum) {
                    setError(t('connect-wallet'));
                    setFileInfo({ count: 0, sizeText: '', loading: false });
                    return;
                }

                const provider = new ethers.BrowserProvider(window.ethereum);
                const accounts = await provider.send('eth_accounts', []);
                if (!accounts[0]) {
                    setError(t('connect-wallet'));
                    setFileInfo({ count: 0, sizeText: '', loading: false });
                    return;
                }

                const currentAddress = ethers.getAddress(accounts[0]);
                setUserAddress(currentAddress);

                const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
                if (Number.parseInt(currentChainId, 16) !== Number(configData.chainId)) {
                    try {
                        await window.ethereum.request({
                            method: 'wallet_switchEthereumChain',
                            params: [{ chainId: configData.chainId }]
                        });
                    } catch (switchError) {
                        if (switchError.code === 4902) {
                            await window.ethereum.request({
                                method: 'wallet_addEthereumChain',
                                params: [{
                                    chainId: configData.chainId,
                                    chainName: 'Base',
                                    rpcUrls: [configData.rpcUrl],
                                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                                }]
                            });
                        } else {
                            throw switchError;
                        }
                    }
                }

                // ✅ Recovery no localStorage
                const recoveryJournal = readRecoveryJournal();
                const storedJobId = localStorage.getItem(`permrepo-job-${repoStorageKey}`) || recoveryJournal?.jobId || null;
                const storedBackupTx = localStorage.getItem(`permrepo-backup-tx-${repoStorageKey}`) || recoveryJournal?.backupTxHash || null;
                let shouldStartNewBackup = !storedJobId;

                if (storedJobId) {
                    try {
                        const jobStatus = await apiJson(`/api/job-status?jobId=${encodeURIComponent(storedJobId)}`);

                        if (jobStatus.success) {
                            // Redis ir darba stāvokļa reģistrs; lokālais žurnāls var saturēt
                            // ID, kuru Turbo jau atdeva, bet Redis ieraksts vēl nav izdevies.
                            if (recoveryJournal) {
                                if (!jobStatus.zipTxId && recoveryJournal.zipTxId) {
                                    jobStatus.zipTxId = recoveryJournal.zipTxId;
                                    jobStatus.zipIv = recoveryJournal.zipIv || null;
                                    jobStatus.zipMerkleRoot = recoveryJournal.zipMerkleRoot || null;
                                }
                                if (!jobStatus.manifestTxId && recoveryJournal.manifestTxId) {
                                    jobStatus.manifestTxId = recoveryJournal.manifestTxId;
                                }
                                if (!jobStatus.backupTxHash && recoveryJournal.backupTxHash) {
                                    jobStatus.backupTxHash = recoveryJournal.backupTxHash;
                                }
                            }

                            // ✅ Ja jau completed — atjaunot nftInfo
                            if (jobStatus.status === 'completed') {
                                setNftInfo({
                                    tokenId: jobStatus.tokenId || null,
                                    backupCount: jobStatus.backupCount || null,
                                    lastManifest: jobStatus.manifestURI || null,
                                    lastMerkleRoot: jobStatus.merkleRoot || null
                                });
                                setLastManifestTxId(jobStatus.manifestTxId);
                                setBackupCompleted(true);
                                setStatus(t('backup-complete'));
                                setFileInfo({ count: 0, sizeText: '', loading: false });
                                localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                                localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                                clearRecoveryJournal();
                                return;
                            }

                            // ✅ Ja blockchain-finalizing ar backupTxHash
                            if (
                                jobStatus.status === 'blockchain-finalizing' &&
                                jobStatus.backupTxHash
                            ) {
                                setStatus(t('checking-blockchain-tx'));
                                setFileInfo({ count: 0, sizeText: '', loading: false });

                                try {
                                    await apiJson('/api/complete-backup', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            jobId: jobStatus.jobId,
                                            txHash: jobStatus.backupTxHash
                                        })
                                    });

                                    setNftInfo({
                                        tokenId: jobStatus.tokenId || null,
                                        backupCount: jobStatus.backupCount || null,
                                        lastManifest: jobStatus.manifestURI || null,
                                        lastMerkleRoot: jobStatus.merkleRoot || null
                                    });
                                    setLastManifestTxId(jobStatus.manifestTxId);
                                    setBackupCompleted(true);
                                    setStatus(t('backup-complete'));
                                    localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                                    localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                                    clearRecoveryJournal();
                                    return;
                                } catch (recoveryError) {
                                    setRecoveryRequired(true);
                                    setStatus(t('recovery-required'));
                                    setError(getSafeErrorMessage(recoveryError, t));
                                    return;
                                }
                            }

                            // ✅ Blockchain-finalizing BEZ backupTxHash, bet localStorage satur tx
                            if (
                                jobStatus.status === 'blockchain-finalizing' &&
                                !jobStatus.backupTxHash &&
                                storedBackupTx
                            ) {
                                setRecoveryRequired(true);
                                setStatus(t('recovery-required'));
                                setRecoveredJobData({
                                    ...jobStatus,
                                    jobId: jobStatus.jobId,
                                    backupTxHash: storedBackupTx
                                });
                                setFileInfo({ count: 0, sizeText: '', loading: false });
                                return;
                            }

                            // Testnet crypto v1 is intentionally not backward-compatible. Do not
                            // create a new-format manifest around a ZIP uploaded by the old format.
                            if (jobStatus.zipTxId && Number(jobStatus.cryptoVersion) !== 1 &&
                                !jobStatus.backupTxHash && !storedBackupTx) {
                                setRecoveredJobData({ ...jobStatus, freshStartRequired: true });
                                setRecoveryRequired(false);
                                setStatus(t('testnet-crypto-reset-required'));
                                setLastStatusData({ type: 'warning', key: 'testnet-crypto-reset-required' });
                                setFileInfo({ count: 0, sizeText: '', loading: false });
                                return;
                            }

                            // ✅ Ja ZIP ir — turpināt ar manifestu vai blockchain
                            if (jobStatus.zipTxId) {
                                setPreparedJobId(jobStatus.jobId);
                                setNftInfo({
                                    tokenId: jobStatus.tokenId,
                                    backupCount: jobStatus.backupCount || null,
                                    lastManifest: jobStatus.lastManifest || null,
                                    lastMerkleRoot: jobStatus.lastMerkleRoot || null
                                });

                                // Pēc reload iepriekšējā backup numurs jāatjauno no on-chain
                                // backupCount. Bez tā manifesta veidošana izmantoja fallback 1,
                                // un history ieraksts varēja izkrist.
                                const recoveredBackupCount = Number(jobStatus.backupCount);
                                if (Number.isSafeInteger(recoveredBackupCount) && recoveredBackupCount >= 0) {
                                    setCurrentPreviousBackupNumber(recoveredBackupCount);
                                }

                                if (jobStatus.changedFileMetadata?.length > 0) {
                                    setChangedFilesForUpload(jobStatus.changedFileMetadata);
                                }
                                if (jobStatus.unchangedFiles) {
                                    setUnchangedFilesForUpload(
                                        Object.assign(Object.create(null), jobStatus.unchangedFiles)
                                    );
                                }

                                uploadedZipRef.current = {
                                    txId: jobStatus.zipTxId,
                                    iv: jobStatus.zipIv || null,
                                    merkleRoot: jobStatus.zipMerkleRoot || null
                                };
                                updateRecoveryJournal({
                                    jobId: jobStatus.jobId,
                                    repositoryId: String(repositoryId),
                                    walletAddress: currentAddress,
                                    stage: jobStatus.manifestTxId ? 'manifest-uploaded' : 'zip-uploaded',
                                    cryptoVersion: jobStatus.cryptoVersion ?? null,
                                    zipTxId: jobStatus.zipTxId,
                                    zipIv: jobStatus.zipIv || null,
                                    zipMerkleRoot: jobStatus.zipMerkleRoot || null,
                                    manifestTxId: jobStatus.manifestTxId || null,
                                    backupTxHash: jobStatus.backupTxHash || null
                                });

                                previousManifestRef.current = null;
                                if (jobStatus.lastManifest?.startsWith('ar://')) {
                                    const prevManifestId = jobStatus.lastManifest.slice(5);
                                    
                                    if (isValidManifestId(prevManifestId)) {
                                        setCurrentPreviousManifestId(prevManifestId);
                                        
                                        try {
                                            const manifestUrl = getValidatedManifestUrl(
                                                configData.arweaveGateway,
                                                prevManifestId,
                                                t
                                            );
                                            const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
                                            
                                            if (manifestResponse.ok) {
                                                const prevManifest = await manifestResponse.json();
                                                previousManifestRef.current = prevManifest;
                                                
                                                if (Array.isArray(prevManifest?.history)) {
                                                    setCurrentPreviousHistory(prevManifest.history);
                                                }
                                                
                                                if (
                                                    prevManifest?.encryption?.ivs &&
                                                    typeof prevManifest.encryption.ivs === 'object' &&
                                                    !Array.isArray(prevManifest.encryption.ivs)
                                                ) {
                                                    setCurrentPreviousEncryptionIVs(
                                                        Object.assign(Object.create(null), prevManifest.encryption.ivs)
                                                    );
                                                }
                                                
                                                if (
                                                    prevManifest?.paths &&
                                                    typeof prevManifest.paths === 'object' &&
                                                    !Array.isArray(prevManifest.paths)
                                                ) {
                                                    setCurrentUnchangedFiles(
                                                        Object.assign(Object.create(null), prevManifest.paths)
                                                    );
                                                }
                                            }
                                        } catch (manifestError) {
                                            console.warn('Neizdevās ielādēt iepriekšējo manifestu:', manifestError);
                                        }
                                    }
                                }

                                // Ja manifesta ID jau ir lokāli vai Redis, bet lapa tika
                                // pārlādēta, manifesta JSON atgūst no publiskā Arweave gateway.
                                if (jobStatus.manifestTxId && !jobStatus.manifest) {
                                    try {
                                        const savedManifestUrl = getValidatedManifestUrl(
                                            configData.arweaveGateway,
                                            jobStatus.manifestTxId,
                                            t
                                        );
                                        const savedManifestResponse = await fetch(savedManifestUrl, { cache: 'no-store' });
                                        if (savedManifestResponse.ok) {
                                            jobStatus.manifest = await savedManifestResponse.json();
                                        }
                                    } catch (manifestRecoveryError) {
                                        console.warn('Neizdevās atgūt augšupielādēto manifestu:', manifestRecoveryError);
                                    }
                                }

                                if (jobStatus.manifestTxId && !jobStatus.manifest) {
                                    setRecoveredJobData(jobStatus);
                                    setRecoveryRequired(true);
                                    setStatus(t('recovery-required'));
                                    setError(t('recovery-manifest-fetch-failed'));
                                    setFileInfo({ count: 0, sizeText: '', loading: false });
                                    return;
                                }

                                const hasAnyUploadedArtifact = Boolean(
                                    jobStatus.zipTxId || jobStatus.manifestTxId || jobStatus.backupTxHash ||
                                    storedBackupTx || recoveryJournal?.zipTxId || recoveryJournal?.manifestTxId ||
                                    recoveryJournal?.backupTxHash
                                );
                                if (['failed', 'prepared', 'zip-uploading'].includes(jobStatus.status) && !hasAnyUploadedArtifact) {
                                    // Redis stores file metadata, not file contents. These states cannot
                                    // resume a ZIP upload after reload unless a ZIP ID was persisted.
                                    setRecoveredJobData({ ...jobStatus, freshStartRequired: true });
                                    setRecoveryRequired(false);
                                    setStatus(t('unfinished-backup-warning'));
                                    setLastStatusData({ type: 'warning', key: 'unfinished-backup-warning' });
                                    setFileInfo({ count: 0, sizeText: '', loading: false });
                                    return;
                                }

                                setRecoveredJobData(jobStatus);

                                if (jobStatus.status === 'failed') {
                                    setStatus(t('unfinished-backup-warning'));
                                    setLastStatusData({ type: 'warning', key: 'unfinished-backup-warning' });
                                } else {
                                    setStatus(t('recovery-ready'));
                                    // Saglabā tulkojamo statusa atslēgu, lai valodas maiņa
                                    // atjauninātu arī šo paziņojumu.
                                    setLastStatusData({ type: 'simple', key: 'recovery-ready' });
                                }
                                
                                const changedFiles = Array.isArray(jobStatus.changedFileMetadata)
                                    ? jobStatus.changedFileMetadata
                                    : [];
                                
                                setFileInfo({
                                    count: changedFiles.length,
                                    sizeText: formatFileSize(
                                        changedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0)
                                    ),
                                    loading: false
                                });
                                return;
                            }

                            localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                            localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                            clearRecoveryJournal();
                            shouldStartNewBackup = true;
                        }
                    } catch (recoveryError) {
                        if (recoveryError.status === 404) {
                            const journalHasUploadedData = Boolean(
                                recoveryJournal?.zipTxId ||
                                recoveryJournal?.manifestTxId ||
                                recoveryJournal?.backupTxHash ||
                                storedBackupTx
                            );
                            if (journalHasUploadedData) {
                                // Nedzēšam vienīgos atlikušos pierādījumus. Bez Redis darba
                                // ieraksta nevar droši turpināt automātiski.
                                setRecoveredJobData({ ...recoveryJournal, jobId: storedJobId, serverJobMissing: true });
                                setRecoveryRequired(true);
                                setStatus(t('recovery-required'));
                                setError(t('recovery-server-job-missing'));
                                setFileInfo({ count: 0, sizeText: '', loading: false });
                                return;
                            }
                            localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                            localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                            clearRecoveryJournal();
                            shouldStartNewBackup = true;
                        } else {
                            console.error('Neizdevās pārbaudīt backup job:', recoveryError);
                            setError(getSafeErrorMessage(recoveryError, t));
                            setFileInfo({ count: 0, sizeText: '', loading: false });
                            return;
                        }
                    }
                }

                if (shouldStartNewBackup) {
                    const response = await fetch('/api/prepare-backup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ repositoryId: Number(repositoryId), walletAddress: currentAddress })
                    });

                    if (!response.ok) {
                        let errorMessage = `HTTP ${response.status}`;
                        try {
                            const errorData = await response.json();
                            errorMessage = errorData.error || errorMessage;
                        } catch {}
                        throw new Error(errorMessage);
                    }

                    reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    const files = [];
                    let metadata = null;
                    let serverError = null;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (cancelled) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (!line.trim()) continue;

                            let parsed;
                            try {
                                parsed = JSON.parse(line);
                            } catch {
                                continue;
                            }

                            switch (parsed.type) {
                                case 'queued':
                                    setQueuePosition(parsed.queuePosition);
                                    setStatus(`${t('queued-position')}: ${parsed.queuePosition}`);
                                    setLastStatusData({ type: 'queued', position: parsed.queuePosition });
                                    break;
                                case 'queue-status':
                                    setQueuePosition(parsed.queuePosition);
                                    setStatus(`${t('queued-position')}: ${parsed.queuePosition}`);
                                    setLastStatusData({ type: 'queued', position: parsed.queuePosition });
                                    break;
                                case 'started':
                                    setQueuePosition(null);
                                    setStatus(t('processing'));
                                    setLastStatusData({ type: 'simple', key: 'processing' });
                                    break;
                                case 'meta':
                                    metadata = parsed;
                                    setNftInfo({
                                        tokenId: parsed.tokenId,
                                        backupCount: parsed.backupCount,
                                        lastManifest: parsed.lastManifest || null,
                                        lastMerkleRoot: parsed.lastMerkleRoot || null
                                    });
                                    setPreparedJobId(parsed.jobId);
                                    try {
                                        localStorage.setItem(
                                            `permrepo-job-${repoStorageKey}`,
                                            parsed.jobId
                                        );
                                    } catch {}
                                    updateRecoveryJournal({
                                        jobId: parsed.jobId,
                                        repositoryId: String(repositoryId),
                                        walletAddress: currentAddress,
                                        stage: 'prepared'
                                    });
                                    break;
                                case 'file':
                                    files.push(parsed.file);
                                    break;
                                case 'complete':
                                    metadata = { ...metadata, ...parsed };
                                    break;
                                case 'error':
                                    serverError = parsed.error;
                                    break;
                            }
                        }
                    }

                    if (cancelled) return;

                    if (serverError) {
                        throw new Error(serverError);
                    }

                    if (!metadata) {
                        throw new Error(t('backup-session-invalid'));
                    }

                    let previousPaths = Object.create(null);
                    let previousHistory = [];
                    let previousEncryptionIVs = Object.create(null);

                    previousManifestRef.current = null;
                    if (metadata.lastManifest && metadata.lastManifest.startsWith('ar://')) {
                        const prevManifestId = metadata.lastManifest.slice(5);
                        if (!isValidManifestId(prevManifestId)) {
                            throw new Error(t('invalid-manifest'));
                        }

                        setCurrentPreviousManifestId(prevManifestId);

                        const manifestUrl = getValidatedManifestUrl(configData.arweaveGateway, prevManifestId, t);
                        const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
                        if (!manifestResponse.ok) throw new Error(t('manifest-load-failed'));

                        const prevManifest = await manifestResponse.json();
                        previousManifestRef.current = prevManifest;
                        if (prevManifest && typeof prevManifest.paths === 'object' && !Array.isArray(prevManifest.paths)) {
                            previousPaths = Object.assign(Object.create(null), prevManifest.paths);
                            setCurrentUnchangedFiles(previousPaths);
                        }
                        if (Array.isArray(prevManifest?.history)) {
                            previousHistory = prevManifest.history;
                            setCurrentPreviousHistory(prevManifest.history);
                        }
                        if (prevManifest?.encryption?.ivs && typeof prevManifest.encryption.ivs === 'object' && !Array.isArray(prevManifest.encryption.ivs)) {
                            previousEncryptionIVs = Object.assign(Object.create(null), prevManifest.encryption.ivs);
                            setCurrentPreviousEncryptionIVs(previousEncryptionIVs);
                        }
                    }

                    const changedFiles = [];
                    const unchangedFiles = Object.create(null);

                    for (const file of files) {
                        const previousFile = previousPaths[file.path];
                        if (previousFile && previousFile.hash && previousFile.hash === file.hash && isValidManifestId(previousFile.id || previousFile.zipId)) {
                            unchangedFiles[file.path] = { id: previousFile.id || previousFile.zipId, hash: file.hash };
                        } else {
                            changedFiles.push(file);
                        }
                    }

                    setCurrentPreviousBackupNumber(Number(metadata.backupCount || 0));
                    setFileInfo({
                        count: changedFiles.length,
                        sizeText: formatFileSize(changedFiles.reduce((sum, file) => sum + Number(file.size), 0)),
                        loading: false
                    });
                    setChangedFilesForUpload(changedFiles);
                    setUnchangedFilesForUpload(unchangedFiles);
                    
                    setStatus('');
                    setLastStatusData(null);
                }
            } catch (e) {
                if (cancelled) return;
                setError(getSafeErrorMessage(e, t));
                setFileInfo({ count: 0, sizeText: '', loading: false });
            }
        };

        initPage();
        
        return () => { 
            cancelled = true;
            if (reader) {
                reader.cancel().catch(() => {});
            }
        };
    }, [
        apiJson, repoName, t, formatFileSize, repositoryId, repoStorageKey,
        readRecoveryJournal, updateRecoveryJournal, clearRecoveryJournal
    ]);

    const startFreshBackup = useCallback(() => {
        // This is an explicit user action. Clear only stale job/recovery pointers, then
        // reload so the existing initialization flow fetches the repository contents anew.
        try {
            localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
            localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
        } catch {}
        clearRecoveryJournal();
        uploadedZipRef.current = { txId: null, iv: null, merkleRoot: null };
        uploadedManifestRef.current = { txId: null, manifest: null };
        setRecoveredJobData(null);
        setRecoveryRequired(false);
        window.location.reload();
    }, [repoStorageKey, clearRecoveryJournal]);

    const continueBackup = useCallback(async () => {
        if (recoveredJobData?.freshStartRequired) {
            setError(t('recovery-upload-incomplete'));
            return;
        }
        if (!config) {
            setError(t('config-not-loaded'));
            return;
        }
        
        if (!window.ethereum || !userAddress) {
            setError(t('connect-wallet'));
            return;
        }
        
        if (changedFilesForUpload.length === 0 && !recoveredJobData) {
            setStatus(t('no-changes'));
            setLastStatusData({ type: 'simple', key: 'no-changes' });
            return;
        }
        
        try {
            setIsWorking(true);
            setError('');
            setRecoveryRequired(false);
            
            const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
            
            if (Number.parseInt(currentChainId, 16) !== Number(config.chainId)) {
                try {
                    await window.ethereum.request({ 
                        method: 'wallet_switchEthereumChain', 
                        params: [{ chainId: config.chainId }] 
                    });
                } catch (switchError) {
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: config.chainId,
                                chainName: 'Base',
                                rpcUrls: [config.rpcUrl],
                                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                            }]
                        });
                    } else {
                        throw switchError;
                    }
                }
            }
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signerInstance = await provider.getSigner();
            const client = TurboFactory.authenticated({
                signer: new InjectedEthereumSigner({ getSigner: () => signerInstance }),
                token: 'base-eth',
                gatewayUrl: config.rpcUrl,
                uploadServiceConfig: { url: config.turboUploadUrl },
                paymentServiceConfig: { url: config.turboPaymentUrl }
            });
            const backupCount = Number(nftInfo.backupCount || 0);
            
            const isRecoveryWithExistingZip = Boolean(
                recoveredJobData?.zipTxId ||
                uploadedZipRef.current.txId
            );

            let keyHex;
            
            if (backupCount === 0 && !isRecoveryWithExistingZip) {
                if (!masterKeyRef.current) {
                    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
                    masterKeyRef.current = ethers.hexlify(keyBytes);
                    const saved = await showMasterKey(masterKeyRef.current);
                    if (!saved) {
                        masterKeyRef.current = null;
                        setIsWorking(false);
                        return;
                    }
                }
                keyHex = masterKeyRef.current;
            } else {
                keyHex = await promptMasterKey();
                if (!isValidMasterKey(keyHex)) {
                    setError(t('encrypted-required'));
                    setIsWorking(false);
                    return;
                }

                // A new manifest must never relabel older ZIPs as encrypted by a different
                // Master Key. Verify the candidate against the previous manifest first.
                if (Number(backupCount) > 0) {
                    const previousVerifier = previousManifestRef.current?.encryption?.keyVerifier;
                    if (typeof previousVerifier !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(previousVerifier)) {
                        throw new Error(t('previous-key-verifier-missing'));
                    }
                    const enteredVerifier = await createMasterKeyVerifier(keyHex);
                    if (enteredVerifier.toLowerCase() !== previousVerifier.toLowerCase()) {
                        setError(t('master-key-mismatch'));
                        setIsWorking(false);
                        return;
                    }
                }
                masterKeyRef.current = keyHex;
            }
            
            await uploadZip(
                preparedJobId,
                changedFilesForUpload,
                unchangedFilesForUpload,
                keyHex,
                client,
                signerInstance
            );
            
        } catch (e) {
            if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
                setError(t('transaction-cancelled'));
            } else {
                setError(getSafeErrorMessage(e, t));
            }
            setIsWorking(false);
        }
    }, [
        config, userAddress, nftInfo.backupCount, repoName, t,
        changedFilesForUpload, unchangedFilesForUpload, preparedJobId,
        showMasterKey, promptMasterKey, isValidMasterKey, recoveredJobData,
        createMasterKeyVerifier
    ]);

    const uploadZip = useCallback(async (
        jobId,
        changedFiles,
        unchangedFiles,
        keyHex,
        client,
        signerInstance
    ) => {
        if (!config || !jobId || !nftInfo.tokenId) {
            setError(t('backup-session-invalid'));
            return;
        }

        setStatus(t('creating-zip'));
        setLastStatusData({ type: 'simple', key: 'creating-zip' });

        try {
            let zipTxId = uploadedZipRef.current.txId || recoveredJobData?.zipTxId;
            let iv = uploadedZipRef.current.iv;
            let merkleRoot = uploadedZipRef.current.merkleRoot;

            // Saglabājam zināmo ZIP ID Redis arī atkopšanas laikā. Endpoint ir
            // idempotents, tāpēc tas droši salāgo lokālo žurnālu ar servera stāvokli.
            if (zipTxId) {
                if (!updateRecoveryJournal({
                    jobId,
                    repositoryId: String(repositoryId),
                    walletAddress: userAddress,
                    stage: 'zip-uploaded-locally',
                    cryptoVersion: 1,
                    zipTxId,
                    zipIv: iv ? Array.from(iv) : null,
                    zipMerkleRoot: merkleRoot || null
                })) {
                    throw new Error(t('recovery-journal-save-failed'));
                }
                await apiJsonWithRetry('/api/save-zip-tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId, zipTxId, iv, merkleRoot, cryptoVersion: 1 })
                });
            } else if (!zipTxId) {
                await apiJson('/api/start-zip-upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId })
                });

                const zip = new JSZip();

                for (const file of changedFiles) {
                    if (typeof file.content !== 'string') {
                        throw new Error(t('invalid-file-data'));
                    }

                    const binaryString = atob(file.content);
                    const fileBuffer = new Uint8Array(binaryString.length);

                    for (let j = 0; j < binaryString.length; j++) {
                        fileBuffer[j] = binaryString.charCodeAt(j);
                    }

                    zip.file(file.path, fileBuffer);
                }

                const zipBuffer = await zip.generateAsync({
                    type: 'uint8array',
                    compression: 'DEFLATE',
                    compressionOptions: { level: 6 }
                });

                setStatus(t('encrypting'));
                setLastStatusData({ type: 'simple', key: 'encrypting' });

                const encrypted = await encryptData(zipBuffer, keyHex);
                const encryptedZipData = encrypted.encrypted;
                iv = encrypted.iv;
                merkleRoot = calculateMerkleRoot(changedFiles);

                setCurrentIV(iv);
                setCurrentMerkleRoot(merkleRoot);

                setStatus(t('uploading'));
                setLastStatusData({ type: 'uploading' });

                const zipBlob = new Blob([encryptedZipData], { type: 'application/zip' });

                const zipResult = await client.uploadFile({
                    fileStreamFactory: () => zipBlob.stream(),
                    fileSizeFactory: () => zipBlob.size,
                    dataItemOpts: {
                        tags: [
                            { name: 'App-Name', value: 'PermRepo' },
                            { name: 'Repo', value: `${githubUser}/${repoName}` },
                            { name: 'Type', value: 'backup-archive' },
                            { name: 'Content-Type', value: 'application/zip' },
                            { name: 'Encrypted', value: 'true' },
                            { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                        ]
                    },
                    chunkByteCount: 5 * 1024 * 1024,
                    maxChunkConcurrency: 3,
                    chunkingMode: 'auto'
                });

                if (!isValidManifestId(zipResult?.id)) {
                    throw new Error(t('invalid-upload-id'));
                }

                zipTxId = zipResult.id;
                uploadedZipRef.current = { txId: zipTxId, iv, merkleRoot };
                // Kritiska secība: lokālais kontrolpunkts pirms Redis pieprasījuma.
                if (!updateRecoveryJournal({
                    jobId,
                    repositoryId: String(repositoryId),
                    walletAddress: userAddress,
                    stage: 'zip-uploaded-locally',
                    cryptoVersion: 1,
                    zipTxId,
                    zipIv: iv ? Array.from(iv) : null,
                    zipMerkleRoot: merkleRoot || null
                })) {
                    throw new Error(t('recovery-journal-save-failed'));
                }

                await apiJsonWithRetry('/api/save-zip-tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId,
                        zipTxId,
                        iv: iv ? Array.from(iv) : null,
                        merkleRoot: merkleRoot || null,
                        cryptoVersion: 1
                    })
                });
            }
            
            setStatus(t('manifest-ready'));
            setLastStatusData({ type: 'simple', key: 'manifest-ready' });

            let manifest = uploadedManifestRef.current.manifest;
            let manifestTxId = uploadedManifestRef.current.txId || recoveredJobData?.manifestTxId;

            if (manifestTxId && recoveredJobData?.manifest) {
                manifest = recoveredJobData.manifest;
                updateRecoveryJournal({
                    jobId,
                    repositoryId: String(repositoryId),
                    walletAddress: userAddress,
                    stage: 'manifest-uploaded-locally',
                    zipTxId,
                    zipIv: iv ? Array.from(iv) : null,
                    zipMerkleRoot: merkleRoot || null,
                    manifestTxId
                });
                await apiJsonWithRetry('/api/save-manifest-tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId, manifestTxId, manifest })
                });
                updateRecoveryJournal({ stage: 'manifest-uploaded', manifestTxId });
            } else if (!manifestTxId) {
                await apiJsonWithRetry('/api/start-manifest-upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId })
                });

                const history = [...currentPreviousHistory];

                if (currentPreviousManifestId) {
                    const alreadyExists = history.some(
                        entry => entry && entry.manifestId === currentPreviousManifestId
                    );

                    if (!alreadyExists) {
                        // Par reload state var būt null, tāpēc izmantojam arī atjaunotos
                        // job datus un NFT backupCount. Ja tie nav pieejami, numuru
                        // atvasinām no history, nevis klusējot pieņemam, ka tas ir 1.
                        const backupCountCandidate =
                            currentPreviousBackupNumber ??
                            recoveredJobData?.backupCount ??
                            nftInfo.backupCount;
                        let prevBackupNumber = Number(backupCountCandidate);

                        if (!Number.isSafeInteger(prevBackupNumber) || prevBackupNumber <= 0) {
                            prevBackupNumber = history.reduce((maxNumber, entry) => {
                                const number = Number(entry?.backupNumber);
                                return Number.isSafeInteger(number) && number > maxNumber
                                    ? number
                                    : maxNumber;
                            }, 0) + 1;
                        }

                        // Dublēšanos pārbaudām pēc manifestId, nevis backupNumber:
                        // jauns ID ar tādu pašu numuru nedrīkst pazust no history.
                        history.push({
                            backupNumber: prevBackupNumber,
                            manifestId: currentPreviousManifestId,
                            url: `/raw/${encodeURIComponent(currentPreviousManifestId)}`
                        });
                    }
                }

                history.sort((a, b) => Number(b?.backupNumber || 0) - Number(a?.backupNumber || 0));

                const encryptionIVs = Object.assign(
                    Object.create(null),
                    currentPreviousEncryptionIVs
                );

                if (iv && iv.length === 12) {
                    encryptionIVs[zipTxId] = Array.from(iv);
                }

                const masterKeyVerifier = await createMasterKeyVerifier(keyHex);

                manifest = {
                    manifest: 'arweave/paths',
                    version: '0.2.0',
                    metadata: {
                        repo: repositoryFullName || `${githubUser}/${repoName}`, // backward-compatible display field
                        repositoryId: String(repositoryId),
                        repositoryName: repositoryFullName || `${githubUser}/${repoName}`, 
                        githubUserId: githubUserId ? String(githubUserId) : null
                    },
                    encryption: { algorithm: 'AES-GCM', kdf: 'HKDF-SHA-256', version: 1, ivs: encryptionIVs, keyVerifier: masterKeyVerifier },
                    archive: {
                        id: zipTxId,
                        url: `/raw/${encodeURIComponent(zipTxId)}`,
                        contains: changedFiles.map(file => ({
                            path: file.path,
                            hash: file.hash
                        }))
                    },
                    paths: Object.create(null),
                    history
                };

                for (const file of changedFiles) {
                    manifest.paths[file.path] = { id: zipTxId, hash: file.hash };
                }

                for (const [filePath, info] of Object.entries(unchangedFiles)) {
                    manifest.paths[filePath] = { id: info.id, hash: info.hash };
                }

                const manifestPaths = Object.keys(manifest.paths);

                if (manifestPaths.length > 0) {
                    manifest.index = {
                        path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0]
                    };
                }

                const manifestBlob = new Blob(
                    [JSON.stringify(manifest)],
                    { type: 'application/x.arweave-manifest+json' }
                );

                const manifestResult = await client.uploadFile({
                    fileStreamFactory: () => manifestBlob.stream(),
                    fileSizeFactory: () => manifestBlob.size,
                    dataItemOpts: {
                        tags: [
                            { name: 'App-Name', value: 'PermRepo' },
                            { name: 'Type', value: 'path-manifest' },
                            { name: 'Repo', value: `${githubUser}/${repoName}` },
                            { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                            { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                        ]
                    },
                    chunkByteCount: 5 * 1024 * 1024,
                    maxChunkConcurrency: 3,
                    chunkingMode: 'auto'
                });

                if (!isValidManifestId(manifestResult?.id)) {
                    throw new Error(t('invalid-upload-id'));
                }

                manifestTxId = manifestResult.id;
                uploadedManifestRef.current = { txId: manifestTxId, manifest };
                if (!updateRecoveryJournal({
                    jobId,
                    repositoryId: String(repositoryId),
                    walletAddress: userAddress,
                    stage: 'manifest-uploaded-locally',
                    zipTxId,
                    zipIv: iv ? Array.from(iv) : null,
                    zipMerkleRoot: merkleRoot || null,
                    manifestTxId
                })) {
                    throw new Error(t('recovery-journal-save-failed'));
                }

                await apiJsonWithRetry('/api/save-manifest-tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId, manifestTxId, manifest })
                });
                updateRecoveryJournal({ stage: 'manifest-uploaded', manifestTxId });
            }

            setStatus(t('signing'));
            setLastStatusData({ type: 'simple', key: 'signing' });

            const provider = new ethers.BrowserProvider(window.ethereum);
            const accounts = await provider.send('eth_accounts', []);

            if (!accounts[0] || accounts[0].toLowerCase() !== userAddress.toLowerCase()) {
                throw new Error(t('wallet-changed'));
            }

            const currentSigner = await provider.getSigner();
            const readContract = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
            const tokenId = BigInt(nftInfo.tokenId);
            const owner = await readContract.ownerOf(tokenId);

            if (owner.toLowerCase() !== userAddress.toLowerCase()) {
                throw new Error(t('nft-not-owned'));
            }

            const deadline = Math.floor(Date.now() / 1000) + 600;
            const currentNonce = await readContract.getNonce(tokenId);
            const onChainBackupCount = await readContract.getBackupCount(tokenId);
            const manifestURI = `ar://${manifestTxId}`;
            const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));

            const domain = {
                name: 'PermRepo',
                version: '1',
                chainId: Number(config.chainId),
                verifyingContract: config.nftAddress
            };

            const types = {
                AddBackup: [
                    { name: 'tokenId', type: 'uint256' },
                    { name: 'backupNumber', type: 'uint256' },
                    { name: 'manifestHash', type: 'bytes32' },
                    { name: 'merkleRoot', type: 'bytes32' },
                    { name: 'deadline', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' }
                ]
            };

            const value = {
                tokenId,
                backupNumber: onChainBackupCount + 1n,
                manifestHash,
                merkleRoot,
                deadline: BigInt(deadline),
                nonce: currentNonce
            };

            const signature = await currentSigner.signTypedData(domain, types, value);

            await apiJson('/api/start-blockchain-finalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId,
                    backupNumber: (onChainBackupCount + 1n).toString(),
                    manifestHash,
                    merkleRoot,
                    manifestURI,
                    deadline: deadline.toString()
                })
            });

            const nftWrite = new ethers.Contract(config.nftAddress, NFT_ABI, currentSigner);
            updateRecoveryJournal({
                jobId,
                repositoryId: String(repositoryId),
                walletAddress: userAddress,
                stage: 'blockchain-submitting',
                zipTxId,
                manifestTxId,
                tokenId: String(nftInfo.tokenId),
                manifestURI,
                merkleRoot
            });

            const tx = await nftWrite.addBackup(
                tokenId,
                manifestHash,
                merkleRoot,
                manifestURI,
                BigInt(deadline),
                signature
            );

            submittedBackupTxHashRef.current = tx.hash;
            try {
                localStorage.setItem(
                    `permrepo-backup-tx-${repoStorageKey}`,
                    tx.hash
                );
            } catch {}
            updateRecoveryJournal({
                jobId,
                repositoryId: String(repositoryId),
                walletAddress: userAddress,
                stage: 'blockchain-finalizing',
                zipTxId,
                manifestTxId,
                backupTxHash: tx.hash,
                tokenId: String(nftInfo.tokenId),
                manifestURI,
                merkleRoot
            });

            await apiJsonWithRetry('/api/save-backup-tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId,
                    txHash: tx.hash
                })
            });

            await tx.wait();

            let redisCompleted = false;
            try {
                await apiJson('/api/complete-backup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId,
                        txHash: tx.hash
                    })
                });
                redisCompleted = true;
            } catch (completeError) {
                console.error('Neizdevās paziņot serverim par pabeigšanu:', completeError);
            }

            if (!redisCompleted) {
                setError(t('redis-completion-failed'));
                setRecoveryRequired(true);
                setRecoveredJobData(prev => ({
                    ...prev,
                    jobId,
                    backupTxHash: tx.hash,
                    manifestTxId: manifestTxId,
                    tokenId: nftInfo.tokenId,
                    backupCount: (onChainBackupCount + 1n).toString(),
                    manifestURI: manifestURI,
                    merkleRoot: merkleRoot
                }));
                setIsWorking(false);
                return;
            }

            try {
                localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                clearRecoveryJournal();
            } catch {}

            setNftInfo({
                tokenId: nftInfo.tokenId,
                backupCount: (onChainBackupCount + 1n).toString(),
                lastManifest: manifestURI,
                lastMerkleRoot: merkleRoot
            });

            setLastManifestTxId(manifestTxId);
            setBackupCompleted(true);
            setStatus(t('backup-complete'));
            setLastStatusData({ type: 'success', key: 'backup-complete' });
        } catch (e) {
            if (submittedBackupTxHashRef.current) {
                setRecoveryRequired(true);
                setStatus(t('recovery-required'));
                setRecoveredJobData(prev => ({
                    ...prev,
                    jobId,
                    backupTxHash: submittedBackupTxHashRef.current,
                    manifestTxId: manifestTxId,
                    tokenId: nftInfo.tokenId
                }));
            } else {
                try {
                    const failResponse = await apiJson('/api/fail-backup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jobId,
                            error: getSafeErrorMessage(e, t)
                        })
                    });

                    if (failResponse.recoveryRequired) {
                        setRecoveryRequired(true);
                        setStatus(t('recovery-required'));
                        setRecoveredJobData(prev => ({
                            ...prev,
                            jobId,
                            backupTxHash: failResponse.backupTxHash
                        }));
                    }
                } catch (failError) {
                    if (failError.recoveryRequired) {
                        setRecoveryRequired(true);
                        setStatus(t('recovery-required'));
                        setRecoveredJobData(prev => ({
                            ...prev,
                            jobId,
                            backupTxHash: failError.backupTxHash
                        }));
                    }
                }
            }

            if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
                setError(t('transaction-cancelled'));
            } else {
                setError(getSafeErrorMessage(e, t));
            }
        } finally {
            setIsWorking(false);
        }
    }, [
        apiJson, apiJsonWithRetry, updateRecoveryJournal, t, githubUser, repoName, config,
        currentPreviousHistory, currentPreviousManifestId,
        currentPreviousBackupNumber, currentPreviousEncryptionIVs,
        nftInfo.tokenId, calculateMerkleRoot, encryptData,
        userAddress, recoveredJobData, repositoryId
    ]);

    const recoverBackup = useCallback(async () => {
        const txHash = recoveredJobData?.backupTxHash ||
            localStorage.getItem(`permrepo-backup-tx-${repoStorageKey}`);

        if (!txHash) {
            setError(t('no-backup-tx'));
            return;
        }

        try {
            setIsWorking(true);
            setError('');

            await apiJson('/api/complete-backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: recoveredJobData?.jobId || preparedJobId,
                    txHash
                })
            });

            try {
                localStorage.removeItem(`permrepo-job-${repoStorageKey}`);
                localStorage.removeItem(`permrepo-backup-tx-${repoStorageKey}`);
                clearRecoveryJournal();
            } catch {}

            if (recoveredJobData) {
                setNftInfo({
                    tokenId: recoveredJobData.tokenId || nftInfo.tokenId || null,
                    backupCount: recoveredJobData.backupCount || nftInfo.backupCount || null,
                    lastManifest: recoveredJobData.manifestURI || nftInfo.lastManifest || null,
                    lastMerkleRoot: recoveredJobData.merkleRoot || nftInfo.lastMerkleRoot || null
                });
            }

            setLastManifestTxId(recoveredJobData?.manifestTxId || lastManifestTxId);
            setBackupCompleted(true);
            setStatus(t('backup-complete'));
            setLastStatusData({ type: 'success', key: 'backup-complete' });
            setIsWorking(false);
        } catch (e) {
            setError(getSafeErrorMessage(e, t));
            setIsWorking(false);
        }
    }, [recoveredJobData, preparedJobId, apiJson, t, repoName, nftInfo, lastManifestTxId, clearRecoveryJournal]);

    if (!config) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '20px' }}>
                    <div className="spinner"></div>
                </div>
            </div>
        );
    }

    let finalManifestUrl = null;

    if (lastManifestTxId) {
        try {
            finalManifestUrl = getValidatedManifestUrl(
                config.arweaveGateway,
                lastManifestTxId,
                t
            );
        } catch (manifestError) {
            console.warn(
                'Neizdevās izveidot manifesta URL:',
                manifestError
            );
        }
    }

    const zipAlreadyUploaded = Boolean(
        !backupCompleted && (recoveredJobData?.zipTxId || uploadedZipRef.current.txId)
    );
    const manifestAlreadyUploaded = Boolean(
        recoveredJobData?.manifestTxId || uploadedManifestRef.current.txId
    );

    return (
        <div className="container">
            <div className="language-selector">
                <button className={`lang-btn ${currentLanguage === 'lv' ? 'active' : ''}`} onClick={() => switchLanguage('lv')}>LV</button>
                <button className={`lang-btn ${currentLanguage === 'en' ? 'active' : ''}`} onClick={() => switchLanguage('en')}>EN</button>
                <button className={`lang-btn ${currentLanguage === 'eo' ? 'active' : ''}`} onClick={() => switchLanguage('eo')}>EO</button>
            </div>
            
            <img src="/icons/logo-nosaukums.svg" alt="PermRepo" className="logo-title" />
            <p className="subtitle">{t('repo-label')}: {repoName || '-'}</p>
            
            <div className="info-row text-left">
                <span className="info-label">{t('nft-token')}</span>
                <span className="info-value">{nftInfo.tokenId || '-'}</span>
            </div>
            
            <div className="info-row text-left">
                <span className="info-label">{t('backup-count')}</span>
                <span className="info-value">{nftInfo.backupCount || '-'}</span>
            </div>
            
            <div className="info-row text-left">
                <span className="info-label">{t('last-manifest')}</span>
                <span className="info-value">{nftInfo.lastManifest || '-'}</span>
            </div>
            
            <div className="info-row text-left">
                <span className="info-label">{t('last-merkle')}</span>
                <span className="info-value">{nftInfo.lastMerkleRoot || '-'}</span>
            </div>
            
            {zipAlreadyUploaded ? (
                <div
                    role="status"
                    style={{
                        padding: '12px',
                        marginTop: '12px',
                        borderRadius: '8px',
                        background: 'rgba(240, 173, 78, 0.12)',
                        border: '1px solid rgba(240, 173, 78, 0.35)'
                    }}
                >
                    {manifestAlreadyUploaded
                        ? t('recovery-zip-manifest-uploaded')
                        : t('recovery-zip-only-manifest')}
                </div>
            ) : fileInfo.loading ? (
                <div style={{ textAlign: 'center', padding: '20px' }}>
                    <div className="spinner"></div>
                </div>
            ) : (
                <>
                    <div style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <Icon name="fails" />
                        {' '}{t('files-count')}: <strong>{fileInfo.count}</strong>
                    </div>
                    <div style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <Icon name="fails" />
                        {' '}{t('files-size')}: <strong>{fileInfo.sizeText || '-'}</strong>
                    </div>
                </>
            )}
            
            {recoveredJobData?.freshStartRequired ? (
                <button
                    onClick={startFreshBackup}
                    disabled={isWorking}
                    className="sign-button"
                    style={{ marginTop: '20px' }}
                >
                    {t('start-new-backup')}
                </button>
            ) : recoveryRequired && !recoveredJobData?.serverJobMissing && (recoveredJobData?.backupTxHash || localStorage.getItem(`permrepo-backup-tx-${repoStorageKey}`)) ? (
                <button 
                    onClick={recoverBackup}
                    disabled={isWorking}
                    className="sign-button"
                    style={{ marginTop: '20px', background: 'linear-gradient(135deg, #f0ad4e 0%, #d98b3a 100%)' }}
                >
                    {isWorking ? (
                        <div style={{ textAlign: 'center' }}>
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        t('recover-backup')
                    )}
                </button>
            ) : !backupCompleted ? (
                <button 
                    onClick={continueBackup}
                    disabled={
                        isWorking ||
                        fileInfo.loading ||
                        (fileInfo.count === 0 && !recoveredJobData) ||
                        (recoveryRequired && (recoveredJobData?.serverJobMissing || !(recoveredJobData?.backupTxHash || localStorage.getItem(`permrepo-backup-tx-${repoStorageKey}`))))
                    }
                    className="sign-button"
                    style={{ marginTop: '20px' }}
                >
                    {isWorking ? (
                        <div style={{ textAlign: 'center' }}>
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        t('continue-backup')
                    )}
                </button>
            ) : (
                <button 
                    onClick={() => navigate('/')}
                    className="sign-button"
                    style={{ marginTop: '20px' }}
                >
                    {t('back-home')}
                </button>
            )}
            
            {status && (
                <div className="status-card" style={{ display: 'block' }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                        <Icon name={lastStatusData?.type === 'success' ? 'izdevas-veiksmigi' : 'upload'} />
                        {' '}{status}
                    </div>

                    {backupCompleted && lastManifestTxId && finalManifestUrl && (
                        <div style={{ marginTop: '12px' }}>
                            <Icon name="manifests" />
                            {' '}{t('manifest-link')}:{' '}
                            <a href={finalManifestUrl} target="_blank" rel="noopener noreferrer">
                                ar://{lastManifestTxId}
                            </a>
                        </div>
                    )}
                </div>
            )}
            
            {error && (
                <div className="error">
                    <Icon name="kluda" />
                    {' '}{error}
                </div>
            )}
        </div>
    );
}

export default BackupPage;
