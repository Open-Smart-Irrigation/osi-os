import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { AppHeader } from './AppHeader';

interface DashboardHeaderProps {
  username: string | null;
  onAddZone: () => void;
  onAddDevice: () => void;
  onLogout: () => void;
}

/**
 * Zones page chrome. Delegates all shared structure (crown, glass header,
 * tabs) to AppHeader and supplies the dashboard's own Add menu as the page
 * action. Add carries the journal entry point (Log activity → /journal) per
 * the field-journal spec §6.1(c).
 */
export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  username,
  onAddZone,
  onAddDevice,
  onLogout,
}) => {
  const { t } = useTranslation('dashboard');
  const navigate = useNavigate();

  return (
    <AppHeader
      title={t('title')}
      activeTab="zones"
      username={username}
      onLogout={onLogout}
      actions={
        <HeaderMenu
          label={t('add')}
          className="w-[calc(50%-4px)] sm:w-auto"
          triggerClassName="btn-liquid text-[var(--text)] text-lg px-6 py-3"
          align="left"
          items={[
            { key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone },
            { key: 'device', label: t('addMenu.device'), onSelect: onAddDevice },
            { key: 'activity', label: t('addMenu.activity'), onSelect: () => navigate('/journal') },
          ]}
        />
      }
    />
  );
};
