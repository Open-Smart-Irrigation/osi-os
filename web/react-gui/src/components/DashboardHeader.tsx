import React from 'react';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { AppHeader, HEADER_BUTTON } from './AppHeader';
import { useGatewayModules } from '../hooks/useGatewayModules';

interface DashboardHeaderProps {
  username: string | null;
  onAddZone: () => void;
  onAddDevice: () => void;
  onLogout: () => void;
  canWrite?: boolean;
  showAdmin?: boolean;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  username,
  onAddZone,
  onAddDevice,
  onLogout,
  canWrite = true,
  showAdmin = false,
}) => {
  const { t } = useTranslation(['dashboard', 'settings']);
  const modules = useGatewayModules();

  return <AppHeader title={t('title')} activeTab="zones" username={username} onLogout={onLogout} showAdmin={showAdmin}
    actions={canWrite ? <HeaderMenu label={t('add')} align="left" triggerClassName={HEADER_BUTTON} items={[
      { key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone },
      { key: 'device', label: t('addMenu.device'), onSelect: onAddDevice },
      ...(modules?.journal ? [{ key: 'activity', label: t('addMenu.activity'), to: '/journal?capture=1' }] : []),
    ]} /> : undefined} />;
};
