import React from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../../AppHeader';

interface HistoryMobileHeaderProps {
  onLogout: () => void;
  showAdmin?: boolean;
}

export const HistoryMobileHeader: React.FC<HistoryMobileHeaderProps> = ({
  onLogout,
  showAdmin = false,
}) => {
  const { t } = useTranslation('history');
  return <div className="lg:hidden">
    <AppHeader title={t('history.shell.title')} activeTab="data" username={null} onLogout={onLogout} showAdmin={showAdmin} />
  </div>;
};
