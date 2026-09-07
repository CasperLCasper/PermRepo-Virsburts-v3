import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useNavigate } from 'react-router-dom';
import { translations } from './translations';

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
    return `/icons/${name}.svg`;
}

function App() {
    const navigate = useNavigate();
    const [config, setConfig] = useState(null);
    const [userAddress, setUserAddress] = useState(null);
    const [signer, setSigner] = useState(null);
    const [githubUser, setGithubUser] = useState(null);
    const [currentLanguage, setCurrentLanguage] = useState(localStorage.getItem('permrepo-language') || 'lv');
    const [reposData, setReposData] = useState([]);
    const [selectedRepoName, setSelectedRepoName] = useState(null);
    const [subscriptionStatus, setSubscriptionStatus] = useState(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

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
            setStatus('Apstiprina USDC atļauju...');
            
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
            
            setStatus('✅ Abonements iegādāts!');
            await checkSubscription();
        } catch (e) {
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
            setStatus('⏳ Savieno maku...');
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
            setWalletConnected(true);
            
            const data = await apiJson('/api/github/repos');
            if (!data.success || data.repos.length === 0) {
                setError('Nav atrasts neviens repozitorijs');
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
            setStatus('✅ Maks savienots: ' + address);
            
        } catch (e) {
            setError(e.message);
        }
    }, [config, apiJson, githubUser]);

    const mintNFT = useCallback(async (repoName) => {
        try {
            setStatus('Izveido NFT...');
            
            const provider = new ethers.BrowserProvider(window.ethereum);
            const nftSigner = await provider.getSigner();
            const nftWrite = new ethers.Contract(config.nftAddress, NFT_ABI, nftSigner);
            
            const fullRepoName = `${githubUser}/${repoName}`;
            const nftImageURI = 'ar://placeholder';
            
            const tx = await nftWrite.mintRepository(userAddress, fullRepoName, nftImageURI);
            await tx.wait();
            
            setStatus('✅ NFT izveidots!');
            await connectWallet();
        } catch (e) {
            if (e.code === 'ACTION_REJECTED') {
                setError('Transakcija atcelta');
            } else {
                setError(e.message);
            }
        }
    }, [config, githubUser, userAddress, connectWallet]);

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
                <p>Ielādē...</p>
            </div>
        );
    }

    return (
        <div className="container">
            <div className="language-selector">
                <button className={`lang-btn ${currentLanguage === 'lv' ? 'active' : ''}`} onClick={() => setCurrentLanguage('lv')}>LV</button>
                <button className={`lang-btn ${currentLanguage === 'en' ? 'active' : ''}`} onClick={() => setCurrentLanguage('en')}>EN</button>
                <button className={`lang-btn ${currentLanguage === 'eo' ? 'active' : ''}`} onClick={() => setCurrentLanguage('eo')}>EO</button>
            </div>
            
            <img src="/icons/logo-nosaukums.svg" alt="PermRepo" className="logo-title" />
            <p className="subtitle">{t('subtitle')}</p>
            
            {subscriptionStatus && (
                <div style={{ display: 'block', marginBottom: '16px' }}>
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
                    <button 
                        onClick={connectWallet}
                        className="sign-button"
                    >
                        🔗 Savienot maku
                    </button>
                </div>
            )}
            
            {walletConnected && (
                <div style={{ display: 'block' }}>
                    <div className="info-row text-left">
                        <span className="info-label">{t('wallet')}</span>
                        <span className="info-value" style={{ wordBreak: 'break-all' }}>{userAddress}</span>
                    </div>
                    <button disabled style={{ marginTop: '12px' }}>
                        <img src={icon('wallet')} className="icon-inline" alt="" style={{ display: 'inline-block', width: '24px', height: '24px', verticalAlign: 'middle', marginRight: '6px' }} />
                        {t('wallet-connected')}
                    </button>
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
                                <img 
                                    src={icon(selectedRepo.hasNFT ? 'ir-nft' : 'nav-nft')} 
                                    className="icon-inline" 
                                    alt="" 
                                    style={{ display: 'inline-block', width: '24px', height: '24px', verticalAlign: 'middle', marginRight: '6px' }}
                                />
                                {selectedRepo.hasNFT ? t('nft-linked') : t('no-nft')}
                            </div>
                            
                            {selectedRepo.hasNFT ? (
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
                <div className="status" style={{ marginTop: '20px', textAlign: 'center', color: '#3fb950' }}>
                    {status}
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

export default App;
