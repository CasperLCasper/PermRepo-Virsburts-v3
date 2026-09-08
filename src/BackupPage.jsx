import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { translations } from './translations';
import { TurboFactory } from '@ardrive/turbo-sdk/web';
import { InjectedEthereumSigner } from '@dha-team/arbundles';

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

function icon(name) {
    return `/icons/${name}.svg`;
}

function BackupPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [config, setConfig] = useState(null);
    const [currentLanguage, setCurrentLanguage] = useState(localStorage.getItem('permrepo-language') || 'lv');
    const [repoName, setRepoName] = useState(searchParams.get('repo'));
    const [tokenId, setTokenId] = useState(null);
    const [githubUser, setGithubUser] = useState(null);
    const [userAddress, setUserAddress] = useState(null);
    const [signer, setSigner] = useState(null);
    const [turboClient, setTurboClient] = useState(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('progress');
    const [error, setError] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [backupCompleted, setBackupCompleted] = useState(false);
    const [lastManifestTxId, setLastManifestTxId] = useState(null);
    const [currentFiles, setCurrentFiles] = useState([]);
    const [currentJobId, setCurrentJobId] = useState(null);
    const [nftInfo, setNftInfo] = useState({ tokenId: null, backupCount: null, lastManifest: null, lastMerkleRoot: null });
    
    const [currentUnchangedFiles, setCurrentUnchangedFiles] = useState({});
    const [currentPreviousHistory, setCurrentPreviousHistory] = useState([]);
    const [currentPreviousManifestId, setCurrentPreviousManifestId] = useState(null);
    const [currentPreviousBackupNumber, setCurrentPreviousBackupNumber] = useState(null);
    const [currentPreviousEncryptionIVs, setCurrentPreviousEncryptionIVs] = useState({});
    const [currentMerkleRoot, setCurrentMerkleRoot] = useState(null);
    const [currentIV, setCurrentIV] = useState(null);
    
    // ✅ Statusa dati valodas maiņai:
    const [lastStatusData, setLastStatusData] = useState(null);
    const [changedFilesCount, setChangedFilesCount] = useState(0);

    const t = useCallback((key) => {
        return translations[currentLanguage]?.[key] || translations.lv[key] || key;
    }, [currentLanguage]);

    const apiJson = useCallback(async (url, options = {}) => {
        const response = await fetch(url, { credentials: 'same-origin', ...options });
        let result;
        try { result = await response.json(); } catch { throw new Error(`Servera kļūda: HTTP ${response.status}`); }
        if (!response.ok && !result.success) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    }, []);

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

    const encryptData = useCallback(async (data, keyHex) => {
        const keyBytes = ethers.getBytes(keyHex);
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
        return { encrypted: new Uint8Array(encrypted), iv };
    }, []);

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
            
            closeButton.onclick = () => { modal.remove(); resolve(); };
        });
    }, [t, repoName]);

    // ✅ Statusa ziņojuma iestatīšana ar datiem valodas maiņai:
    const setStatusWithData = useCallback((message, type, data = null) => {
        setStatus(message);
        setStatusType(type);
        setLastStatusData(data);
    }, []);

    // ✅ Statusa renderēšana valodas maiņai:
    const renderStatusFromData = useCallback(() => {
        if (!lastStatusData) return;
        
        const data = lastStatusData;
        
        switch(data.type) {
            case 'files':
                setStatus(`${t('files-count')}: ${data.fileCount}\n${t('files-size')}: ${data.fileSizeText}`);
                break;
            case 'uploading':
                setStatus(`⏳ ${t('uploading')}`);
                break;
            case 'success':
                setStatus(`✅ ${t(data.key)}`);
                setStatusType('success');
                break;
            case 'simple':
                setStatus(t(data.key));
                break;
            default:
                setStatus(t(data.key));
        }
    }, [lastStatusData, t]);

    // ✅ Valodas maiņa ar statusa atjaunināšanu:
    const switchLanguage = useCallback((lang) => {
        setCurrentLanguage(lang);
        localStorage.setItem('permrepo-language', lang);
        renderStatusFromData();
    }, [renderStatusFromData]);

    const connectWallet = useCallback(async () => {
        try {
            if (!window.ethereum) {
                setError('Lūdzu instalē maku!');
                return;
            }
            
            setStatusWithData('⏳ Savieno maku...', 'progress', { type: 'simple', key: 'waiting' });
            setError('');
            
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            const address = accounts[0];
            
            await window.ethereum.request({ 
                method: 'wallet_switchEthereumChain', 
                params: [{ chainId: config.chainId }] 
            });
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signerInstance = await provider.getSigner();
            
            setSigner(signerInstance);
            setUserAddress(address);
            
            const client = TurboFactory.authenticated({
                signer: new InjectedEthereumSigner({ getSigner: () => signerInstance }),
                token: 'base-eth',
                gatewayUrl: config.rpcUrl,
                uploadServiceConfig: { url: config.turboUploadUrl },
                paymentServiceConfig: { url: config.turboPaymentUrl }
            });
            setTurboClient(client);
            
            const nftContract = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
            const fullRepoName = `${githubUser}/${repoName}`;
            const repoHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName]));
            const tokenIdResult = await nftContract.repositoryTokens(repoHash);
            if (tokenIdResult === 0n) {
                setError('Nav NFT šim repo!');
                return;
            }
            const nftOwner = await nftContract.ownerOf(tokenIdResult);
            if (nftOwner.toLowerCase() !== address.toLowerCase()) {
                setError('NFT nepieder šim makam!');
                return;
            }
            
            const backupCount = await nftContract.getBackupCount(tokenIdResult);
            const lastManifest = await nftContract.getManifestURI(tokenIdResult);
            const lastMerkleRoot = await nftContract.getLastMerkleRoot(tokenIdResult);
            
            setTokenId(tokenIdResult);
            setNftInfo({
                tokenId: tokenIdResult.toString(),
                backupCount: backupCount.toString(),
                lastManifest: lastManifest || 'Nav',
                lastMerkleRoot: lastMerkleRoot || 'Nav'
            });
            
            if (backupCount > 0n && lastManifest && lastManifest.startsWith('ar://')) {
                const prevManifestId = lastManifest.slice(5);
                setCurrentPreviousManifestId(prevManifestId);
                try {
                    const manifestResponse = await fetch(`${config.arweaveGateway}/raw/${encodeURIComponent(prevManifestId)}`);
                    if (manifestResponse.ok) {
                        const prevManifest = await manifestResponse.json();
                        if (prevManifest && typeof prevManifest.paths === 'object') {
                            setCurrentUnchangedFiles(prevManifest.paths);
                        }
                        if (Array.isArray(prevManifest?.history)) {
                            setCurrentPreviousHistory(prevManifest.history);
                        }
                        if (prevManifest?.metadata?.backupNumber !== undefined) {
                            setCurrentPreviousBackupNumber(prevManifest.metadata.backupNumber);
                        }
                        if (prevManifest?.encryption?.ivs && typeof prevManifest.encryption.ivs === 'object') {
                            setCurrentPreviousEncryptionIVs(prevManifest.encryption.ivs);
                        }
                    }
                } catch (manifestError) {
                    console.warn('⚠️ Neizdevās ielādēt iepriekšējo manifestu:', manifestError.message);
                }
            }
            
            // ✅ Tikai TAGAD iestati walletConnected un statusu:
            setWalletConnected(true);
            setStatusWithData(`✅ Maks savienots: ${address}`, 'success', { type: 'success', key: 'wallet-connected' });
            
        } catch (e) {
            setError(e.message);
        }
    }, [config, githubUser, repoName, setStatusWithData]);

    useEffect(() => {
        const initPage = async () => {
            try {
                const configData = await apiJson('/api/config');
                setConfig(configData);
                
                if (!repoName) {
                    setError('Nav repo nosaukuma URL parametrā!');
                    return;
                }
                
                try {
                    const userData = await apiJson('/api/github/user');
                    if (!userData.success) {
                        window.location.href = '/api/github/login';
                        return;
                    }
                    setGithubUser(userData.user);
                } catch (e) {
                    setError(e.message);
                    return;
                }
                
            } catch (e) {
                setError(e.message);
            }
        };
        
        initPage();
    }, []);

    const prepareBackup = useCallback(async () => {
        // ✅ Ja maks nav savienots, parāda ziņojumu NEVIS prasa vēlreiz:
        if (!walletConnected || !turboClient) {
            setError('Vispirms savieno maku!');
            return;
        }
        
        setIsWorking(true);
        setStatusWithData(`⏳ ${t('preparing')}`, 'progress', { type: 'simple', key: 'preparing' });
        setError('');
        
        try {
            const backupCount = Number(nftInfo.backupCount || 0);
            let keyHex;
            
            if (backupCount === 0) {
                const keyBytes = crypto.getRandomValues(new Uint8Array(32));
                keyHex = ethers.hexlify(keyBytes);
                await showMasterKey(keyHex);
            } else {
                keyHex = await promptMasterKey();
                if (!isValidMasterKey(keyHex)) {
                    setError(t('encrypted-required'));
                    setIsWorking(false);
                    return;
                }
            }
            
            const result = await apiJson('/api/prepare-backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoName, walletAddress: userAddress })
            });
            
            const files = result.files || [];
            setCurrentFiles(files);
            setCurrentJobId(result.jobId);
            
            if (files.length === 0) {
                setStatusWithData(`✅ ${t('no-changes')}`, 'success', { type: 'simple', key: 'no-changes' });
                setIsWorking(false);
                return;
            }
            
            const changedFiles = [];
            const unchangedFiles = {};
            
            for (const file of files) {
                const previousFile = currentUnchangedFiles[file.path];
                if (previousFile && previousFile.hash && previousFile.hash === file.hash) {
                    unchangedFiles[file.path] = { id: previousFile.id || previousFile.zipId, hash: file.hash };
                } else {
                    changedFiles.push(file);
                }
            }
            
            if (changedFiles.length === 0) {
                setStatusWithData(`✅ ${t('no-changes')}`, 'success', { type: 'simple', key: 'no-changes' });
                setIsWorking(false);
                return;
            }
            
            // ✅ Saglabā mainīto failu skaitu un parāda:
            setChangedFilesCount(changedFiles.length);
            
            const sizeText = formatFileSize(
                changedFiles.reduce((sum, file) => sum + Number(file.size), 0)
            );
            
            // ✅ PIEVIENO: parāda, cik failu mainīti un cik nemainīti:
            setStatusWithData(
                `${t('files-count')}: ${changedFiles.length}\n` +
                `${t('files-size')}: ${sizeText}`,
                'progress',
                { type: 'files', fileCount: changedFiles.length, fileSizeText: sizeText }
            );
            
            await uploadZip(result.jobId, changedFiles, unchangedFiles, keyHex);
            
        } catch (e) {
            setError(e.message);
            setIsWorking(false);
        }
    }, [apiJson, repoName, userAddress, t, formatFileSize, nftInfo.backupCount, currentUnchangedFiles, showMasterKey, promptMasterKey, isValidMasterKey, walletConnected, turboClient, setStatusWithData]);

    const uploadZip = useCallback(async (jobId, changedFiles, unchangedFiles, keyHex) => {
        setStatusWithData(`⏳ ${t('creating-zip')}`, 'progress', { type: 'simple', key: 'creating-zip' });
        
        try {
            const zip = new JSZip();
            for (const file of changedFiles) {
                const binaryString = atob(file.content);
                const fileBuffer = new Uint8Array(binaryString.length);
                for (let j = 0; j < binaryString.length; j++) {
                    fileBuffer[j] = binaryString.charCodeAt(j) & 0xFF;
                }
                zip.file(file.path, fileBuffer);
            }
            
            const zipBuffer = await zip.generateAsync({ 
                type: 'uint8array',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            });
            
            setStatusWithData(`⏳ ${t('encrypting')}`, 'progress', { type: 'simple', key: 'encrypting' });
            
            const encrypted = await encryptData(zipBuffer, keyHex);
            const encryptedZipData = encrypted.encrypted;
            const iv = encrypted.iv;
            const merkleRoot = calculateMerkleRoot(changedFiles);
            
            setCurrentIV(iv);
            setCurrentMerkleRoot(merkleRoot);
            
            setStatusWithData(`⏳ ${t('uploading')}`, 'progress', { type: 'uploading' });
            
            const zipBlob = new Blob([encryptedZipData], { type: 'application/zip' });
            
            const zipResult = await turboClient.uploadFile({
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
            
            const zipTxId = zipResult.id;
            
            await apiJson('/api/save-zip-tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, zipTxId })
            });
            
            setStatusWithData(`⏳ ${t('manifest-ready')}`, 'progress', { type: 'simple', key: 'manifest-ready' });
            
            const history = [...currentPreviousHistory];
            if (currentPreviousManifestId) {
                const alreadyExists = history.some(entry => entry && entry.manifestId === currentPreviousManifestId);
                if (!alreadyExists) {
                    history.push({
                        backupNumber: currentPreviousBackupNumber || history.length,
                        manifestId: currentPreviousManifestId,
                        url: `${config.arweaveGateway}/raw/${encodeURIComponent(currentPreviousManifestId)}`
                    });
                }
            }
            history.sort((a, b) => Number(b?.backupNumber || 0) - Number(a?.backupNumber || 0));
            
            const encryptionIVs = { ...currentPreviousEncryptionIVs };
            if (iv && iv.length === 12) {
                encryptionIVs[zipTxId] = Array.from(iv);
            }
            
            const manifest = {
                manifest: 'arweave/paths',
                version: '0.2.0',
                encryption: { ivs: encryptionIVs },
                archive: {
                    id: zipTxId,
                    url: `${config.arweaveGateway}/raw/${encodeURIComponent(zipTxId)}`,
                    contains: changedFiles.map(file => ({ path: file.path, hash: file.hash }))
                },
                paths: {},
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
                manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
            }
            
            const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/x.arweave-manifest+json' });
            
            const manifestResult = await turboClient.uploadFile({
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
            
            const manifestTxId = manifestResult.id;
            
            await apiJson('/api/save-manifest-tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, manifestTxId, manifest })
            });
            
            setStatusWithData(`⏳ ${t('signing')}`, 'progress', { type: 'simple', key: 'signing' });
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const readContract = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            const currentNonce = await readContract.getNonce(BigInt(nftInfo.tokenId));
            const onChainBackupCount = await readContract.getBackupCount(BigInt(nftInfo.tokenId));
            const manifestURI = `ar://${manifestTxId}`;
            const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
            
            const domain = { name: 'PermRepo', version: '1', chainId: Number(config.chainId), verifyingContract: config.nftAddress };
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
                tokenId: BigInt(nftInfo.tokenId),
                backupNumber: onChainBackupCount + 1n,
                manifestHash,
                merkleRoot,
                deadline: BigInt(deadline),
                nonce: currentNonce
            };
            
            const signature = await signer.signTypedData(domain, types, value);
            
            const nftWrite = new ethers.Contract(config.nftAddress, NFT_ABI, signer);
            const tx = await nftWrite.addBackup(
                BigInt(nftInfo.tokenId),
                manifestHash,
                merkleRoot,
                manifestURI,
                BigInt(deadline),
                signature
            );
            
            if (tx && tx.wait) {
                await tx.wait();
            }
            
            const newBackupCount = onChainBackupCount + 1n;
            setNftInfo({
                tokenId: nftInfo.tokenId,
                backupCount: newBackupCount.toString(),
                lastManifest: manifestURI,
                lastMerkleRoot: merkleRoot
            });
            
            setLastManifestTxId(manifestTxId);
            setBackupCompleted(true);
            
            // ✅ Saglabā statusa datus valodas maiņai:
            setStatusWithData(`✅ ${t('backup-complete')}`, 'success', { type: 'success', key: 'backup-complete' });
            
        } catch (e) {
            console.error('=== KĻŪDA ===');
            console.error('Ziņojums:', e.message);
            
            if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
                setError(t('transaction-cancelled'));
            } else {
                setError(e.message);
            }
        } finally {
            setIsWorking(false);
        }
    }, [apiJson, t, turboClient, signer, githubUser, repoName, config, currentPreviousHistory, currentPreviousManifestId, currentPreviousBackupNumber, currentPreviousEncryptionIVs, nftInfo.tokenId, calculateMerkleRoot, encryptData, setStatusWithData]);

    if (!config) {
        return (
            <div className="container">
                <p>Ielādē...</p>
            </div>
        );
    }

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
            
            {!walletConnected ? (
                <button 
                    onClick={connectWallet}
                    className="sign-button"
                    style={{ marginTop: '20px' }}
                >
                    🔗 Savienot maku
                </button>
            ) : (
                !backupCompleted ? (
                    <button 
                        onClick={prepareBackup}
                        disabled={isWorking || !turboClient}
                        className="sign-button"
                        style={{ marginTop: '20px' }}
                    >
                        {isWorking ? '⏳' : t('start-backup')}
                    </button>
                ) : (
                    <button 
                        onClick={() => navigate('/')}
                        className="sign-button"
                        style={{ marginTop: '20px' }}
                    >
                        {t('back-home')}
                    </button>
                )
            )}
            
            {status && (
                <div className={`status-card ${statusType}`} style={{ display: 'block' }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{status}</div>
                    {backupCompleted && lastManifestTxId && (
                        <div style={{ marginTop: '12px' }}>
                            <img src={icon('manifests')} className="icon-inline" alt="" style={{ display: 'inline-block', width: '24px', height: '24px', verticalAlign: 'middle', marginRight: '6px' }} />
                            {t('manifest-link')}:{' '}
                            <a href={`${config.arweaveGateway}/raw/${lastManifestTxId}`} target="_blank" rel="noopener noreferrer">
                                ar://{lastManifestTxId}
                            </a>
                        </div>
                    )}
                </div>
            )}
            
            {error && (
                <div className="error">
                    <img src={icon('kluda')} className="icon-inline" alt="" style={{ display: 'inline-block', width: '24px', height: '24px', verticalAlign: 'middle', marginRight: '6px' }} />
                    {error}
                </div>
            )}
        </div>
    );
}

export default BackupPage;
