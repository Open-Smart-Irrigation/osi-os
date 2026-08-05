import React, { useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';
import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';

interface CreateZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onZoneCreated: () => void;
}

export const CreateZoneModal: React.FC<CreateZoneModalProps> = ({
  isOpen,
  onClose,
  onZoneCreated,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError(t('createZoneModal.zoneNameRequired'));
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.create({ name: name.trim() });
      setName('');
      onZoneCreated();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || t('createZoneModal.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t('createZoneModal.title')} onClose={onClose}>
      {error && (
        <div className="mb-4 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField id="zone-name" label={t('createZoneModal.zoneName')}>
          <input
            id="zone-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={t('createZoneModal.zoneNamePlaceholder')}
            className={INPUT_CLASS}
          />
        </FormField>

        <div className="flex gap-4 pt-4">
          <Button variant="secondary" onClick={onClose} className="flex-1 text-lg py-4">
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={loading} className="flex-1 text-lg py-4 shadow-lg">
            {loading ? t('createZoneModal.creating') : t('createZoneModal.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
