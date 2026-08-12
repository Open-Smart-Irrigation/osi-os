import React, { useEffect, useState } from 'react';
import type { DeviceCatalogItem, DeviceType, StregaGeneration } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';
import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeviceAdded: () => void;
}

export const AddDeviceModal: React.FC<AddDeviceModalProps> = ({
  isOpen,
  onClose,
  onDeviceAdded,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [catalog, setCatalog] = useState<DeviceCatalogItem[]>([]);
  const [selectedType, setSelectedType] = useState<DeviceType>('KIWI_SENSOR');
  const [name, setName] = useState('');
  const [deveui, setDeveui] = useState('');
  const [appkey, setAppkey] = useState('');
  const [stregaGeneration, setStregaGeneration] = useState<StregaGeneration>('GEN1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setName('');
      setDeveui('');
      setAppkey('');
      setStregaGeneration('GEN1');
      // Reset unconditionally here rather than relying on the catalog fetch: that fetch only
      // sets selectedType inside `if (data.length > 0)` and its catch merely console.errors,
      // so a failed or empty catalog fetch used to leave the previous session's selectedType
      // (e.g. a stale STREGA_VALVE) selected on reopen instead of the form's declared default.
      // fcf70de4 inlined the fetch and dropped this reset; keeping it, or the bug returns.
      setSelectedType('KIWI_SENSOR');
      setError('');
      devicesAPI.getCatalog()
        .then((data) => {
          setCatalog(data);
          if (data.length > 0) setSelectedType(data[0].id);
        })
        .catch((err) => console.error('Failed to load catalog:', err));
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
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
      await devicesAPI.add({
        deveui,
        name,
        // Must be the user's selection. fcf70de4 shipped
        // `currentCatalog[0]?.id ?? selectedType`, which ignores the device-type dropdown
        // entirely whenever the catalog is non-empty -- i.e. always -- and registers every
        // device as the FIRST catalog entry. That bug is still live on
        // feat/journal-cloud-primary and AgroLink; this branch keeps the pre-cherry-pick
        // behaviour, which the 'includes strega_generation when submitting a STREGA valve'
        // test pins.
        type_id: selectedType,
        appkey: appkey || undefined,
        ...(selectedType === 'STREGA_VALVE' ? { strega_generation: stregaGeneration } : {}),
      });
      setName('');
      setDeveui('');
      setAppkey('');
      setStregaGeneration('GEN1');
      onDeviceAdded();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || t('addModal.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t('addModal.title')} onClose={onClose}>
      {error && (
        <div className="mb-4 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField id="device-type" label={t('addModal.deviceType')}>
          <select
            id="device-type"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as DeviceType)}
            className={INPUT_CLASS}
          >
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </FormField>

        {/* Strega generation (valves only). Re-inserted on top of fcf70de4's ui-core
            refactor: that commit predates valve generation support and dropped this field. */}
        {selectedType === 'STREGA_VALVE' && (
          <FormField id="stregaGeneration" label={t('addModal.generation')}>
            <select
              id="stregaGeneration"
              value={stregaGeneration}
              onChange={(e) => setStregaGeneration(e.target.value as StregaGeneration)}
              className={INPUT_CLASS}
            >
              <option value="GEN1">{t('addModal.generationGen1')}</option>
              <option value="GEN2">{t('addModal.generationGen2')}</option>
            </select>
          </FormField>
        )}

        <FormField id="name" label={t('addModal.deviceName')}>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={t('addModal.deviceNamePlaceholder')}
            className={INPUT_CLASS}
          />
        </FormField>

        <FormField
          id="deveui"
          label={t('addModal.deveui')}
          hint={t('addModal.deveuiHint')}
        >
          <input
            id="deveui"
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
          id="appkey"
          label={t('addModal.appkey', 'AppKey')}
          hint={t('addModal.appkeyHint', '32 hex characters printed on the device label')}
        >
          <input
            id="appkey"
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
            {loading ? t('addModal.adding') : t('addModal.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
