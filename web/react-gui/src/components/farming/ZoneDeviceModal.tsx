import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { devicesAPI, irrigationZonesAPI } from '../../services/api';
import type { Device, DeviceCatalogItem, DeviceType } from '../../types/farming';
import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';

interface ZoneDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  zoneId: number;
  zoneName: string;
  availableDevices: Device[];
}

type DeviceTab = 'assign' | 'register';

export const ZoneDeviceModal: React.FC<ZoneDeviceModalProps> = ({
  isOpen,
  onClose,
  onChanged,
  zoneId,
  zoneName,
  availableDevices,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [tab, setTab] = useState<DeviceTab>('assign');
  const [selectedDeveui, setSelectedDeveui] = useState('');
  const [catalog, setCatalog] = useState<DeviceCatalogItem[]>([]);
  const [selectedType, setSelectedType] = useState<DeviceType>('KIWI_SENSOR');
  const [name, setName] = useState('');
  const [deveui, setDeveui] = useState('');
  const [appkey, setAppkey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    devicesAPI.getCatalog()
      .then((data) => {
        setCatalog(data);
        if (data.length > 0) setSelectedType(data[0].id);
      })
      .catch((err) => console.error('Failed to load catalog:', err));
  }, [isOpen]);

  const changeTab = (nextTab: DeviceTab) => {
    setTab(nextTab);
    setError('');
  };

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!selectedDeveui) {
      setError(t('assignModal.pleaseSelect'));
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.assignDevice(zoneId, selectedDeveui);
      setSelectedDeveui('');
      onChanged();
      onClose();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setError(t('zoneDeviceModal.assignConflict', {
          zoneName: err.response.data?.current_zone_name ?? '',
        }));
        // The device moved under us; refresh the caller's lists so the picker
        // stops offering it.
        onChanged();
      } else {
        setError(err?.response?.data?.message || t('assignModal.failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^[0-9A-Fa-f]{16}$/.test(deveui)) {
      setError(t('addModal.deveuiInvalid'));
      return;
    }
    if (appkey && !/^[0-9A-Fa-f]{32}$/.test(appkey)) {
      setError(t('addModal.appkeyInvalid', 'AppKey must be exactly 32 hex characters'));
      return;
    }

    setLoading(true);
    try {
      const currentCatalog = catalog.length > 0 ? catalog : await devicesAPI.getCatalog();
      const typeId = currentCatalog[0]?.id ?? selectedType;
      await devicesAPI.add({
        deveui,
        name,
        type_id: typeId,
        appkey: appkey || undefined,
        zone_id: zoneId,
      });
      setName('');
      setDeveui('');
      setAppkey('');
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || t('addModal.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={t('zoneDeviceModal.title', { zoneName })}
      onClose={onClose}
    >
      <div role="tablist" aria-label={t('zoneDeviceModal.title', { zoneName })} className="mb-6 grid grid-cols-2 gap-2">
        {(['assign', 'register'] as const).map((value) => {
          const isActive = tab === value;
          return (
            <Button
              key={value}
              role="tab"
              aria-selected={isActive}
              variant={isActive ? 'primary' : 'secondary'}
              onClick={() => changeTab(value)}
            >
              {t(value === 'assign' ? 'zoneDeviceModal.tabAssign' : 'zoneDeviceModal.tabRegister')}
            </Button>
          );
        })}
      </div>

      {error && (
        <div className="mb-4 bg-[var(--error-bg)] border border-[var(--error-text)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      {tab === 'assign' ? (
        availableDevices.length === 0 ? (
          <div className="bg-[var(--warn-bg)] border border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg">
            <p className="font-bold mb-1">{t('assignModal.noDevicesTitle')}</p>
            <p className="text-sm">{t('assignModal.noDevicesSubtitle')}</p>
          </div>
        ) : (
          <form onSubmit={handleAssign} className="space-y-6">
            <FormField id="device" label={t('assignModal.selectDevice')}>
              <select
                id="device"
                value={selectedDeveui}
                onChange={(e) => setSelectedDeveui(e.target.value)}
                required
                className={INPUT_CLASS}
              >
                <option value="">{t('assignModal.selectPlaceholder')}</option>
                {availableDevices.map((device) => (
                  <option key={device.deveui} value={device.deveui}>
                    {device.name} ({device.type_id})
                  </option>
                ))}
              </select>
            </FormField>
            <div className="flex gap-4 pt-4">
              <Button variant="secondary" onClick={onClose} className="flex-1 text-lg py-4">
                {tc('cancel')}
              </Button>
              <Button type="submit" disabled={loading} className="flex-1 text-lg py-4 shadow-lg">
                {loading ? t('assignModal.assigning') : t('assignModal.submit')}
              </Button>
            </div>
          </form>
        )
      ) : (
        <form onSubmit={handleRegister} className="space-y-6">
          <p className="rounded-lg bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
            {t('zoneDeviceModal.registerZoneNotice', { zoneName })}
          </p>
          <FormField id="zone-device-type" label={t('addModal.deviceType')}>
            <select
              id="zone-device-type"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as DeviceType)}
              className={INPUT_CLASS}
            >
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </FormField>
          <FormField id="zone-device-name" label={t('addModal.deviceName')}>
            <input
              id="zone-device-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder={t('addModal.deviceNamePlaceholder')}
              className={INPUT_CLASS}
            />
          </FormField>
          <FormField id="zone-device-deveui" label={t('addModal.deveui')} hint={t('addModal.deveuiHint')}>
            <input
              id="zone-device-deveui"
              type="text"
              value={deveui}
              onChange={(e) => setDeveui(e.target.value.toUpperCase())}
              required
              maxLength={16}
              placeholder={t('addModal.deveuiPlaceholder')}
              className={`${INPUT_CLASS} font-mono`}
            />
          </FormField>
          <FormField
            id="zone-device-appkey"
            label={t('addModal.appkey', 'AppKey')}
            hint={t('addModal.appkeyHint', '32 hex characters printed on the device label')}
          >
            <input
              id="zone-device-appkey"
              type="text"
              value={appkey}
              onChange={(e) => setAppkey(e.target.value.toUpperCase())}
              maxLength={32}
              placeholder={t('addModal.appkeyPlaceholder', 'AABBCCDDEEFF00112233445566778899')}
              className={`${INPUT_CLASS} font-mono`}
            />
          </FormField>
          <div className="flex gap-4 pt-4">
            <Button variant="secondary" onClick={onClose} className="flex-1 text-lg py-4">
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={loading} className="flex-1 text-lg py-4 shadow-lg">
              {loading ? t('zoneDeviceModal.registering') : t('zoneDeviceModal.registerSubmit')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};
