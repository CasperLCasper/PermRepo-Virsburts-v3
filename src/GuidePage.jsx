import React from 'react';
import { useLanguage } from './LanguageContext';
import { useNavigate } from 'react-router-dom';

function GuidePage() {
    const { currentLanguage, switchLanguage } = useLanguage();
    const navigate = useNavigate();

    // ✅ PDF pēc valodas
    const pdfUrl = currentLanguage === 'en'
        ? '/docs/User Guide (EN).pdf'
        : '/docs/Lietotāja rokasgrāmata (LV).pdf';

    const title = currentLanguage === 'lv'
        ? 'Lietotāja rokasgrāmata'
        : currentLanguage === 'en'
            ? 'User Guide'
            : 'Uzanta Gvidilo';

    const backText = currentLanguage === 'lv'
        ? 'Atpakaļ'
        : currentLanguage === 'en'
            ? 'Back'
            : 'Reen';

    const openPdfText = currentLanguage === 'lv'
        ? 'Atvērt PDF'
        : currentLanguage === 'en'
            ? 'Open PDF'
            : 'Malfermi PDF';

    return (
        <div className="container" style={{ maxWidth: '1000px' }}>
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
                📖 {title}
            </h1>

            <button
                onClick={() => navigate('/')}
                className="sign-button"
                style={{ marginBottom: '20px' }}
            >
                ← {backText}
            </button>

            {/* ✅ PDF iegults */}
            <iframe
                src={pdfUrl}
                style={{
                    width: '100%',
                    height: '80vh',
                    border: '1px solid #30363d',
                    borderRadius: '8px',
                    background: '#0d1117'
                }}
                title={title}
            />

            {/* ✅ PDF atvēršanas poga */}
            <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="sign-button"
                style={{
                    display: 'block',
                    textAlign: 'center',
                    textDecoration: 'none',
                    marginTop: '12px',
                    background: 'linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)'
                }}
            >
                📥 {openPdfText}
            </a>
        </div>
    );
}

export default GuidePage;
