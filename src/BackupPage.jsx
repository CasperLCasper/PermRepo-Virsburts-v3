import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import JSZip from 'jszip';
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
    const [config, setConfig] = useState({});
    const [currentLanguage, setCurrentLanguage] = useState(localStorage.getItem('permrepo-language') || 'lv');
    const [repoName, setRepoName] = useState(null);
    const [tokenId, setTokenId] = useState(null);
    const [githubUser, setGithubUser] = useState(null);
    const [userAddress, setUserAddress] = useState(null);
    const [signer, setSigner] = useState(null);
    const [turboClient, setTurboClient] = useState(null);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [backupCompleted, setBackupCompleted] = useState(false);
    const [lastManifestTxId, setLastManifestTxId] = useState(null);
    const [currentFiles, setCurrentFiles] = useState([]);
    const [nftInfo, setNftInfo] = useState({ tokenId: null, backupCount: null, lastManifest: null, lastMerkleRoot: null });

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

    useEffect(() => {
        const initPage = async () => {
            try {
                const configData = await apiJson('/api/config');
                setConfig(configData);
            } catch (e) {
                setError(e.message);
                return;
            }
            
            const params = new URLSearchParams(window.location.search);
            const repo = params.get('repo');
            if (!repo) {
                setError('Nav repo nosaukuma URL parametrā!');
                return;
            }
            setRepoName(repo);
            
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
            
            if (!window.ethereum) {
                setError('Lūdzu instalē maku!');
                return;
            }
            
            try {
                await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: configData.chainId }] });
                const provider = new ethers.BrowserProvider(window.ethereum);
                const signerInstance = await provider.getSigner();
                const address = await signerInstance.getAddress();
                setSigner(signerInstance);
                setUserAddress(address);
                
                // Turbo klients ar ENV mainīgajiem
                const client = TurboFactory.authenticated({
                    signer: new InjectedEthereumSigner({ getSigner: () => signerInstance }),
                    token: 'base-eth',
                    gatewayUrl: configData.rpcUrl || 'https://sepolia.base.org',
                    uploadServiceConfig: { url: configData.turboUploadUrl || 'https://upload.services.ar-io.dev' },
                    paymentServiceConfig: { url: configData.turboPaymentUrl || 'https://payment.services.ar-io.dev' }
                });
                setTurboClient(client);
                
                // NFT info
                const nftContract = new ethers.Contract(configData.nftAddress, NFT_ABI, provider);
                const fullRepoName = `${userData.user}/${repo}`;
                const repoHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName]));
                const tokenId = await nftContract.repositoryTokens(repoHash);
                if (tokenId === 0n) {
                    setError('Nav NFT šim repo!');
                    return;
                }
                const nftOwner = await nftContract.ownerOf(tokenId);
                if (nftOwner.toLowerCase() !== address.toLowerCase()) {
                    setError('NFT nepieder šim makam!');
                    return;
                }
                
                const backupCount = await nftContract.getBackupCount(tokenId);
                const lastManifest = await nftContract.getManifestURI(tokenId);
                const lastMerkleRoot = await nftContract.getLastMerkleRoot(tokenId);
                
                setTokenId(tokenId);
                setNftInfo({
                    tokenId: tokenId.toString(),
                    backupCount: backupCount.toString(),
                    lastManifest: lastManifest || 'Nav',
                    lastMerkleRoot: lastMerkleRoot || 'Nav'
                });
                
            } catch (e) {
                setError(e.message);
            }
        };
        
        initPage();
    }, []);

    const prepareBackup = useCallback(async () => {
        setIsWorking(true);
        setStatus(`⏳ ${t('preparing')}`);
        setError('');
        
        try {
            const result = await apiJson('/api/prepare-backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoName, walletAddress: userAddress })
            });
            
            setCurrentFiles(result.files || []);
            
            if (!result.files || result.files.length === 0) {
                setStatus(`✅ ${t('no-changes')}`);
                setIsWorking(false);
                return;
            }
            
            const sizeText = formatFileSize(result.totalBytes || 0);
            setStatus(`📄 ${t('files-count')}: ${result.files.length}\n📄 ${t('files-size')}: ${sizeText}`);
            
            await uploadZip(result.jobId, result.files);
            
        } catch (e) {
            setError(e.message);
            setIsWorking(false);
        }
    }, [apiJson, repoName, userAddress, t, formatFileSize]);

    const uploadZip = useCallback(async (jobId, files) => {
        setStatus(`⏳ ${t('creating-zip')}`);
        
        try {
            const backupCount = Number(nftInfo.backupCount || 0);
            let masterKey;
            if (backupCount === 0) {
                const keyBytes = crypto.getRandomValues(new Uint8Array(32));
                masterKey = ethers.hexlify(keyBytes);
                await showMasterKey(masterKey);
            } else {
                masterKey = await promptMasterKey();
            }
            
            if (!isValidMasterKey(masterKey)) {
                setError(t('encrypted-required'));
                setIsWorking(false);
                return;
            }
            
            const zip = new JSZip();
            for (const file of files) {
                const binaryString = atob(file.content);
                const fileBuffer = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) fileBuffer[i] = binaryString.codePointAt(i);
                zip.file(file.path, fileBuffer);
            }
            const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
            
            setStatus(`⏳ ${t('encrypting')}`);
            const encrypted = await encryptData(zipBuffer, masterKey);
            const encryptedZipData = encrypted.encrypted;
            const iv = encrypted.iv;
            const merkleRoot = calculateMerkleRoot(files);
            const fileMetadata = files.map(file => ({ path: file.path, hash: file.hash }));
            
            setStatus(`⏳ ${t('uploading')}`);
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
                }
            });
            
            const zipTxId = zipResult.id;
            
            await apiJson('/api/save-zip-tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, zipTxId })
            });
            
            setStatus(`⏳ ${t('manifest-ready')}`);
            const manifest = {
                manifest: 'arweave/paths',
                version: '0.2.0',
                index: { path: files[0]?.path || 'README.md' },
                paths: {}
            };
            
            for (const file of files) {
                manifest.paths[file.path] = { id: zipTxId };
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
                }
            });
            
            const manifestTxId = manifestResult.id;
            
            await apiJson('/api/save-manifest-tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, manifestTxId, manifest })
            });
            
            setStatus(`⏳ ${t('signing')}`);
            const provider = new ethers.BrowserProvider(window.ethereum);
            const readContract = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            const currentNonce = await readContract.getNonce(tokenId);
            const onChainBackupCount = await readContract.getBackupCount(tokenId);
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
                tokenId: BigInt(tokenId),
                backupNumber: onChainBackupCount + 1n,
                manifestHash,
                merkleRoot,
                deadline: BigInt(deadline),
                nonce: currentNonce
            };
            
            const signature = await signer.signTypedData(domain, types, value);
            
            const nftWrite = new ethers.Contract(config.nftAddress, NFT_ABI, signer);
            const tx = await nftWrite.addBackup(tokenId, manifestHash, merkleRoot, manifestURI, deadline, signature);
            await tx.wait();
            
            setLastManifestTxId(manifestTxId);
            setBackupCompleted(true);
            setStatus(`✅ ${t('backup-complete')}`);
            
        } catch (e) {
            if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
                setError(t('transaction-cancelled'));
            } else {
                setError(e.message);
            }
        } finally {
            setIsWorking(false);
        }
    }, [apiJson, t, turboClient, signer, tokenId, githubUser, repoName, config, nftInfo.backupCount, showMasterKey, promptMasterKey, isValidMasterKey, encryptData, calculateMerkleRoot]);

    return (
        <div className="container">
            <div className="language-selector">
                <button className={`lang-btn ${currentLanguage === 'lv' ? 'active' : ''}`} onClick={() => setCurrentLanguage('lv')}>LV</button>
                <button className={`lang-btn ${currentLanguage === 'en' ? 'active' : ''}`} onClick={() => setCurrentLanguage('en')}>EN</button>
                <button className={`lang-btn ${currentLanguage === 'eo' ? 'active' : ''}`} onClick={() => setCurrentLanguage('eo')}>EO</button>
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
            
            {!backupCompleted ? (
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
                    onClick={() => window.location.href = '/'}
                    className="sign-button"
                    style={{ marginTop: '20px' }}
                >
                    {t('back-home')}
                </button>
            )}
            
            {status && (
                <div className="status-card" style={{ display: 'block' }}>
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
