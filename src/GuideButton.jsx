import React from 'react';
import { useLanguage } from './LanguageContext';

function GuideButton() {
    const { currentLanguage, t } = useLanguage();

    const pdfUrl = currentLanguage === 'en'
        ? '/docs/User Guide (EN).pdf'
        : '/docs/Lietotāja rokasgrāmata (LV).pdf';

    return (
        <div className="guide-container">
            <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="guide-button"
            >
                📖 {t('read-guide')}
            </a>
        </div>
    );
}

export default GuideButton;
