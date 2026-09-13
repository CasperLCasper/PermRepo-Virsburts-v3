import React, {
    useState,
    useEffect,
    useCallback,
    useRef
} from 'react';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import {
    useSearchParams,
    useNavigate
} from 'react-router-dom';
import {
    useLanguage
} from './LanguageContext';
import {
    TurboFactory
} from '@ardrive/turbo-sdk/web';
import {
    InjectedEthereumSigner
} from '@dha-team/arbundles';

const NFT_ABI = [
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

// React komponente ikonai
function Icon({
    name
}) {
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
const ALLOWED_SCHEMES = [
    'https:'
];

// Manifesta ID validācija
function isValidManifestId(
    id
) {
    return (
        typeof id === 'string' &&
        /^[a-zA-Z0-9_-]{43}$/.test(
            id
        )
    );
}

// Droša URL validācija
function getValidatedManifestUrl(
    gatewayUrl,
    manifestId
) {
    if (
        !isValidManifestId(
            manifestId
        )
    ) {
        throw new Error(
            'Nederīgs manifesta ID'
        );
    }

    let parsedUrl;

    try {
        parsedUrl =
            new URL(
                gatewayUrl
            );
    } catch (e) {
        throw new Error(
            'Nederīgs gateway URL'
        );
    }

    if (
        !ALLOWED_SCHEMES.includes(
            parsedUrl.protocol
        )
    ) {
        throw new Error(
            'Nederīga shēma'
        );
    }

    if (
        !ALLOWED_GATEWAY_HOSTS.includes(
            parsedUrl.hostname
        )
    ) {
        throw new Error(
            'Nederīgs gateway hosts'
        );
    }

    return `${parsedUrl.origin}/raw/${encodeURIComponent(manifestId)}`;
}

// Droša kļūdas ziņojuma iegūšana
function getSafeErrorMessage(
    error
) {
    if (!error) {
        return 'Nezināma kļūda';
    }

    if (
        typeof error ===
        'string'
    ) {
        return error.substring(
            0,
            200
        );
    }

    if (
        error.message &&
        typeof error.message ===
            'string'
    ) {
        return error.message.substring(
            0,
            200
        );
    }

    return 'Nezināma kļūda';
}

function BackupPage() {
    const [
        searchParams
    ] = useSearchParams();

    const navigate =
        useNavigate();

    const {
        currentLanguage,
        t,
        switchLanguage
    } = useLanguage();

    const [
        config,
        setConfig
    ] = useState(
        null
    );

    const repoName =
        searchParams.get(
            'repo'
        );

    const [
        githubUser,
        setGithubUser
    ] = useState(
        null
    );

    const [
        userAddress,
        setUserAddress
    ] = useState(
        null
    );

    const [
        status,
        setStatus
    ] = useState(
        ''
    );

    const [
        error,
        setError
    ] = useState(
        ''
    );

    const [
        isWorking,
        setIsWorking
    ] = useState(
        false
    );

    const [
        backupCompleted,
        setBackupCompleted
    ] = useState(
        false
    );

    const [
        lastManifestTxId,
        setLastManifestTxId
    ] = useState(
        null
    );

    const [
        nftInfo,
        setNftInfo
    ] = useState({
        tokenId:
            null,
        backupCount:
            null,
        lastManifest:
            null,
        lastMerkleRoot:
            null
    });

    const [
        currentUnchangedFiles,
        setCurrentUnchangedFiles
    ] = useState(
        {}
    );

    const [
        currentPreviousHistory,
        setCurrentPreviousHistory
    ] = useState(
        []
    );

    const [
        currentPreviousManifestId,
        setCurrentPreviousManifestId
    ] = useState(
        null
    );

    const [
        currentPreviousBackupNumber,
        setCurrentPreviousBackupNumber
    ] = useState(
        null
    );

    const [
        currentPreviousEncryptionIVs,
        setCurrentPreviousEncryptionIVs
    ] = useState(
        {}
    );

    const [
        currentMerkleRoot,
        setCurrentMerkleRoot
    ] = useState(
        null
    );

    const [
        currentIV,
        setCurrentIV
    ] = useState(
        null
    );

    const [
        lastStatusData,
        setLastStatusData
    ] = useState(
        null
    );

    const [
        fileInfo,
        setFileInfo
    ] = useState({
        count:
            0,
        sizeText:
            '',
        loading:
            true
    });

    const [
        changedFilesForUpload,
        setChangedFilesForUpload
    ] = useState(
        []
    );

    const [
        unchangedFilesForUpload,
        setUnchangedFilesForUpload
    ] = useState(
        {}
    );

    const [
        preparedJobId,
        setPreparedJobId
    ] = useState(
        null
    );

    // Saglabājam pašreizējā mēģinājuma progresu tikai atmiņā.
    // Tas ļauj kļūmes gadījumā turpināt jau augšupielādēto darbu,
    // neradot jaunu ZIP ar citu IV/MK.
    const masterKeyRef =
        useRef(
            null
        );

    const uploadedZipRef =
        useRef({
            txId:
                null,
            iv:
                null,
            merkleRoot:
                null
        });

    const uploadedManifestRef =
        useRef({
            txId:
                null,
            manifest:
                null
        });

    const apiJson =
        useCallback(
            async (
                url,
                options = {}
            ) => {
                const response =
                    await fetch(
                        url,
                        {
                            credentials:
                                'same-origin',
                            ...options
                        }
                    );

                let result;

                try {
                    result =
                        await response.json();
                } catch {
                    throw new Error(
                        `Servera kļūda: HTTP ${response.status}`
                    );
                }

                if (
                    !response.ok &&
                    !result.success
                ) {
                    throw new Error(
                        result.error ||
                        `HTTP ${response.status}`
                    );
                }

                return result;
            },
            []
        );

    /*
     * NDJSON klienta lasītājs.
     *
     * /api/prepare-backup neatgriež milzīgu JSON objektu,
     * bet straumē:
     *
     * {"type":"queued", ...}
     * {"type":"started", ...}
     * {"type":"meta", ...}
     * {"type":"file", "file": {...}}
     * {"type":"file", "file": {...}}
     * ...
     * {"type":"complete", ...}
     *
     * Serverim nav jāuzbūvē viens milzīgs JSON response.
     */
    const apiNdjson =
        useCallback(
            async (
                url,
                options = {},
                onRecord = null
            ) => {
                const response =
                    await fetch(
                        url,
                        {
                            credentials:
                                'same-origin',
                            ...options
                        }
                    );

                if (
                    !response.ok
                ) {
                    let result =
                        null;

                    try {
                        result =
                            await response.json();
                    } catch {
                        // Servera atbilde nav JSON.
                    }

                    throw new Error(
                        result?.error ||
                        `HTTP ${response.status}`
                    );
                }

                if (
                    !response.body
                ) {
                    throw new Error(
                        'Serveris neatgrieza datu streamu.'
                    );
                }

                const reader =
                    response.body.getReader();

                const decoder =
                    new TextDecoder(
                        'utf-8'
                    );

                let buffer =
                    '';

                let meta =
                    null;

                let complete =
                    null;

                let queued =
                    null;

                const files =
                    [];

                const processLine =
                    line => {
                        const trimmed =
                            line.trim();

                        if (
                            !trimmed
                        ) {
                            return;
                        }

                        let record;

                        try {
                            record =
                                JSON.parse(
                                    trimmed
                                );
                        } catch {
                            throw new Error(
                                'Servera NDJSON ieraksts nav derīgs JSON.'
                            );
                        }

                        if (
                            typeof onRecord ===
                            'function'
                        ) {
                            onRecord(
                                record
                            );
                        }

                        if (
                            record.type ===
                            'queued'
                        ) {
                            if (
                                !record.success ||
                                !record.jobId
                            ) {
                                throw new Error(
                                    record.error ||
                                    'Backup rindu neizdevās izveidot.'
                                );
                            }

                            queued =
                                record;

                            return;
                        }

                        if (
                            record.type ===
                            'started'
                        ) {
                            return;
                        }

                        if (
                            record.type ===
                            'meta'
                        ) {
                            if (
                                !record.success ||
                                !record.jobId
                            ) {
                                throw new Error(
                                    record.error ||
                                    'Backup sagatavošana neizdevās.'
                                );
                            }

                            meta =
                                record;

                            return;
                        }

                        if (
                            record.type ===
                            'file'
                        ) {
                            if (
                                !record.file ||
                                typeof record.file.path !==
                                    'string'
                            ) {
                                throw new Error(
                                    'Serveris nosūtīja nederīgu faila ierakstu.'
                                );
                            }

                            files.push(
                                record.file
                            );

                            return;
                        }

                        if (
                            record.type ===
                            'complete'
                        ) {
                            if (
                                !record.success ||
                                !record.jobId
                            ) {
                                throw new Error(
                                    record.error ||
                                    'Backup sagatavošana neizdevās.'
                                );
                            }

                            complete =
                                record;

                            return;
                        }

                        if (
                            record.type ===
                            'error'
                        ) {
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
                    while (
                        true
                    ) {
                        const {
                            value,
                            done
                        } =
                            await reader.read();

                        if (
                            done
                        ) {
                            break;
                        }

                        buffer +=
                            decoder.decode(
                                value,
                                {
                                    stream:
                                        true
                                }
                            );

                        let newlineIndex;

                        while (
                            (
                                newlineIndex =
                                    buffer.indexOf(
                                        '\n'
                                    )
                            ) !== -1
                        ) {
                            const line =
                                buffer.slice(
                                    0,
                                    newlineIndex
                                );

                            buffer =
                                buffer.slice(
                                    newlineIndex +
                                        1
                                );

                            processLine(
                                line.replace(
                                    /\r$/,
                                    ''
                                )
                            );
                        }
                    }

                    buffer +=
                        decoder.decode();

                    if (
                        buffer.trim()
                    ) {
                        processLine(
                            buffer
                        );
                    }
                } finally {
                    reader.releaseLock();
                }

                if (
                    !meta ||
                    !complete
                ) {
                    throw new Error(
                        'Servera NDJSON stream beidzās nepilnīgi.'
                    );
                }

                if (
                    complete.jobId !==
                    meta.jobId
                ) {
                    throw new Error(
                        'Backup job ID nesakrīt.'
                    );
                }

                if (
                    Number(
                        complete.fileCount
                    ) !==
                    files.length
                ) {
                    throw new Error(
                        'Saņemto failu skaits nesakrīt ar servera rezultātu.'
                    );
                }

                return {
                    ...meta,
                    ...complete,
                    queue:
                        queued,
                    files
                };
            },
            []
        );

    const formatFileSize =
        useCallback(
            bytes => {
                const value =
                    Number(
                        bytes ||
                        0
                    );

                if (
                    value <
                    1024
                ) {
                    return `${value} B`;
                }

                if (
                    value <
                    1024 *
                        1024
                ) {
                    return `${(
                        value /
                        1024
                    ).toFixed(
                        2
                    )} KB`;
                }

                if (
                    value <
                    1024 *
                        1024 *
                        1024
                ) {
                    return `${(
                        value /
                        1024 /
                        1024
                    ).toFixed(
                        2
                    )} MB`;
                }

                return `${(
                    value /
                    1024 /
                    1024 /
                    1024
                ).toFixed(
                    2
                )} GB`;
            },
            []
        );

    const generateMasterKey =
        useCallback(
            async () => {
                const keyBytes =
                    crypto.getRandomValues(
                        new Uint8Array(
                            32
                        )
                    );

                const keyHex =
                    Array.from(
                        keyBytes
                    )
                        .map(
                            byte =>
                                byte
                                    .toString(
                                        16
                                    )
                                    .padStart(
                                        2,
                                        '0'
                                    )
                        )
                        .join(
                            ''
                        );

                masterKeyRef.current =
                    keyHex;

                return keyHex;
            },
            []
        );

    const encryptData =
        useCallback(
            async (
                data,
                masterKeyHex
            ) => {
                const keyBytes =
                    new Uint8Array(
                        masterKeyHex
                            .match(
                                /.{2}/g
                            )
                            .map(
                                byte =>
                                    parseInt(
                                        byte,
                                        16
                                    )
                            )
                    );

                const cryptoKey =
                    await window.crypto.subtle.importKey(
                        'raw',
                        keyBytes,
                        {
                            name:
                                'AES-GCM'
                        },
                        false,
                        [
                            'encrypt'
                        ]
                    );

                const iv =
                    window.crypto.getRandomValues(
                        new Uint8Array(
                            12
                        )
                    );

                const encrypted =
                    await window.crypto.subtle.encrypt(
                        {
                            name:
                                'AES-GCM',
                            iv
                        },
                        cryptoKey,
                        data
                    );

                return {
                    encrypted:
                        new Uint8Array(
                            encrypted
                        ),
                    iv
                };
            },
            []
        );

    const calculateSha256 =
        useCallback(
            async buffer => {
                const digest =
                    await crypto.subtle.digest(
                        'SHA-256',
                        buffer
                    );

                return Array.from(
                    new Uint8Array(
                        digest
                    )
                )
                    .map(
                        byte =>
                            byte
                                .toString(
                                    16
                                )
                                .padStart(
                                    2,
                                    '0'
                                )
                    )
                    .join(
                        ''
                    );
            },
            []
        );

    const calculateMerkleRoot =
        useCallback(
            async files => {
                if (
                    !files ||
                    files.length ===
                        0
                ) {
                    return ethers.ZeroHash;
                }

                let level =
                    [];

                for (
                    const file of
                    files
                ) {
                    const encoded =
                        ethers.solidityPacked(
                            [
                                'string',
                                'bytes32',
                                'uint256'
                            ],
                            [
                                file.path,
                                `0x${file.hash}`,
                                BigInt(
                                    file.size
                                )
                            ]
                        );

                    level.push(
                        ethers.keccak256(
                            encoded
                        )
                    );
                }

                while (
                    level.length >
                    1
                ) {
                    const next =
                        [];

                    for (
                        let i = 0;
                        i < level.length;
                        i += 2
                    ) {
                        const left =
                            level[i];

                        const right =
                            level[i + 1] ||
                            left;

                        const ordered =
                            left.toLowerCase() <
                            right.toLowerCase()
                                ? [
                                      left,
                                      right
                                  ]
                                : [
                                      right,
                                      left
                                  ];

                        next.push(
                            ethers.keccak256(
                                ethers.concat(
                                    ordered
                                )
                            )
                        );
                    }

                    level =
                        next;
                }

                return level[0];
            },
            []
        );

    const loadManifest =
        useCallback(
            async (
                manifestId
            ) => {
                if (
                    !config?.arweaveGateway
                ) {
                    throw new Error(
                        t(
                            'manifest-load-failed'
                        )
                    );
                }

                if (
                    !isValidManifestId(
                        manifestId
                    )
                ) {
                    throw new Error(
                        t(
                            'invalid-manifest'
                        )
                    );
                }

                const url =
                    getValidatedManifestUrl(
                        config.arweaveGateway,
                        manifestId
                    );

                const response =
                    await fetch(
                        url,
                        {
                            cache:
                                'no-store'
                        }
                    );

                if (
                    !response.ok
                ) {
                    throw new Error(
                        t(
                            'manifest-load-failed'
                        )
                    );
                }

                const manifest =
                    await response.json();

                validateManifestData(
                    manifest
                );

                return manifest;
            },
            [
                config,
                t
            ]
        );

    const validateManifestData =
        useCallback(
            manifest => {
                if (
                    !manifest ||
                    typeof manifest !==
                        'object'
                ) {
                    throw new Error(
                        t(
                            'invalid-manifest'
                        )
                    );
                }

                if (
                    !manifest.archive ||
                    typeof manifest.archive.id !==
                        'string' ||
                    !isValidManifestId(
                        manifest.archive.id
                    )
                ) {
                    throw new Error(
                        t(
                            'invalid-manifest'
                        )
                    );
                }

                return true;
            },
            [
                t
            ]
        );

    const showMasterKeyModal =
        useCallback(
            key => {
                return new Promise(
                    resolve => {
                        const overlay =
                            document.createElement(
                                'div'
                            );

                        overlay.style.position =
                            'fixed';
                        overlay.style.inset =
                            '0';
                        overlay.style.background =
                            'rgba(0,0,0,0.8)';
                        overlay.style.display =
                            'flex';
                        overlay.style.alignItems =
                            'center';
                        overlay.style.justifyContent =
                            'center';
                        overlay.style.zIndex =
                            '9999';
                        overlay.style.padding =
                            '20px';

                        const modal =
                            document.createElement(
                                'div'
                            );

                        modal.style.background =
                            '#111820';
                        modal.style.border =
                            '1px solid rgba(255,255,255,0.12)';
                        modal.style.borderRadius =
                            '16px';
                        modal.style.padding =
                            '28px';
                        modal.style.maxWidth =
                            '620px';
                        modal.style.width =
                            '100%';
                        modal.style.color =
                            '#fff';

                        const title =
                            document.createElement(
                                'h2'
                            );

                        title.textContent =
                            t(
                                'key-title'
                            );

                        title.style.marginBottom =
                            '12px';

                        const description =
                            document.createElement(
                                'p'
                            );

                        description.textContent =
                            t(
                                'key-description'
                            );

                        description.style.marginBottom =
                            '16px';

                        const textarea =
                            document.createElement(
                                'textarea'
                            );

                        textarea.value =
                            key;

                        textarea.readOnly =
                            true;

                        textarea.style.width =
                            '100%';

                        textarea.style.minHeight =
                            '110px';

                        textarea.style.padding =
                            '12px';

                        textarea.style.background =
                            '#0a0e14';

                        textarea.style.color =
                            '#fff';

                        textarea.style.border =
                            '1px solid rgba(255,255,255,0.12)';

                        textarea.style.borderRadius =
                            '8px';

                        textarea.style.fontFamily =
                            'monospace';

                        textarea.style.fontSize =
                            '13px';

                        const buttonRow =
                            document.createElement(
                                'div'
                            );

                        buttonRow.style.display =
                            'flex';

                        buttonRow.style.flexWrap =
                            'wrap';

                        buttonRow.style.gap =
                            '10px';

                        buttonRow.style.marginTop =
                            '16px';

                        const copyButton =
                            document.createElement(
                                'button'
                            );

                        copyButton.textContent =
                            t(
                                'copy-key'
                            );

                        copyButton.className =
                            'sign-button';

                        copyButton.onclick =
                            async () => {
                                try {
                                    await navigator.clipboard.writeText(
                                        key
                                    );

                                    copyButton.textContent =
                                        t(
                                            'success'
                                        );
                                } catch {
                                    // Clipboard var nebūt pieejams.
                                }
                            };

                        const downloadButton =
                            document.createElement(
                                'button'
                            );

                        downloadButton.textContent =
                            t(
                                'download-key'
                            );

                        downloadButton.className =
                            'sign-button';

                        downloadButton.onclick =
                            () => {
                                const blob =
                                    new Blob(
                                        [
                                            key
                                        ],
                                        {
                                            type:
                                                'text/plain;charset=utf-8'
                                        }
                                    );

                                const url =
                                    URL.createObjectURL(
                                        blob
                                    );

                                const anchor =
                                    document.createElement(
                                        'a'
                                    );

                                anchor.href =
                                    url;

                                anchor.download =
                                    `permrepo-master-key-${
                                        repoName?.replace(
                                            /[^\w.-]/g,
                                            '_'
                                        ) ||
                                        'backup'
                                    }.txt`;

                                document.body.appendChild(
                                    anchor
                                );

                                anchor.click();

                                anchor.remove();

                                URL.revokeObjectURL(
                                    url
                                );
                            };

                        const closeButton =
                            document.createElement(
                                'button'
                            );

                        closeButton.textContent =
                            t(
                                'saving-key'
                            );

                        closeButton.className =
                            'sign-button';

                        closeButton.onclick =
                            () => {
                                modal.remove();

                                resolve(
                                    true
                                );
                            };

                        buttonRow.appendChild(
                            copyButton
                        );

                        buttonRow.appendChild(
                            downloadButton
                        );

                        buttonRow.appendChild(
                            closeButton
                        );

                        modal.appendChild(
                            title
                        );

                        modal.appendChild(
                            description
                        );

                        modal.appendChild(
                            textarea
                        );

                        modal.appendChild(
                            buttonRow
                        );

                        overlay.appendChild(
                            modal
                        );

                        document.body.appendChild(
                            overlay
                        );
                    }
                );
            },
            [
                t,
                repoName
            ]
        );

    const renderStatusFromData =
        useCallback(
            () => {
                if (
                    !lastStatusData
                ) {
                    return;
                }

                const data =
                    lastStatusData;

                switch (
                    data.type
                ) {
                    case 'uploading':
                        setStatus(
                            t(
                                'uploading'
                            )
                        );
                        break;

                    case 'success':
                        setStatus(
                            t(
                                data.key
                            )
                        );
                        break;

                    case 'simple':
                        setStatus(
                            t(
                                data.key
                            )
                        );
                        break;

                    case 'queue': {
                        const position =
                            Number(
                                data.queuePosition ||
                                0
                            );

                        if (
                            position >
                            0
                        ) {
                            setStatus(
                                `${t(
                                    'backup-queued'
                                )} ${position}. ${t(
                                    'backup-queue-position'
                                )}.`
                            );
                        } else {
                            setStatus(
                                t(
                                    'backup-queued'
                                )
                            );
                        }

                        break;
                    }

                    default:
                        setStatus(
                            t(
                                data.key
                            )
                        );
                }
            },
            [
                lastStatusData,
                t
            ]
        );

    useEffect(
        () => {
            if (
                lastStatusData
            ) {
                renderStatusFromData();
            }
        },
        [
            currentLanguage,
            lastStatusData,
            renderStatusFromData
        ]
    );

    useEffect(
        () => {
            let cancelled =
                false;

            const initPage =
                async () => {
                    try {
                        const configData =
                            await apiJson(
                                '/api/config'
                            );

                        if (
                            cancelled
                        ) {
                            return;
                        }

                        setConfig(
                            configData
                        );

                        if (
                            !repoName ||
                            !/^[a-zA-Z0-9_.-]{1,100}$/.test(
                                repoName
                            )
                        ) {
                            setError(
                                t(
                                    'invalid-repo'
                                )
                            );

                            setFileInfo({
                                count:
                                    0,
                                sizeText:
                                    '',
                                loading:
                                    false
                            });

                            return;
                        }

                        const userData =
                            await apiJson(
                                '/api/github/user'
                            );

                        if (
                            !userData.success
                        ) {
                            window.location.href =
                                '/api/github/login';

                            return;
                        }

                        setGithubUser(
                            userData.user
                        );

                        if (
                            !window.ethereum
                        ) {
                            setError(
                                t(
                                    'connect-wallet'
                                )
                            );

                            setFileInfo({
                                count:
                                    0,
                                sizeText:
                                    '',
                                loading:
                                    false
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

                        if (
                            !accounts[0]
                        ) {
                            setError(
                                t(
                                    'connect-wallet'
                                )
                            );

                            setFileInfo({
                                count:
                                    0,
                                sizeText:
                                    '',
                                loading:
                                    false
                            });

                            return;
                        }

                        const currentAddress =
                            ethers.getAddress(
                                accounts[0]
                            );

                        setUserAddress(
                            currentAddress
                        );

                        const currentChainId =
                            await window.ethereum.request(
                                {
                                    method:
                                        'eth_chainId'
                                }
                            );

                        if (
                            Number.parseInt(
                                currentChainId,
                                16
                            ) !==
                            Number(
                                configData.chainId
                            )
                        ) {
                            try {
                                await window.ethereum.request(
                                    {
                                        method:
                                            'wallet_switchEthereumChain',
                                        params: [
                                            {
                                                chainId:
                                                    configData.chainId
                                            }
                                        ]
                                    }
                                );
                            } catch (
                                switchError
                            ) {
                                if (
                                    switchError.code ===
                                    4902
                                ) {
                                    await window.ethereum.request(
                                        {
                                            method:
                                                'wallet_addEthereumChain',
                                            params: [
                                                {
                                                    chainId:
                                                        configData.chainId,
                                                    chainName:
                                                        'Base',
                                                    rpcUrls: [
                                                        configData.rpcUrl
                                                    ],
                                                    nativeCurrency:
                                                        {
                                                            name:
                                                                'ETH',
                                                            symbol:
                                                                'ETH',
                                                            decimals:
                                                                18
                                                        }
                                                }
                                            ]
                                        }
                                    );
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
                         * /api/prepare-backup atgriež NDJSON streamu.
                         *
                         * Ja serverim pašlaik nav pietiekami daudz RAM
                         * rezervācijas, NDJSON streamā vispirms tiek
                         * nosūtīts "queued" ieraksts un browseris
                         * paliek gaidīt konkrētā request streamā.
                         */
                        const result =
                            await apiNdjson(
                                '/api/prepare-backup',
                                {
                                    method:
                                        'POST',
                                    headers: {
                                        'Content-Type':
                                            'application/json'
                                    },
                                    body:
                                        JSON.stringify(
                                            {
                                                repoName,
                                                walletAddress:
                                                    currentAddress
                                            }
                                        )
                                },
                                record => {
                                    if (
                                        cancelled
                                    ) {
                                        return;
                                    }

                                    if (
                                        record.type ===
                                        'queued'
                                    ) {
                                        setLastStatusData(
                                            {
                                                type:
                                                    'queue',
                                                queuePosition:
                                                    Number(
                                                        record.queuePosition ||
                                                        0
                                                    )
                                            }
                                        );
                                    } else if (
                                        record.type ===
                                        'started'
                                    ) {
                                        setLastStatusData(
                                            {
                                                type:
                                                    'simple',
                                                key:
                                                    'preparing'
                                            }
                                        );
                                    }
                                }
                            );

                        if (
                            cancelled
                        ) {
                            return;
                        }

                        setNftInfo({
                            tokenId:
                                result.tokenId,
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

                        let previousPaths =
                            {};

                        let previousHistory =
                            [];

                        let previousEncryptionIVs =
                            {};

                        if (
                            result.lastManifest &&
                            result.lastManifest.startsWith(
                                'ar://'
                            )
                        ) {
                            const prevManifestId =
                                result.lastManifest.slice(
                                    5
                                );

                            if (
                                !isValidManifestId(
                                    prevManifestId
                                )
                            ) {
                                throw new Error(
                                    t(
                                        'invalid-manifest'
                                    )
                                );
                            }

                            setCurrentPreviousManifestId(
                                prevManifestId
                            );

                            const previousManifest =
                                await loadManifest(
                                    prevManifestId
                                );

                            previousPaths =
                                previousManifest.files ||
                                {};

                            previousHistory =
                                previousManifest.history ||
                                [];

                            previousEncryptionIVs =
                                previousManifest.encryptionIVs ||
                                {};
                        }

                        setCurrentPreviousHistory(
                            previousHistory
                        );

                        setCurrentPreviousEncryptionIVs(
                            previousEncryptionIVs
                        );

                        const changedFiles =
                            [];

                        const unchangedFiles =
                            {};

                        for (
                            const file of
                            result.files
                        ) {
                            const previous =
                                previousPaths[
                                    file.path
                                ];

                            if (
                                previous &&
                                previous.hash ===
                                    file.hash
                            ) {
                                unchangedFiles[
                                    file.path
                                ] = {
                                    ...previous
                                };
                            } else {
                                changedFiles.push(
                                    file
                                );
                            }
                        }

                        setCurrentUnchangedFiles(
                            unchangedFiles
                        );

                        setFileInfo({
                            count:
                                changedFiles.length,
                            sizeText:
                                formatFileSize(
                                    changedFiles.reduce(
                                        (
                                            sum,
                                            file
                                        ) =>
                                            sum +
                                            Number(
                                                file.size
                                            ),
                                        0
                                    )
                                ),
                            loading:
                                false
                        });

                        setChangedFilesForUpload(
                            changedFiles
                        );

                        setUnchangedFilesForUpload(
                            unchangedFiles
                        );
                    } catch (
                        e
                    ) {
                        if (
                            cancelled
                        ) {
                            return;
                        }

                        setError(
                            getSafeErrorMessage(
                                e
                            )
                        );

                        setFileInfo({
                            count:
                                0,
                            sizeText:
                                '',
                            loading:
                                false
                        });
                    }
                };

            initPage();

            return () => {
                cancelled =
                    true;
            };
        },
        [
            apiJson,
            apiNdjson,
            repoName,
            t,
            formatFileSize,
            loadManifest
        ]
    );

    const continueBackup =
        useCallback(
            async () => {
                if (
                    !config
                ) {
                    setError(
                        'Konfigurācija vēl nav ielādēta!'
                    );

                    return;
                }

                if (
                    !window.ethereum ||
                    !userAddress
                ) {
                    setError(
                        t(
                            'connect-wallet'
                        )
                    );

                    return;
                }

                if (
                    changedFilesForUpload.length ===
                    0
                ) {
                    setStatus(
                        t(
                            'no-changes'
                        )
                    );

                    setLastStatusData(
                        {
                            type:
                                'simple',
                            key:
                                'no-changes'
                        }
                    );

                    return;
                }

                try {
                    setIsWorking(
                        true
                    );

                    setError(
                        ''
                    );

                    const currentChainId =
                        await window.ethereum.request(
                            {
                                method:
                                    'eth_chainId'
                            }
                        );

                    if (
                        Number.parseInt(
                            currentChainId,
                            16
                        ) !==
                        Number(
                            config.chainId
                        )
                    ) {
                        try {
                            await window.ethereum.request(
                                {
                                    method:
                                        'wallet_switchEthereumChain',
                                    params: [
                                        {
                                            chainId:
                                                config.chainId
                                        }
                                    ]
                                }
                            );
                        } catch (
                            switchError
                        ) {
                            if (
                                switchError.code ===
                                4902
                            ) {
                                await window.ethereum.request(
                                    {
                                        method:
                                            'wallet_addEthereumChain',
                                        params: [
                                            {
                                                chainId:
                                                    config.chainId,
                                                chainName:
                                                    'Base',
                                                rpcUrls: [
                                                    config.rpcUrl
                                                ],
                                                nativeCurrency:
                                                    {
                                                        name:
                                                            'ETH',
                                                        symbol:
                                                            'ETH',
                                                        decimals:
                                                            18
                                                    }
                                            }
                                        ]
                                    }
                                );
                            } else {
                                throw switchError;
                            }
                        }
                    }

                    let masterKey =
                        masterKeyRef.current;

                    if (
                        !masterKey
                    ) {
                        masterKey =
                            localStorage.getItem(
                                `permrepo-master-key-${repoName}`
                            );
                    }

                    if (
                        !masterKey
                    ) {
                        masterKey =
                            await generateMasterKey();

                        await showMasterKeyModal(
                            masterKey
                        );
                    }

                    masterKeyRef.current =
                        masterKey;

                    setStatus(
                        t(
                            'creating-zip'
                        )
                    );

                    setLastStatusData(
                        {
                            type:
                                'simple',
                            key:
                                'creating-zip'
                        }
                    );

                    const zip =
                        new JSZip();

                    for (
                        const file of
                        changedFilesForUpload
                    ) {
                        if (
                            !file ||
                            typeof file.path !==
                                'string' ||
                            typeof file.content !==
                                'string'
                        ) {
                            throw new Error(
                                t(
                                    'invalid-file-data'
                                )
                            );
                        }

                        const binary =
                            Uint8Array.from(
                                atob(
                                    file.content
                                ),
                                char =>
                                    char.charCodeAt(
                                        0
                                    )
                            );

                        zip.file(
                            file.path,
                            binary
                        );
                    }

                    const zipBuffer =
                        await zip.generateAsync(
                            {
                                type:
                                    'arraybuffer',
                                compression:
                                    'DEFLATE',
                                compressionOptions:
                                    {
                                        level:
                                            6
                                    }
                            }
                        );

                    setStatus(
                        t(
                            'encrypting'
                        )
                    );

                    setLastStatusData(
                        {
                            type:
                                'simple',
                            key:
                                'encrypting'
                        }
                    );

                    const encrypted =
                        await encryptData(
                            zipBuffer,
                            masterKey
                        );

                    const encryptedBytes =
                        encrypted.encrypted;

                    const iv =
                        encrypted.iv;

                    setCurrentIV(
                        Array.from(
                            iv
                        )
                            .map(
                                byte =>
                                    byte
                                        .toString(
                                            16
                                        )
                                        .padStart(
                                            2,
                                            '0'
                                        )
                            )
                            .join(
                                ''
                            )
                    );

                    const merkleRoot =
                        await calculateMerkleRoot(
                            changedFilesForUpload
                        );

                    setCurrentMerkleRoot(
                        merkleRoot
                    );

                    const provider =
                        new ethers.BrowserProvider(
                            window.ethereum
                        );

                    const signer =
                        await provider.getSigner();

                    const injectedSigner =
                        new InjectedEthereumSigner(
                            window.ethereum
                        );

                    const turbo =
                        TurboFactory.authenticated(
                            {
                                token:
                                    'base-eth',
                                signer:
                                    injectedSigner
                            }
                        );

                    const uploadCost =
                        await turbo.getUploadCosts({
                            bytes:
                                encryptedBytes.length
                        });

                    const fileCostEth =
                        ethers.formatEther(
                            uploadCost.winc
                        );

                    const treasury =
                        config.treasuryAddress;

                    const tx =
                        await signer.sendTransaction(
                            {
                                to:
                                    treasury,
                                value:
                                    uploadCost.winc
                            }
                        );

                    await tx.wait();

                    uploadedZipRef.current = {
                        txId:
                            null,
                        iv:
                            Array.from(
                                iv
                            )
                                .map(
                                    byte =>
                                        byte
                                            .toString(
                                                16
                                            )
                                            .padStart(
                                                2,
                                                '0'
                                            )
                                )
                                .join(
                                    ''
                                ),
                        merkleRoot
                    };

                    setStatus(
                        t(
                            'uploading'
                        )
                    );

                    setLastStatusData(
                        {
                            type:
                                'uploading'
                        }
                    );

                    const uploadResult =
                        await turbo.uploadFile({
                            fileStreamFactory:
                                () =>
                                    ReadableStream.from(
                                        [
                                            encryptedBytes
                                        ]
                                    ),
                            dataItemOpts:
                                {
                                    tags: [
                                        {
                                            name:
                                                'Content-Type',
                                            value:
                                                'application/octet-stream'
                                        }
                                    ]
                                }
                        });

                    const zipTxId =
                        uploadResult.id;

                    uploadedZipRef.current.txId =
                        zipTxId;

                    await apiJson(
                        '/api/save-zip-tx',
                        {
                            method:
                                'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId:
                                        preparedJobId,
                                    zipTxId
                                })
                        }
                    );

                    const fileMetadata =
                        changedFilesForUpload.map(
                            file => ({
                                path:
                                    file.path,
                                hash:
                                    file.hash,
                                size:
                                    file.size
                            })
                        );

                    const manifestFiles = {
                        ...unchangedFilesForUpload
                    };

                    for (
                        const file of
                        changedFilesForUpload
                    ) {
                        manifestFiles[
                            file.path
                        ] = {
                            hash:
                                file.hash,
                            size:
                                file.size,
                            backupNumber:
                                Number(
                                    nftInfo.backupCount ||
                                    0
                                ) +
                                1
                        };
                    }

                    const manifest = {
                        version:
                            1,
                        repository:
                            `${githubUser.login}/${repoName}`,
                        backupNumber:
                            Number(
                                nftInfo.backupCount ||
                                0
                            ) +
                            1,
                        archive: {
                            id:
                                zipTxId
                        },
                        encryption: {
                            algorithm:
                                'AES-256-GCM',
                            iv:
                                Array.from(
                                    iv
                                )
                                    .map(
                                        byte =>
                                            byte
                                                .toString(
                                                    16
                                                )
                                                .padStart(
                                                    2,
                                                    '0'
                                                )
                                    )
                                    .join(
                                        ''
                                    )
                        },
                        merkleRoot,
                        files:
                            manifestFiles,
                        changedFiles:
                            fileMetadata,
                        history:
                            currentPreviousHistory,
                        encryptionIVs: {
                            ...currentPreviousEncryptionIVs,
                            [String(
                                Number(
                                    nftInfo.backupCount ||
                                    0
                                ) +
                                    1
                            )]:
                                Array.from(
                                    iv
                                )
                                    .map(
                                        byte =>
                                            byte
                                                .toString(
                                                    16
                                                )
                                                .padStart(
                                                    2,
                                                    '0'
                                                )
                                    )
                                    .join(
                                        ''
                                    )
                        }
                    };

                    setStatus(
                        t(
                            'manifest-ready'
                        )
                    );

                    const manifestJson =
                        JSON.stringify(
                            manifest
                        );

                    const manifestBytes =
                        new TextEncoder().encode(
                            manifestJson
                        );

                    const manifestCost =
                        await turbo.getUploadCosts({
                            bytes:
                                manifestBytes.length
                        });

                    const manifestTx =
                        await signer.sendTransaction(
                            {
                                to:
                                    treasury,
                                value:
                                    manifestCost.winc
                            }
                        );

                    await manifestTx.wait();

                    const manifestUpload =
                        await turbo.uploadFile({
                            fileStreamFactory:
                                () =>
                                    ReadableStream.from(
                                        [
                                            manifestBytes
                                        ]
                                    ),
                            dataItemOpts:
                                {
                                    tags: [
                                        {
                                            name:
                                                'Content-Type',
                                            value:
                                                'application/json'
                                        }
                                    ]
                                }
                        });

                    const manifestTxId =
                        manifestUpload.id;

                    uploadedManifestRef.current = {
                        txId:
                            manifestTxId,
                        manifest
                    };

                    await apiJson(
                        '/api/save-manifest-tx',
                        {
                            method:
                                'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    jobId:
                                        preparedJobId,
                                    manifestTxId,
                                    manifest
                                })
                        }
                    );

                    const signerAddress =
                        await signer.getAddress();

                    const nftContract =
                        new ethers.Contract(
                            config.nftAddress,
                            NFT_ABI,
                            signer
                        );

                    const nonce =
                        await nftContract.getNonce(
                            nftInfo.tokenId
                        );

                    const deadline =
                        Math.floor(
                            Date.now() /
                                1000
                        ) +
                        15 *
                            60;

                    const domain = {
                        name:
                            'PermRepoNFT',
                        version:
                            '1',
                        chainId:
                            Number(
                                config.chainId
                            ),
                        verifyingContract:
                            config.nftAddress
                    };

                    const types = {
                        Backup: [
                            {
                                name:
                                    'tokenId',
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
                                    'manifestURI',
                                type:
                                    'string'
                            },
                            {
                                name:
                                    'nonce',
                                type:
                                    'uint256'
                            },
                            {
                                name:
                                    'deadline',
                                type:
                                    'uint256'
                            }
                        ]
                    };

                    const manifestHash =
                        ethers.keccak256(
                            ethers.toUtf8Bytes(
                                manifestJson
                            )
                        );

                    const value = {
                        tokenId:
                            nftInfo.tokenId,
                        manifestHash,
                        merkleRoot,
                        manifestURI:
                            `ar://${manifestTxId}`,
                        nonce,
                        deadline
                    };

                    const signature =
                        await signer.signTypedData(
                            domain,
                            types,
                            value
                        );

                    const backupTx =
                        await nftContract.addBackup(
                            nftInfo.tokenId,
                            manifestHash,
                            merkleRoot,
                            `ar://${manifestTxId}`,
                            deadline,
                            signature
                        );

                    await backupTx.wait();

                    setLastManifestTxId(
                        manifestTxId
                    );

                    setBackupCompleted(
                        true
                    );

                    setStatus(
                        t(
                            'backup-complete'
                        )
                    );

                    setLastStatusData(
                        {
                            type:
                                'success',
                            key:
                                'backup-complete'
                        }
                    );
                } catch (
                    e
                ) {
                    const message =
                        getSafeErrorMessage(
                            e
                        );

                    setError(
                        message
                    );

                    if (
                        /user rejected|user denied|rejected|denied/i.test(
                            message
                        )
                    ) {
                        setStatus(
                            t(
                                'transaction-cancelled'
                            )
                        );

                        setLastStatusData(
                            {
                                type:
                                    'simple',
                                key:
                                    'transaction-cancelled'
                            }
                        );
                    }
                } finally {
                    setIsWorking(
                        false
                    );
                }
            },
            [
                config,
                userAddress,
                t,
                changedFilesForUpload,
                generateMasterKey,
                showMasterKeyModal,
                encryptData,
                calculateMerkleRoot,
                repoName,
                githubUser,
                unchangedFilesForUpload,
                nftInfo,
                currentPreviousHistory,
                currentPreviousEncryptionIVs,
                preparedJobId,
                apiJson
            ]
        );

    if (
        !config
    ) {
        return (
            <div className="container">
                <div
                    style={{
                        textAlign:
                            'center',
                        padding:
                            '20px'
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
                        currentLanguage ===
                        'lv'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage(
                            'lv'
                        )
                    }
                >
                    LV
                </button>

                <button
                    className={`lang-btn ${
                        currentLanguage ===
                        'en'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage(
                            'en'
                        )
                    }
                >
                    EN
                </button>

                <button
                    className={`lang-btn ${
                        currentLanguage ===
                        'eo'
                            ? 'active'
                            : ''
                    }`}
                    onClick={() =>
                        switchLanguage(
                            'eo'
                        )
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
                {t(
                    'repo-label'
                )}
                :{' '}
                {repoName ||
                    '-'}
            </p>

            <div className="info-row text-left">
                <span className="info-label">
                    {t(
                        'nft-token'
                    )}
                </span>

                <span className="info-value">
                    {nftInfo.tokenId ||
                        '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t(
                        'backup-count'
                    )}
                </span>

                <span className="info-value">
                    {nftInfo.backupCount ||
                        '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t(
                        'last-manifest'
                    )}
                </span>

                <span className="info-value">
                    {nftInfo.lastManifest ||
                        '-'}
                </span>
            </div>

            <div className="info-row text-left">
                <span className="info-label">
                    {t(
                        'last-merkle'
                    )}
                </span>

                <span className="info-value">
                    {nftInfo.lastMerkleRoot ||
                        '-'}
                </span>
            </div>

            {fileInfo.loading ? (
                <div
                    style={{
                        textAlign:
                            'center',
                        padding:
                            '20px'
                    }}
                >
                    <div className="spinner"></div>
                </div>
            ) : (
                <>
                    <div
                        style={{
                            padding:
                                '8px 0',
                            borderBottom:
                                '1px solid rgba(255,255,255,0.08)'
                        }}
                    >
                        <Icon name="fails" />
                        {' '}
                        {t(
                            'files-count'
                        )}
                        :{' '}
                        <strong>
                            {
                                fileInfo.count
                            }
                        </strong>
                    </div>

                    <div
                        style={{
                            padding:
                                '8px 0',
                            borderBottom:
                                '1px solid rgba(255,255,255,0.08)'
                        }}
                    >
                        <Icon name="fails" />
                        {' '}
                        {t(
                            'files-size'
                        )}
                        :{' '}
                        <strong>
                            {
                                fileInfo.sizeText
                            }
                        </strong>
                    </div>
                </>
            )}

            {!backupCompleted ? (
                <button
                    onClick={
                        continueBackup
                    }
                    disabled={
                        isWorking ||
                        fileInfo.loading ||
                        fileInfo.count ===
                            0
                    }
                    className="sign-button"
                    style={{
                        marginTop:
                            '20px'
                    }}
                >
                    {isWorking ? (
                        <div
                            style={{
                                textAlign:
                                    'center'
                            }}
                        >
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        t(
                            'continue-backup'
                        )
                    )}
                </button>
            ) : (
                <button
                    onClick={() =>
                        navigate(
                            '/'
                        )
                    }
                    className="sign-button"
                    style={{
                        marginTop:
                            '20px'
                    }}
                >
                    {t(
                        'back-home'
                    )}
                </button>
            )}

            {status && (
                <div
                    className="status-card"
                    style={{
                        display:
                            'block'
                    }}
                >
                    <div
                        style={{
                            whiteSpace:
                                'pre-wrap'
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
                                    marginTop:
                                        '12px'
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
