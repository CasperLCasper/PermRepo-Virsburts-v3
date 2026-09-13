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

// React komponente ikonai
function Icon({ name }) {
    return (
        <img
            src={`/icons/${name}.svg`}
            className="icon-inline"
            alt=""
            aria-hidden="true"
        />
    );
}

// Baltā saraksta gateway
const ALLOWED_GATEWAY_HOSTS = [
    'arweave.net',
    'ar-io.dev',
    'turbo-gateway.com',
    'gateway.arweave.net'
];

// Atļautās shēmas
const ALLOWED_SCHEMES = ['https:'];

// Manifesta ID validācija
function isValidManifestId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(id);
}

// Droša URL validācija
function getValidatedManifestUrl(gatewayUrl, manifestId) {
    if (!isValidManifestId(manifestId)) {
        throw new Error('Nederīgs manifesta ID');
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(gatewayUrl);
    } catch (e) {
        throw new Error('Nederīgs gateway URL');
    }

    if (!ALLOWED_SCHEMES.includes(parsedUrl.protocol)) {
        throw new Error('Nederīga shēma');
    }

    if (!ALLOWED_GATEWAY_HOSTS.includes(parsedUrl.hostname)) {
        throw new Error('Nederīgs gateway hosts');
    }

    return `${parsedUrl.origin}/raw/${encodeURIComponent(manifestId)}`;
}

// Droša kļūdas ziņojuma iegūšana
function getSafeErrorMessage(error) {
    if (!error) {
        return 'Nezināma kļūda';
    }

    if (typeof error === 'string') {
        return error.substring(0, 200);
    }

    if (error.message && typeof error.message === 'string') {
        return error.message.substring(0, 200);
    }

    return 'Nezināma kļūda';
}

function BackupPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { currentLanguage, t, switchLanguage } = useLanguage();

    const [config, setConfig] = useState(null);

    const repoName = searchParams.get('repo');

    const [githubUser, setGithubUser] = useState(null);
    const [userAddress, setUserAddress] = useState(null);

    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [backupCompleted, setBackupCompleted] = useState(false);
    const [lastManifestTxId, setLastManifestTxId] = useState(null);

    const [nftInfo, setNftInfo] = useState({
        tokenId: null,
        backupCount: null,
        lastManifest: null,
        lastMerkleRoot: null
    });

    const [currentUnchangedFiles, setCurrentUnchangedFiles] = useState({});
    const [currentPreviousHistory, setCurrentPreviousHistory] = useState([]);
    const [currentPreviousManifestId, setCurrentPreviousManifestId] = useState(null);
    const [currentPreviousBackupNumber, setCurrentPreviousBackupNumber] = useState(null);
    const [currentPreviousEncryptionIVs, setCurrentPreviousEncryptionIVs] = useState({});
    const [currentMerkleRoot, setCurrentMerkleRoot] = useState(null);
    const [currentIV, setCurrentIV] = useState(null);

    const [lastStatusData, setLastStatusData] = useState(null);

    const [fileInfo, setFileInfo] = useState({
        count: 0,
        sizeText: '',
        loading: true
    });

    const [changedFilesForUpload, setChangedFilesForUpload] = useState([]);
    const [unchangedFilesForUpload, setUnchangedFilesForUpload] = useState({});
    const [preparedJobId, setPreparedJobId] = useState(null);

    // Saglabājam pašreizējā mēģinājuma progresu tikai atmiņā.
    // Tas ļauj kļūmes gadījumā turpināt jau augšupielādēto darbu,
    // neradot jaunu ZIP ar citu IV/MK.
    const masterKeyRef = useRef(null);

    const uploadedZipRef = useRef({
        txId: null,
        iv: null,
        merkleRoot: null
    });

    const uploadedManifestRef = useRef({
        txId: null,
        manifest: null
    });

    const apiJson = useCallback(async (url, options = {}) => {
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...options
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error(`Servera kļūda: HTTP ${response.status}`);
        }

        if (!response.ok && !result.success) {
            throw new Error(
                result.error || `HTTP ${response.status}`
            );
        }

        return result;
    }, []);

    /*
     * NDJSON klienta lasītājs.
     *
     * /api/prepare-backup vairs neatgriež milzīgu JSON objektu,
     * bet straumē:
     *
     * {"type":"meta", ...}
     * {"type":"file", "file": {...}}
     * {"type":"file", "file": {...}}
     * ...
     * {"type":"complete", ...}
     *
     * Tādējādi serverim nav jāuzbūvē un jānotur atmiņā
     * pilns files[] masīvs ar base64 failu saturu.
     */
    const apiNdjson = useCallback(async (url, options = {}) => {
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...options
        });

        if (!response.ok) {
            let result = null;

            try {
                result = await response.json();
            } catch {
                // Servera atbilde nav JSON.
            }

            throw new Error(
                result?.error || `HTTP ${response.status}`
            );
        }

        if (!response.body) {
            throw new Error('Serveris neatgrieza datu streamu.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        let buffer = '';
        let meta = null;
        let complete = null;

        const files = [];

        const processLine = line => {
            const trimmed = line.trim();

            if (!trimmed) {
                return;
            }

            let record;

            try {
                record = JSON.parse(trimmed);
            } catch {
                throw new Error(
                    'Servera NDJSON ieraksts nav derīgs JSON.'
                );
            }

            if (record.type === 'meta') {
                if (!record.success || !record.jobId) {
                    throw new Error(
                        record.error ||
                        'Backup sagatavošana neizdevās.'
                    );
                }

                meta = record;
                return;
            }

            if (record.type === 'file') {
                if (
                    !record.file ||
                    typeof record.file.path !== 'string'
                ) {
                    throw new Error(
                        'Serveris nosūtīja nederīgu faila ierakstu.'
                    );
                }

                files.push(record.file);
                return;
            }

            if (record.type === 'complete') {
                if (!record.success || !record.jobId) {
                    throw new Error(
                        record.error ||
                        'Backup sagatavošana neizdevās.'
                    );
                }

                complete = record;
                return;
            }

            if (record.type === 'error') {
                throw new Error(
                    record.error ||
                    'Backup sagatavošana neizdevās.'
                );
            }

            throw new Error(
                'Serveris nosūtīja nezināmu NDJSON ieraksta tipu.'
            );
        };

        try {
            while (true) {
                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, {
                    stream: true
                });

                let newlineIndex;

                while (
                    (newlineIndex = buffer.indexOf('\n')) !== -1
                ) {
                    const line = buffer.slice(
                        0,
                        newlineIndex
                    );

                    buffer = buffer.slice(
                        newlineIndex + 1
                    );

                    processLine(
                        line.replace(/\r$/, '')
                    );
                }
            }

            buffer += decoder.decode();

            if (buffer.trim()) {
                processLine(buffer);
            }
        } finally {
            reader.releaseLock();
        }

        if (!meta || !complete) {
            throw new Error(
                'Servera NDJSON stream beidzās nepilnīgi.'
            );
        }

        if (complete.jobId !== meta.jobId) {
            throw new Error(
                'Backup job ID nesakrīt.'
            );
        }

        if (Number(complete.fileCount) !== files.length) {
            throw new Error(
                'Saņemto failu skaits nesakrīt ar servera rezultātu.'
            );
        }

        return {
            ...meta,
            ...complete,
            files
        };
    }, []);

    const formatFileSize = useCallback((bytes) => {
        const value = Number(bytes || 0);

        if (value < 1024) {
            return `${value} B`;
        }

        if (value < 1024 * 1024) {
            return `${(value / 1024).toFixed(2)} KB`;
        }

        if (value < 1024 * 1024 * 1024) {
            return `${(value / 1024 / 1024).toFixed(2)} MB`;
        }

        return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }, []);

    const isValidMasterKey = useCallback((value) => {
        try {
            if (typeof value !== 'string') {
                return false;
            }

            const normalized = value.trim();

            if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
                return false;
            }

            return ethers.getBytes(normalized).length === 32;
        } catch {
            return false;
        }
    }, []);

    /*
     * Merkle root tiek aprēķināts tikai no šī backup mainītajiem
     * failiem. Tas ir apzināti: katram backup ir savs commitment
     * pret konkrētajā reizē augšupielādētajiem mainītajiem failiem.
     */
    const calculateMerkleRoot = useCallback((files) => {
        const fileHashes = files.map(file =>
            ethers.keccak256(
                ethers.toUtf8Bytes(file.hash || '')
            )
        );

        if (fileHashes.length === 0) {
            return '0x0000000000000000000000000000000000000000000000000000000000000000';
        }

        return ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['bytes32[]'],
                [fileHashes]
            )
        );
    }, []);

    const encryptData = useCallback(async (data, keyHex) => {
        const keyBytes = ethers.getBytes(keyHex);

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            'AES-GCM',
            false,
            ['encrypt']
        );

        const iv = crypto.getRandomValues(
            new Uint8Array(12)
        );

        const encrypted = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv
            },
            cryptoKey,
            data
        );

        return {
            encrypted: new Uint8Array(encrypted),
            iv
        };
    }, []);

    const promptMasterKey = useCallback(() => {
        return new Promise(resolve => {
            const overlay = document.createElement('div');

            overlay.style.cssText =
                'position:fixed;inset:0;background:rgba(0,0,0,0.8);' +
                'display:flex;justify-content:center;align-items:center;' +
                'z-index:1000;padding:20px;';

            const box = document.createElement('div');

            box.style.cssText =
                'background:#161b22;border:1px solid #30363d;' +
                'border-radius:12px;padding:32px;max-width:480px;' +
                'width:100%;box-sizing:border-box;';

            const title = document.createElement('h2');

            title.textContent = t('key-title');

            title.style.cssText =
                'color:#79c0ff;margin-bottom:16px;';

            const input = document.createElement('input');

            input.type = 'password';
            input.placeholder = t('enter-key');

            input.style.cssText =
                'width:100%;padding:12px;background:#0d1117;' +
                'border:1px solid #30363d;border-radius:8px;' +
                'color:#e6edf3;font-size:16px;margin-bottom:16px;' +
                'box-sizing:border-box;';

            const confirmButton = document.createElement('button');

            confirmButton.textContent = t('confirm-key');

            confirmButton.style.cssText =
                'width:100%;padding:12px;background:#238636;' +
                'color:#fff;border:none;border-radius:8px;' +
                'font-size:16px;cursor:pointer;';

            const cancelButton = document.createElement('button');

            cancelButton.textContent = t('cancel');

            cancelButton.style.cssText =
                'width:100%;padding:12px;background:#30363d;' +
                'color:#fff;border:none;border-radius:8px;' +
                'font-size:16px;cursor:pointer;margin-top:8px;';

            box.appendChild(title);
            box.appendChild(input);
            box.appendChild(confirmButton);
            box.appendChild(cancelButton);

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const cleanup = () => {
                overlay.remove();
            };

            const submit = () => {
                const value = input.value.trim();

                cleanup();
                resolve(value);
            };

            confirmButton.onclick = submit;

            cancelButton.onclick = () => {
                cleanup();
                resolve(null);
            };

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                }

                if (e.key === 'Escape') {
                    cleanup();
                    resolve(null);
                }
            });

            input.focus();
        });
    }, [t]);

    const showMasterKey = useCallback((keyToShow) => {
        return new Promise(resolve => {
            const modal = document.createElement('div');

            modal.style.cssText =
                'position:fixed;inset:0;background:rgba(0,0,0,0.8);' +
                'display:flex;justify-content:center;align-items:center;' +
                'z-index:1000;padding:20px;';

            const box = document.createElement('div');

            box.style.cssText =
                'background:#161b22;border:1px solid #30363d;' +
                'border-radius:12px;padding:32px;max-width:480px;' +
                'width:100%;box-sizing:border-box;';

            const title = document.createElement('h2');

            title.textContent = t('key-title');

            title.style.cssText =
                'color:#79c0ff;margin-bottom:16px;';

            const description = document.createElement('p');

            description.textContent = t('key-description');

            description.style.cssText =
                'color:#b0b8c4;margin-bottom:16px;';

            const keyBox = document.createElement('div');

            keyBox.textContent = keyToShow;

            keyBox.style.cssText =
                'background:#0d1117;border:1px solid #30363d;' +
                'border-radius:8px;padding:16px;margin-bottom:16px;' +
                'word-break:break-all;font-family:monospace;' +
                'color:#e6edf3;';

            const copyButton = document.createElement('button');

            copyButton.textContent = t('copy-key');

            copyButton.style.cssText =
                'width:100%;padding:12px;background:#238636;' +
                'color:#fff;border:none;border-radius:8px;' +
                'font-size:16px;cursor:pointer;margin-bottom:8px;';

            const downloadButton = document.createElement('button');

            downloadButton.textContent = t('download-key');

            downloadButton.style.cssText =
                'width:100%;padding:12px;background:#21262d;' +
                'color:#fff;border:none;border-radius:8px;' +
                'font-size:16px;cursor:pointer;margin-bottom:8px;';

            const closeButton = document.createElement('button');

            closeButton.textContent = t('saving-key');

            closeButton.style.cssText =
                'width:100%;padding:12px;background:#f85149;' +
                'color:#fff;border:none;border-radius:8px;' +
                'font-size:16px;cursor:pointer;';

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
                    await navigator.clipboard.writeText(
                        keyToShow
                    );

                    copyButton.textContent = 'OK';
                } catch {
                    copyButton.textContent = 'FAIL';
                }
            };

            downloadButton.onclick = () => {
                const blob = new Blob(
                    [keyToShow],
                    {
                        type: 'text/plain;charset=utf-8'
                    }
                );

                const url = URL.createObjectURL(blob);

                const anchor = document.createElement('a');

                anchor.href = url;
                anchor.download =
                    `permrepo-master-key-${
                        repoName?.replace(/[^\w.-]/g, '_') ||
                        'backup'
                    }.txt`;

                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();

                URL.revokeObjectURL(url);
            };

            closeButton.onclick = () => {
                modal.remove();
                resolve(true);
            };
        });
    }, [t, repoName]);

    const renderStatusFromData = useCallback(() => {
        if (!lastStatusData) {
            return;
        }

        const data = lastStatusData;

        switch (data.type) {
            case 'uploading':
                setStatus(t('uploading'));
                break;

            case 'success':
                setStatus(t(data.key));
                break;

            case 'simple':
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
    }, [
        currentLanguage,
        lastStatusData,
        renderStatusFromData
    ]);

    useEffect(() => {
        let cancelled = false;

        const initPage = async () => {
            try {
                const configData = await apiJson('/api/config');

                if (cancelled) {
                    return;
                }

                setConfig(configData);

                if (
                    !repoName ||
                    !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName)
                ) {
                    setError(t('invalid-repo'));

                    setFileInfo({
                        count: 0,
                        sizeText: '',
                        loading: false
                    });

                    return;
                }

                const userData = await apiJson(
                    '/api/github/user'
                );

                if (!userData.success) {
                    window.location.href =
                        '/api/github/login';

                    return;
                }

                setGithubUser(userData.user);

                if (!window.ethereum) {
                    setError(t('connect-wallet'));

                    setFileInfo({
                        count: 0,
                        sizeText: '',
                        loading: false
                    });

                    return;
                }

                const provider =
                    new ethers.BrowserProvider(
                        window.ethereum
                    );

                const accounts =
                    await provider.send(
                        'eth_accounts',
                        []
                    );

                if (!accounts[0]) {
                    setError(t('connect-wallet'));

                    setFileInfo({
                        count: 0,
                        sizeText: '',
                        loading: false
                    });

                    return;
                }

                const currentAddress =
                    ethers.getAddress(accounts[0]);

                setUserAddress(currentAddress);

                const currentChainId =
                    await window.ethereum.request({
                        method: 'eth_chainId'
                    });

                if (
                    Number.parseInt(
                        currentChainId,
                        16
                    ) !== Number(configData.chainId)
                ) {
                    try {
                        await window.ethereum.request({
                            method:
                                'wallet_switchEthereumChain',
                            params: [
                                {
                                    chainId:
                                        configData.chainId
                                }
                            ]
                        });
                    } catch (switchError) {
                        if (switchError.code === 4902) {
                            await window.ethereum.request({
                                method:
                                    'wallet_addEthereumChain',
                                params: [
                                    {
                                        chainId:
                                            configData.chainId,
                                        chainName: 'Base',
                                        rpcUrls: [
                                            configData.rpcUrl
                                        ],
                                        nativeCurrency: {
                                            name: 'ETH',
                                            symbol: 'ETH',
                                            decimals: 18
                                        }
                                    }
                                ]
                            });
                        } else {
                            throw switchError;
                        }
                    }
                }

                /*
                 * Serveris šeit vienlaikus pārbauda:
                 * - aktīvu subscription
                 * - NFT owner
                 * - repo piekļuvi
                 *
                 * /api/prepare-backup tagad atgriež NDJSON streamu.
                 */
                const result = await apiNdjson(
                    '/api/prepare-backup',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body: JSON.stringify({
                            repoName,
                            walletAddress:
                                currentAddress
                        })
                    }
                );

                if (cancelled) {
                    return;
                }

                setNftInfo({
                    tokenId: result.tokenId,
                    backupCount:
                        result.backupCount,
                    lastManifest:
                        result.lastManifest ||
                        null,
                    lastMerkleRoot:
                        result.lastMerkleRoot ||
                        null
                });

                setPreparedJobId(
                    result.jobId
                );

                let previousPaths = {};
                let previousHistory = [];
                let previousEncryptionIVs = {};

                if (
                    result.lastManifest &&
                    result.lastManifest.startsWith('ar://')
                ) {
                    const prevManifestId =
                        result.lastManifest.slice(5);

                    if (
                        !isValidManifestId(
                            prevManifestId
                        )
                    ) {
                        throw new Error(
                            t('invalid-manifest')
                        );
                    }

                    setCurrentPreviousManifestId(
                        prevManifestId
                    );

                    const manifestUrl =
                        getValidatedManifestUrl(
                            configData.arweaveGateway,
                            prevManifestId
                        );

                    const manifestResponse =
                        await fetch(
                            manifestUrl,
                            {
                                cache: 'no-store'
                            }
                        );

                    if (!manifestResponse.ok) {
                        throw new Error(
                            t('manifest-load-failed')
                        );
                    }

                    const prevManifest =
                        await manifestResponse.json();

                    if (
                        prevManifest &&
                        typeof prevManifest.paths ===
                            'object' &&
                        !Array.isArray(
                            prevManifest.paths
                        )
                    ) {
                        previousPaths =
                            prevManifest.paths;

                        setCurrentUnchangedFiles(
                            prevManifest.paths
                        );
                    }

                    if (
                        Array.isArray(
                            prevManifest?.history
                        )
                    ) {
                        previousHistory =
                            prevManifest.history;

                        setCurrentPreviousHistory(
                            prevManifest.history
                        );
                    }

                    if (
                        prevManifest?.encryption?.ivs &&
                        typeof
                            prevManifest.encryption.ivs ===
                            'object' &&
                        !Array.isArray(
                            prevManifest.encryption.ivs
                        )
                    ) {
                        previousEncryptionIVs =
                            prevManifest.encryption.ivs;

                        setCurrentPreviousEncryptionIVs(
                            prevManifest.encryption.ivs
                        );
                    }
                }

                const files = result.files || [];

                const changedFiles = [];
                const unchangedFiles = {};

                for (const file of files) {
                    const previousFile =
                        previousPaths[file.path];

                    if (
                        previousFile &&
                        previousFile.hash &&
                        previousFile.hash ===
                            file.hash &&
                        isValidManifestId(
                            previousFile.id ||
                            previousFile.zipId
                        )
                    ) {
                        unchangedFiles[file.path] = {
                            id:
                                previousFile.id ||
                                previousFile.zipId,
                            hash: file.hash
                        };
                    } else {
                        changedFiles.push(file);
                    }
                }

                setCurrentPreviousBackupNumber(
                    Number(
                        result.backupCount || 0
                    )
                );

                setFileInfo({
                    count:
                        changedFiles.length,
                    sizeText:
                        formatFileSize(
                            changedFiles.reduce(
                                (sum, file) =>
                                    sum +
                                    Number(file.size),
                                0
                            )
                        ),
                    loading: false
                });

                setChangedFilesForUpload(
                    changedFiles
                );

                setUnchangedFilesForUpload(
                    unchangedFiles
                );
            } catch (e) {
                if (cancelled) {
                    return;
                }

                setError(
                    getSafeErrorMessage(e)
                );

                setFileInfo({
                    count: 0,
                    sizeText: '',
                    loading: false
                });
            }
        };

        initPage();

        return () => {
            cancelled = true;
        };
    }, [
        apiJson,
        apiNdjson,
        repoName,
        t,
        formatFileSize
    ]);

    const continueBackup = useCallback(async () => {
        if (!config) {
            setError(
                'Konfigurācija vēl nav ielādēta!'
            );
            return;
        }

        if (!window.ethereum || !userAddress) {
            setError(t('connect-wallet'));
            return;
        }

        if (changedFilesForUpload.length === 0) {
            setStatus(t('no-changes'));

            setLastStatusData({
                type: 'simple',
                key: 'no-changes'
            });

            return;
        }

        try {
            setIsWorking(true);
            setError('');

            const currentChainId =
                await window.ethereum.request({
                    method: 'eth_chainId'
                });

            if (
                Number.parseInt(
                    currentChainId,
                    16
                ) !== Number(config.chainId)
            ) {
                try {
                    await window.ethereum.request({
                        method:
                            'wallet_switchEthereumChain',
                        params: [
                            {
                                chainId:
                                    config.chainId
                            }
                        ]
                    });
                } catch (switchError) {
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method:
                                'wallet_addEthereumChain',
                            params: [
                                {
                                    chainId:
                                        config.chainId,
                                    chainName: 'Base',
                                    rpcUrls: [
                                        config.rpcUrl
                                    ],
                                    nativeCurrency: {
                                        name: 'ETH',
                                        symbol: 'ETH',
                                        decimals: 18
                                    }
                                }
                            ]
                        });
                    } else {
                        throw switchError;
                    }
                }
            }

            const provider =
                new ethers.BrowserProvider(
                    window.ethereum
                );

            const signerInstance =
                await provider.getSigner();

            const client =
                TurboFactory.authenticated({
                    signer:
                        new InjectedEthereumSigner({
                            getSigner: () =>
                                signerInstance
                        }),
                    token: 'base-eth',
                    gatewayUrl:
                        config.rpcUrl,
                    uploadServiceConfig: {
                        url:
                            config.turboUploadUrl
                    },
                    paymentServiceConfig: {
                        url:
                            config.turboPaymentUrl
                    }
                });

            const backupCount =
                Number(
                    nftInfo.backupCount || 0
                );

            let keyHex;

            if (backupCount === 0) {
                if (!masterKeyRef.current) {
                    const keyBytes =
                        crypto.getRandomValues(
                            new Uint8Array(32)
                        );

                    masterKeyRef.current =
                        ethers.hexlify(
                            keyBytes
                        );

                    const saved =
                        await showMasterKey(
                            masterKeyRef.current
                        );

                    if (!saved) {
                        masterKeyRef.current =
                            null;

                        setIsWorking(false);

                        return;
                    }
                }

                keyHex =
                    masterKeyRef.current;
            } else {
                keyHex =
                    await promptMasterKey();

                if (
                    !isValidMasterKey(
                        keyHex
                    )
                ) {
                    setError(
                        t('encrypted-required')
                    );

                    setIsWorking(false);

                    return;
                }

                masterKeyRef.current =
                    keyHex;
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
            if (
                e.code === 'ACTION_REJECTED' ||
                e.code === 4001
            ) {
                setError(
                    t('transaction-cancelled')
                );
            } else {
                setError(
                    getSafeErrorMessage(e)
                );
            }

            setIsWorking(false);
        }
    }, [
        config,
        userAddress,
        nftInfo.backupCount,
        repoName,
        t,
        changedFilesForUpload,
        unchangedFilesForUpload,
        preparedJobId,
        showMasterKey,
        promptMasterKey,
        isValidMasterKey
    ]);

    const uploadZip = useCallback(
        async (
            jobId,
            changedFiles,
            unchangedFiles,
            keyHex,
            client,
            signerInstance
        ) => {
            if (
                !config ||
                !jobId ||
                !nftInfo.tokenId
            ) {
                setError(
                    t('backup-session-invalid')
                );

                return;
            }

            setStatus(t('creating-zip'));

            setLastStatusData({
                type: 'simple',
                key: 'creating-zip'
            });

            try {
                let zipTxId =
                    uploadedZipRef.current.txId;

                let iv =
                    uploadedZipRef.current.iv;

                let merkleRoot =
                    uploadedZipRef.current.merkleRoot;

                /*
                 * Browserī tiek veidots ZIP tikai no mainītajiem
                 * failiem. Servera GitHub ZIP vairs netiek turēts
                 * servera RAM kā viss ZIP fails.
                 */
                if (!zipTxId) {
                    const zip = new JSZip();

                    for (const file of changedFiles) {
                        if (
                            typeof file.content !==
                            'string'
                        ) {
                            throw new Error(
                                t('invalid-file-data')
                            );
                        }

                        const binaryString =
                            atob(file.content);

                        const fileBuffer =
                            new Uint8Array(
                                binaryString.length
                            );

                        for (
                            let j = 0;
                            j <
                            binaryString.length;
                            j++
                        ) {
                            fileBuffer[j] =
                                binaryString.charCodeAt(
                                    j
                                );
                        }

                        zip.file(
                            file.path,
                            fileBuffer
                        );
                    }

                    const zipBuffer =
                        await zip.generateAsync({
                            type: 'uint8array',
                            compression: 'DEFLATE',
                            compressionOptions: {
                                level: 6
                            }
                        });

                    setStatus(
                        t('encrypting')
                    );

                    setLastStatusData({
                        type: 'simple',
                        key: 'encrypting'
                    });

                    const encrypted =
                        await encryptData(
                            zipBuffer,
                            keyHex
                        );

                    const encryptedZipData =
                        encrypted.encrypted;

                    iv =
                        encrypted.iv;

                    merkleRoot =
                        calculateMerkleRoot(
                            changedFiles
                        );

                    setCurrentIV(iv);
                    setCurrentMerkleRoot(
                        merkleRoot
                    );

                    setStatus(
                        t('uploading')
                    );

                    setLastStatusData({
                        type: 'uploading'
                    });

                    const zipBlob =
                        new Blob(
                            [encryptedZipData],
                            {
                                type:
                                    'application/zip'
                            }
                        );

                    const zipResult =
                        await client.uploadFile({
                            fileStreamFactory:
                                () =>
                                    zipBlob.stream(),

                            fileSizeFactory:
                                () =>
                                    zipBlob.size,

                            dataItemOpts: {
                                tags: [
                                    {
                                        name:
                                            'App-Name',
                                        value:
                                            'PermRepo'
                                    },
                                    {
                                        name:
                                            'Repo',
                                        value:
                                            `${githubUser}/${repoName}`
                                    },
                                    {
                                        name:
                                            'Type',
                                        value:
                                            'backup-archive'
                                    },
                                    {
                                        name:
                                            'Content-Type',
                                        value:
                                            'application/zip'
                                    },
                                    {
                                        name:
                                            'Encrypted',
                                        value:
                                            'true'
                                    },
                                    {
                                        name:
                                            'Unix-Time',
                                        value:
                                            String(
                                                Math.floor(
                                                    Date.now() /
                                                        1000
                                                )
                                            )
                                    }
                                ]
                            },

                            chunkByteCount:
                                5 *
                                1024 *
                                1024,

                            maxChunkConcurrency: 3,

                            chunkingMode: 'auto'
                        });

                    if (
                        !isValidManifestId(
                            zipResult?.id
                        )
                    ) {
                        throw new Error(
                            t('invalid-upload-id')
                        );
                    }

                    zipTxId =
                        zipResult.id;

                    uploadedZipRef.current = {
                        txId: zipTxId,
                        iv,
                        merkleRoot
                    };

                    await apiJson(
                        '/api/save-zip-tx',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId,
                                    zipTxId
                                })
                        }
                    );
                } else {
                    /*
                     * Ja ZIP jau bija augšupielādēts,
                     * serverim atkārtoti saglabājam to pašu ID.
                     */
                    await apiJson(
                        '/api/save-zip-tx',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId,
                                    zipTxId
                                })
                        }
                    );
                }

                setStatus(
                    t('manifest-ready')
                );

                setLastStatusData({
                    type: 'simple',
                    key: 'manifest-ready'
                });

                let manifest =
                    uploadedManifestRef.current
                        .manifest;

                let manifestTxId =
                    uploadedManifestRef.current
                        .txId;

                if (!manifestTxId) {
                    const history = [
                        ...currentPreviousHistory
                    ];

                    if (
                        currentPreviousManifestId
                    ) {
                        const alreadyExists =
                            history.some(
                                entry =>
                                    entry &&
                                    entry.manifestId ===
                                        currentPreviousManifestId
                            );

                        if (!alreadyExists) {
                            history.push({
                                backupNumber:
                                    currentPreviousBackupNumber ||
                                    history.length,

                                manifestId:
                                    currentPreviousManifestId,

                                url:
                                    `/raw/${encodeURIComponent(
                                        currentPreviousManifestId
                                    )}`
                            });
                        }
                    }

                    history.sort(
                        (a, b) =>
                            Number(
                                b?.backupNumber || 0
                            ) -
                            Number(
                                a?.backupNumber || 0
                            )
                    );

                    const encryptionIVs = {
                        ...currentPreviousEncryptionIVs
                    };

                    if (
                        iv &&
                        iv.length === 12
                    ) {
                        encryptionIVs[
                            zipTxId
                        ] =
                            Array.from(iv);
                    }

                    manifest = {
                        manifest:
                            'arweave/paths',

                        version:
                            '0.2.0',

                        encryption: {
                            ivs:
                                encryptionIVs
                        },

                        archive: {
                            id:
                                zipTxId,

                            url:
                                `/raw/${encodeURIComponent(
                                    zipTxId
                                )}`,

                            contains:
                                changedFiles.map(
                                    file => ({
                                        path:
                                            file.path,
                                        hash:
                                            file.hash
                                    })
                                )
                        },

                        paths: {},

                        history
                    };

                    for (
                        const file of changedFiles
                    ) {
                        manifest.paths[
                            file.path
                        ] = {
                            id:
                                zipTxId,
                            hash:
                                file.hash
                        };
                    }

                    for (
                        const [
                            filePath,
                            info
                        ] of Object.entries(
                            unchangedFiles
                        )
                    ) {
                        manifest.paths[
                            filePath
                        ] = {
                            id:
                                info.id,
                            hash:
                                info.hash
                        };
                    }

                    const manifestPaths =
                        Object.keys(
                            manifest.paths
                        );

                    if (
                        manifestPaths.length > 0
                    ) {
                        manifest.index = {
                            path:
                                manifest.paths[
                                    'README.md'
                                ]
                                    ? 'README.md'
                                    : manifestPaths[0]
                        };
                    }

                    const manifestBlob =
                        new Blob(
                            [
                                JSON.stringify(
                                    manifest
                                )
                            ],
                            {
                                type:
                                    'application/x.arweave-manifest+json'
                            }
                        );

                    const manifestResult =
                        await client.uploadFile({
                            fileStreamFactory:
                                () =>
                                    manifestBlob.stream(),

                            fileSizeFactory:
                                () =>
                                    manifestBlob.size,

                            dataItemOpts: {
                                tags: [
                                    {
                                        name:
                                            'App-Name',
                                        value:
                                            'PermRepo'
                                    },
                                    {
                                        name:
                                            'Type',
                                        value:
                                            'path-manifest'
                                    },
                                    {
                                        name:
                                            'Repo',
                                        value:
                                            `${githubUser}/${repoName}`
                                    },
                                    {
                                        name:
                                            'Content-Type',
                                        value:
                                            'application/x.arweave-manifest+json'
                                    },
                                    {
                                        name:
                                            'Unix-Time',
                                        value:
                                            String(
                                                Math.floor(
                                                    Date.now() /
                                                        1000
                                                )
                                            )
                                    }
                                ]
                            },

                            chunkByteCount:
                                5 *
                                1024 *
                                1024,

                            maxChunkConcurrency: 3,

                            chunkingMode: 'auto'
                        });

                    if (
                        !isValidManifestId(
                            manifestResult?.id
                        )
                    ) {
                        throw new Error(
                            t('invalid-upload-id')
                        );
                    }

                    manifestTxId =
                        manifestResult.id;

                    uploadedManifestRef.current = {
                        txId:
                            manifestTxId,
                        manifest
                    };

                    await apiJson(
                        '/api/save-manifest-tx',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId,
                                    manifestTxId,
                                    manifest
                                })
                        }
                    );
                } else {
                    await apiJson(
                        '/api/save-manifest-tx',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId,
                                    manifestTxId,
                                    manifest
                                })
                        }
                    );
                }

                setStatus(
                    t('signing')
                );

                setLastStatusData({
                    type: 'simple',
                    key: 'signing'
                });

                const provider =
                    new ethers.BrowserProvider(
                        window.ethereum
                    );

                const accounts =
                    await provider.send(
                        'eth_accounts',
                        []
                    );

                if (
                    !accounts[0] ||
                    accounts[0].toLowerCase() !==
                        userAddress.toLowerCase()
                ) {
                    throw new Error(
                        t('wallet-changed')
                    );
                }

                const currentSigner =
                    await provider.getSigner();

                const readContract =
                    new ethers.Contract(
                        config.nftAddress,
                        NFT_ABI,
                        provider
                    );

                const tokenId =
                    BigInt(nftInfo.tokenId);

                const owner =
                    await readContract.ownerOf(
                        tokenId
                    );

                if (
                    owner.toLowerCase() !==
                    userAddress.toLowerCase()
                ) {
                    throw new Error(
                        t('nft-not-owned')
                    );
                }

                const deadline =
                    Math.floor(
                        Date.now() / 1000
                    ) + 600;

                const currentNonce =
                    await readContract.getNonce(
                        tokenId
                    );

                const onChainBackupCount =
                    await readContract.getBackupCount(
                        tokenId
                    );

                const manifestURI =
                    `ar://${manifestTxId}`;

                const manifestHash =
                    ethers.keccak256(
                        ethers.toUtf8Bytes(
                            manifestURI
                        )
                    );

                const domain = {
                    name: 'PermRepo',
                    version: '1',
                    chainId:
                        Number(
                            config.chainId
                        ),
                    verifyingContract:
                        config.nftAddress
                };

                const types = {
                    AddBackup: [
                        {
                            name:
                                'tokenId',
                            type:
                                'uint256'
                        },
                        {
                            name:
                                'backupNumber',
                            type:
                                'uint256'
                        },
                        {
                            name:
                                'manifestHash',
                            type:
                                'bytes32'
                        },
                        {
                            name:
                                'merkleRoot',
                            type:
                                'bytes32'
                        },
                        {
                            name:
                                'deadline',
                            type:
                                'uint256'
                        },
                        {
                            name:
                                'nonce',
                            type:
                                'uint256'
                        }
                    ]
                };

                const value = {
                    tokenId,

                    backupNumber:
                        onChainBackupCount +
                        1n,

                    manifestHash,

                    merkleRoot,

                    deadline:
                        BigInt(
                            deadline
                        ),

                    nonce:
                        currentNonce
                };

                const signature =
                    await currentSigner.signTypedData(
                        domain,
                        types,
                        value
                    );

                const nftWrite =
                    new ethers.Contract(
                        config.nftAddress,
                        NFT_ABI,
                        currentSigner
                    );

                const tx =
                    await nftWrite.addBackup(
                        tokenId,
                        manifestHash,
                        merkleRoot,
                        manifestURI,
                        BigInt(deadline),
                        signature
                    );

                await tx.wait();

                setNftInfo({
                    tokenId:
                        nftInfo.tokenId,

                    backupCount:
                        (
                            onChainBackupCount +
                            1n
                        ).toString(),

                    lastManifest:
                        manifestURI,

                    lastMerkleRoot:
                        merkleRoot
                });

                setLastManifestTxId(
                    manifestTxId
                );

                setBackupCompleted(
                    true
                );

                setStatus(
                    t('backup-complete')
                );

                setLastStatusData({
                    type: 'success',
                    key:
                        'backup-complete'
                });
            } catch (e) {
                if (
                    e.code ===
                        'ACTION_REJECTED' ||
                    e.code === 4001
                ) {
                    setError(
                        t('transaction-cancelled')
                    );
                } else {
                    setError(
                        getSafeErrorMessage(e)
                    );
                }
            } finally {
                setIsWorking(false);
            }
        },
        [
            apiJson,
            t,
            githubUser,
            repoName,
            config,
            currentPreviousHistory,
            currentPreviousManifestId,
            currentPreviousBackupNumber,
            currentPreviousEncryptionIVs,
            nftInfo.tokenId,
            calculateMerkleRoot,
            encryptData,
            userAddress
        ]
    );

    if (!config) {
        return (
            <div className="container">
                <div
                    style={{
                        textAlign: 'center',
                        padding: '20px'
                    }}
                >
                    <div className="spinner"></div>
                </div>
            </div>
        );
    }

    const finalManifestUrl =
        lastManifestTxId
            ? getValidatedManifestUrl(
                  config.arweaveGateway,
                  lastManifestTxId
              )
            : null;

    return (
        <div className="container">
            <div className="language-selector">
                <button
                    className={`lang-btn ${
                        currentLanguage === 'lv'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage('lv')
                    }
                >
                    LV
                </button>

                <button
                    className={`lang-btn ${
                        currentLanguage === 'en'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage('en')
                    }
                >
                    EN
                </button>

                <button
                    className={`lang-btn ${
                        currentLanguage === 'eo'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage('eo')
                    }
                >
                    EO
                </button>
            </div>

            <img
                src="/icons/logo-nosaukums.svg"
                alt="PermRepo"
                className="logo-title"
            />

            <p className="subtitle">
                {t('repo-label')}:{' '}
                {repoName || '-'}
            </p>

            <div className="info-row text-left">
                <span className="info-label">
                    {t('nft-token')}
                </span>

                <span className="info-value">
                    {nftInfo.tokenId || '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t('backup-count')}
                </span>

                <span className="info-value">
                    {nftInfo.backupCount || '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t('last-manifest')}
                </span>

                <span className="info-value">
                    {nftInfo.lastManifest || '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t('last-merkle')}
                </span>

                <span className="info-value">
                    {nftInfo.lastMerkleRoot || '-'}
                </span>
            </div>

            {fileInfo.loading ? (
                <div
                    style={{
                        textAlign: 'center',
                        padding: '20px'
                    }}
                >
                    <div className="spinner"></div>
                </div>
            ) : (
                <>
                    <div
                        style={{
                            padding: '8px 0',
                            borderBottom:
                                '1px solid rgba(255,255,255,0.08)'
                        }}
                    >
                        <Icon name="fails" />
                        {' '}
                        {t('files-count')}:{' '}
                        <strong>
                            {fileInfo.count}
                        </strong>
                    </div>

                    <div
                        style={{
                            padding: '8px 0',
                            borderBottom:
                                '1px solid rgba(255,255,255,0.08)'
                        }}
                    >
                        <Icon name="fails" />
                        {' '}
                        {t('files-size')}:{' '}
                        <strong>
                            {fileInfo.sizeText}
                        </strong>
                    </div>
                </>
            )}

            {!backupCompleted ? (
                <button
                    onClick={continueBackup}
                    disabled={
                        isWorking ||
                        fileInfo.loading ||
                        fileInfo.count === 0
                    }
                    className="sign-button"
                    style={{
                        marginTop: '20px'
                    }}
                >
                    {isWorking ? (
                        <div
                            style={{
                                textAlign: 'center'
                            }}
                        >
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        t('continue-backup')
                    )}
                </button>
            ) : (
                <button
                    onClick={() =>
                        navigate('/')
                    }
                    className="sign-button"
                    style={{
                        marginTop: '20px'
                    }}
                >
                    {t('back-home')}
                </button>
            )}

            {status && (
                <div
                    className="status-card"
                    style={{
                        display: 'block'
                    }}
                >
                    <div
                        style={{
                            whiteSpace: 'pre-wrap'
                        }}
                    >
                        <Icon
                            name={
                                lastStatusData?.type ===
                                'success'
                                    ? 'izdevas-veiksmigi'
                                    : 'upload'
                            }
                        />

                        {' '}
                        {status}
                    </div>

                    {backupCompleted &&
                        lastManifestTxId && (
                            <div
                                style={{
                                    marginTop: '12px'
                                }}
                            >
                                <Icon name="manifests" />

                                {' '}
                                {t(
                                    'manifest-link'
                                )}
                                :{' '}

                                <a
                                    href={
                                        finalManifestUrl
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    ar://
                                    {
                                        lastManifestTxId
                                    }
                                </a>
                            </div>
                        )}
                </div>
            )}

            {error && (
                <div className="error">
                    <Icon name="kluda" />
                    {' '}
                    {error}
                </div>
            )}
        </div>
    );
}

export default BackupPage;
