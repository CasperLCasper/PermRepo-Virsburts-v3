import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from './LanguageContext';

const NFT_ABI = [
    "function mintRepository(address recipient, string calldata repository, string calldata uri) external returns (uint256)",
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(bytes32 githubHash) external view returns (bool)",
    "function subscribe(bytes32 githubHash) external",
    "function subscriptionPrice() external view returns (uint256)",
    "function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)",
    "function getRemainingTime(bytes32 githubHash) external view returns (uint256)"
];

const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)"
];

function icon(name) {
    return `<img src="/icons/${name}.svg" class="icon-inline" alt="${name}">`;
}

function App() {
    const navigate = useNavigate();
    const { currentLanguage, t, switchLanguage } = useLanguage();
    const [config, setConfig] = useState(null);
    const [userAddress, setUserAddress] = useState(null);
    const [signer, setSigner] = useState(null);
    const [githubUser, setGithubUser] = useState(null);
    const [reposData, setReposData] = useState([]);
    const [selectedRepoName, setSelectedRepoName] = useState(null);
    const [subscriptionStatus, setSubscriptionStatus] = useState(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [status, setStatus] = useState('');
    const [statusType, setStatusType] = useState('success');
    const [error, setError] = useState('');
    const [lastStatusData, setLastStatusData] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    const apiJson = useCallback(async (url, options = {}) => {
        const response = await fetch(url, { credentials: 'same-origin', ...options });
        let result;
        try { result = await response.json(); } catch { throw new Error(`Servera kļūda: HTTP ${response.status}`); }
        if (!response.ok && !result.success) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    }, []);

    const checkSubscription = useCallback(async () => {
        try {
            const data = await apiJson('/api/subscription/status');
            if (data.success) {
                setSubscriptionStatus(data);
            }
        } catch (e) {
            console.error('Abonementa pārbaudes kļūda:', e);
        }
    }, [apiJson]);

    const purchaseSubscription = useCallback(async () => {
        try {
            setIsLoading(true);
            setStatus('Apstiprina USDC atļauju...');
            setStatusType('progress');
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const providerSigner = await provider.getSigner();
            
            const subscriptionContract = new ethers.Contract(config.subscriptionAddress, SUBSCRIPTION_ABI, provider);
            const price = await subscriptionContract.subscriptionPrice();
            
            const usdcContract = new ethers.Contract(config.usdcAddress, USDC_ABI, providerSigner);
            const approveTx = await usdcContract.approve(config.subscriptionAddress, price);
            await approveTx.wait();
            
            setStatus('Iegādājas abonementu...');
            
            const githubHash = ethers.keccak256(ethers.toUtf8Bytes(githubUser));
            const subscribeTx = await subscriptionContract.connect(providerSigner).subscribe(githubHash);
            await subscribeTx.wait();
            
            setStatus(`${icon('izdevas-veiksmigi')} Abonements iegādāts!`);
            setStatusType('success');
            setLastStatusData({ type: 'subscription-purchased' });
            await checkSubscription();
            setIsLoading(false);
        } catch (e) {
            setIsLoading(false);
            if (e.code === 'ACTION_REJECTED') {
                setError('Transakcija atcelta');
            } else {
                setError(e.message);
            }
        }
    }, [config, githubUser, checkSubscription]);

    const connectWallet = useCallback(async () => {
        if (!window.ethereum) {
            setError('Lūdzu instalē maku!');
            return;
        }
        
        try {
            setIsLoading(true);
            setStatus('');
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
            
            const data = await apiJson('/api/github/repos');
            if (!data.success || data.repos.length === 0) {
                setError('Nav atrasts neviens repozitorijs');
                setIsLoading(false);
                return;
            }
            
            const nftContract = new ethers.Contract(config.nftAddress, NFT_ABI, provider);
            
            const reposWithStatus = [];
            for (const repo of data.repos) {
                const fullRepoName = `${githubUser}/${repo.name}`;
                const repoHash = ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName])
                );
                const tokenId = await nftContract.repositoryTokens(repoHash);
                reposWithStatus.push({ ...repo, hasNFT: tokenId !== 0n });
            }
            
            setReposData(reposWithStatus);
            setWalletConnected(true);
            
            setStatus(`${icon('izdevas-veiksmigi')} ${t('wallet-connected')}: ${address}`);
            setStatusType('success');
            setLastStatusData({ type: 'wallet-connected', address: address });
            setIsLoading(false);
            
        } catch (e) {
            setIsLoading(false);
            setError(e.message);
        }
    }, [config, apiJson, githubUser, t]);

    const mintNFT = useCallback(async (repoName) => {
        try {
            setIsLoading(true);
            setStatus('Izveido NFT...');
            setStatusType('progress');
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const nftSigner = await provider.getSigner();
            const nftWrite = new ethers.Contract(config.nftAddress, NFT_ABI, nftSigner);
            
            const fullRepoName = `${githubUser}/${repoName}`;
            const nftImageURI = 'ar://placeholder';
            
            const tx = await nftWrite.mintRepository(userAddress, fullRepoName, nftImageURI);
            await tx.wait();
            
            setStatus(`${icon('izdevas-veiksmigi')} NFT izveidots!`);
            setStatusType('success');
            setLastStatusData({ type: 'nft-minted' });
            await connectWallet();
            setIsLoading(false);
        } catch (e) {
            setIsLoading(false);
            if (e.code === 'ACTION_REJECTED') {
                setError('Transakcija atcelta');
            } else {
                setError(e.message);
            }
        }
    }, [config, githubUser, userAddress, connectWallet]);

    useEffect(() => {
        if (lastStatusData && lastStatusData.type === 'wallet-connected' && walletConnected) {
            setStatus(`${icon('izdevas-veiksmigi')} ${t('wallet-connected')}: ${lastStatusData.address}`);
            setStatusType('success');
        }
    }, [currentLanguage, lastStatusData, walletConnected, t]);

    useEffect(() => {
        const initApp = async () => {
            try {
                const configData = await apiJson('/api/config');
                setConfig(configData);
            } catch (e) {
                setError('Neizdevās iegūt konfigurāciju');
                return;
            }
            
            try {
                const userData = await apiJson('/api/github/user');
                if (userData.success) {
                    setGithubUser(userData.user);
                    await checkSubscription();
                }
            } catch (e) {
                console.error('Init kļūda:', e);
            }
        };
        
        initApp();
    }, []);

    const selectedRepo = reposData.find(r => r.name === selectedRepoName);

    if (!config) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '20px' }}>
                    <div className="spinner"></div>
                </div>
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
            <p className="subtitle">{t('subtitle')}</p>
            
            {subscriptionStatus && (
                <div style={{ display: 'block', marginBottom: '16px' }}>
                    {isLoading ? (
                        <div style={{ textAlign: 'center', padding: '20px' }}>
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        <button 
                            disabled={subscriptionStatus.isSubscribed}
                            onClick={subscriptionStatus.isSubscribed ? undefined : purchaseSubscription}
                            style={{ 
                                width: '100%', 
                                padding: '12px', 
                                borderRadius: '8px', 
                                fontSize: '14px',
                                cursor: subscriptionStatus.isSubscribed ? 'default' : 'pointer',
                                background: subscriptionStatus.isSubscribed ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)',
                                border: `1px solid ${subscriptionStatus.isSubscribed ? 'rgba(63, 185, 80, 0.3)' : 'rgba(248, 81, 73, 0.3)'}`,
                                color: subscriptionStatus.isSubscribed ? '#3fb950' : '#f85149',
                                marginTop: '0'
                            }}
                        >
                            <span className={`subscription-dot ${subscriptionStatus.isSubscribed ? 'active' : 'expired'}`}></span>
                            {subscriptionStatus.isSubscribed 
                                ? `${t('subscription-active')} (${Math.floor(Number(subscriptionStatus.remainingTime) / 86400)} ${t('days')})` 
                                : t('subscription-expired')}
                        </button>
                    )}
                </div>
            )}
            
            {!githubUser && (
                <div style={{ display: 'block', marginBottom: '16px' }}>
                    <button 
                        onClick={() => window.location.href = '/api/github/login'}
                        className="sign-button"
                        style={{ marginTop: '0' }}
                    >
                        {t('connect-github')}
                    </button>
                </div>
            )}
            
            {githubUser && (
                <div style={{ display: 'block' }}>
                    <div className="info-row text-left">
                        <span className="info-label">{t('user')}</span>
                        <span className="info-value">{githubUser}</span>
                    </div>
                    <button 
                        onClick={async () => {
                            await fetch('/api/github/logout');
                            window.location.href = '/?logout=' + Date.now();
                        }}
                        className="logout-button"
                    >
                        {t('logout')}
                    </button>
                </div>
            )}
            
            {githubUser && !walletConnected && (
                <div style={{ display: 'block', marginTop: '16px' }}>
                    {isLoading ? (
                        <div style={{ textAlign: 'center', padding: '20px' }}>
                            <div className="spinner"></div>
                        </div>
                    ) : (
                        <button 
                            onClick={connectWallet}
                            className="sign-button"
                        >
                            {t('connect-wallet')}
                        </button>
                    )}
                </div>
            )}
            
            {walletConnected && (
                <div style={{ display: 'block' }}>
                    <div className="info-row text-left">
                        <span className="info-label">{t('wallet')}</span>
                        <span className="info-value" style={{ wordBreak: 'break-all' }}>{userAddress}</span>
                    </div>
                </div>
            )}
            
            {walletConnected && reposData.length > 0 && (
                <div style={{ display: 'block', marginTop: '16px' }}>
                    <div className="info-row text-left">
                        <label className="info-label">{t('repository')}</label>
                        <select 
                            className="repo-select"
                            value={selectedRepoName || ''}
                            onChange={(e) => setSelectedRepoName(e.target.value)}
                            aria-label={t('select-repo')}
                        >
                            <option value="">{t('select-repo')}</option>
                            {reposData.map((repo) => (
                                <option key={repo.name} value={repo.name}>
                                    {repo.hasNFT ? '🟢' : '🔴'} {repo.name}{repo.private ? ' 🔒' : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    
                    {selectedRepo && (
                        <div style={{ display: 'block', marginTop: '16px' }}>
                            <div className={`repo-status-display ${selectedRepo.hasNFT ? 'has-nft' : 'no-nft'}`}>
                                <span dangerouslySetInnerHTML={{ __html: icon(selectedRepo.hasNFT ? 'ir-nft' : 'nav-nft') }} />
                                {selectedRepo.hasNFT ? t('nft-linked') : t('no-nft')}
                            </div>
                            
                            {isLoading ? (
                                <div style={{ textAlign: 'center', padding: '20px' }}>
                                    <div className="spinner"></div>
                                </div>
                            ) : selectedRepo.hasNFT ? (
                                <button 
                                    onClick={() => navigate(`/backup?repo=${encodeURIComponent(selectedRepo.name)}`)}
                                    className="sign-button"
                                >
                                    {t('open-backup')}
                                </button>
                            ) : (
                                <button 
                                    onClick={() => mintNFT(selectedRepo.name)}
                                    className="sign-button"
                                >
                                    {t('mint-nft')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            
            {status && (
                <div className="status" style={{ marginTop: '20px', textAlign: 'center', color: statusType === 'success' ? '#3fb950' : '#e6edf3' }} dangerouslySetInnerHTML={{ __html: status }} />
            )}
            
            {error && (
                <div className="error">
                    <span dangerouslySetInnerHTML={{ __html: icon('kluda') }} />
                    {error}
                </div>
            )}
        </div>
    );
}

export default App;
