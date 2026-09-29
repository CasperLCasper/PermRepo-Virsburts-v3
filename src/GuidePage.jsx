import React from 'react';
import { useLanguage } from './LanguageContext';
import { useNavigate } from 'react-router-dom';

function GuidePage() {
    const { currentLanguage, t, switchLanguage } = useLanguage();
    const navigate = useNavigate();

    // ✅ PDF pēc valodas
    const pdfUrl = currentLanguage === 'en'
        ? '/docs/User Guide (EN).pdf'
        : '/docs/Lietotāja rokasgrāmata (LV).pdf';

    return (
        <div className="container" style={{ maxWidth: '800px' }}>
            <div className="language-selector">
                <button
                    className={`lang-btn ${currentLanguage === 'lv' ? 'active' : ''}`}
                    onClick={() => switchLanguage('lv')}
                >
                    LV
                </button>
                <button
                    className={`lang-btn ${currentLanguage === 'en' ? 'active' : ''}`}
                    onClick={() => switchLanguage('en')}
                >
                    EN
                </button>
                <button
                    className={`lang-btn ${currentLanguage === 'eo' ? 'active' : ''}`}
                    onClick={() => switchLanguage('eo')}
                >
                    EO
                </button>
            </div>

            <h1 style={{ marginBottom: '20px', textAlign: 'center' }}>
                📖 {t('guide-title')}
            </h1>

            <button
                onClick={() => navigate('/')}
                className="sign-button"
                style={{ marginBottom: '20px' }}
            >
                ← {t('back-home')}
            </button>

            {/* ✅ Vienīgā poga — "Lasīt rokasgrāmatu" */}
            <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="sign-button"
                style={{
                    display: 'block',
                    textAlign: 'center',
                    textDecoration: 'none',
                    padding: '20px',
                    fontSize: '18px',
                    background: 'linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)'
                }}
            >
                📖 {t('read-guide')}
            </a>
        </div>
    );
}

export default GuidePage;
